import { prisma } from '@/lib/prisma'
import { NotificationType } from '@prisma/client'

export interface CreateNotificationData {
  userId: string
  eventId?: string
  type: NotificationType | string
  title: string
  message: string
  data?: any
}

export class NotificationService {
  /**
   * Create a new notification
   */
  static async createNotification(tx: any, data: CreateNotificationData) {
    return await tx.notification.create({
      data: {
        userId: data.userId,
        eventId: data.eventId,
        type: data.type,
        title: data.title,
        message: data.message,
        data: data.data,
        isRead: false,
        createdAt: new Date()
      }
    })
  }

  /**
   * Create notifications for multiple users
   */
  static async createBulkNotifications(tx: any, userIds: string[], notificationData: Omit<CreateNotificationData, 'userId'>) {
    const notifications = userIds.map(userId => ({
      userId,
      eventId: notificationData.eventId,
      type: notificationData.type,
      title: notificationData.title,
      message: notificationData.message,
      data: notificationData.data,
      isRead: false,
      createdAt: new Date()
    }))

    return await tx.notification.createMany({
      data: notifications
    })
  }

  /**
   * Get notifications for a user
   */
  static async getUserNotifications(userId: string, options: {
    unreadOnly?: boolean
    limit?: number
    offset?: number
  } = {}) {
    const { unreadOnly = false, limit = 50, offset = 0 } = options

    return await prisma.notification.findMany({
      where: {
        userId,
        ...(unreadOnly && { isRead: false })
      },
      include: {
        event: {
          select: {
            title: true,
            status: true,
            approvalStage: true
          }
        }
      },
      orderBy: {
        createdAt: 'desc'
      },
      take: limit,
      skip: offset
    })
  }

  /**
   * Mark notification as read
   */
  static async markAsRead(notificationId: string, userId: string) {
    return await prisma.notification.updateMany({
      where: {
        id: notificationId,
        userId
      },
      data: {
        isRead: true
      }
    })
  }

  /**
   * Mark all notifications as read for a user
   */
  static async markAllAsRead(userId: string) {
    return await prisma.notification.updateMany({
      where: {
        userId,
        isRead: false
      },
      data: {
        isRead: true
      }
    })
  }

  /**
   * Get unread notification count
   */
  static async getUnreadCount(userId: string): Promise<number> {
    return await prisma.notification.count({
      where: {
        userId,
        isRead: false
      }
    })
  }

  /**
   * Send event lifecycle notifications
   */
  static async sendEventNotifications(eventId: string, type: NotificationType, customMessage?: string) {
    const event = await prisma.event.findUnique({
      where: { id: eventId },
      include: {
        coordinator: true,
        school: true,
        department: true
      }
    })

    if (!event) return

    await prisma.$transaction(async (tx) => {
      let recipients: string[] = []
      let title = ''
      let message = customMessage || ''

      switch (type) {
        case NotificationType.EVENT_SUBMITTED:
          // Notify relevant approvers based on current stage
          if (event.approvalStage === 'SUBMITTED') {
            const hods = await tx.user.findMany({
              where: { role: 'HOD', departmentId: event.departmentId, isActive: true },
              select: { id: true }
            })
            recipients = hods.map(h => h.id)
            title = 'Event Awaiting Approval'
            message = `Event "${event.title}" requires HOD approval`
          }
          break

        case NotificationType.RESOURCE_CONFLICT:
          // Notify coordinator and relevant admins
          recipients = [event.coordinatorId]
          const admins = await tx.user.findMany({
            where: { role: 'ADMIN_ITC', isActive: true },
            select: { id: true }
          })
          recipients.push(...admins.map(a => a.id))
          title = 'Resource Conflict Detected'
          message = message || `Resource conflict detected for event "${event.title}"`
          break

        case NotificationType.SCHEDULE_CHANGE:
          // Notify coordinator and all approvers in the chain
          recipients = [event.coordinatorId]
          title = 'Event Schedule Changed'
          message = message || `Schedule updated for event "${event.title}"`
          break

        default:
          // Default to notifying coordinator
          recipients = [event.coordinatorId]
      }

      // Create notifications
      if (recipients.length > 0) {
        await this.createBulkNotifications(tx, recipients, {
          eventId: event.id,
          type,
          title,
          message,
          data: {
            eventTitle: event.title,
            coordinatorName: `${event.coordinator.firstName} ${event.coordinator.lastName}`,
            department: event.department.name,
            school: event.school.name
          }
        })
      }
    })
  }

  /**
   * Send resource maintenance notifications
   */
  static async sendMaintenanceNotifications(resourceId?: string, venueId?: string, message?: string) {
    await prisma.$transaction(async (tx) => {
      // Find affected events
      let affectedEvents: any[] = []

      if (resourceId) {
        affectedEvents = await tx.event.findMany({
          where: {
            resourceBookings: {
              some: { resourceId }
            },
            status: { in: ['APPROVED', 'RUNNING'] }
          },
          include: { coordinator: true }
        })
      }

      if (venueId) {
        affectedEvents = await tx.event.findMany({
          where: {
            venueBookings: {
              some: { venueId }
            },
            status: { in: ['APPROVED', 'RUNNING'] }
          },
          include: { coordinator: true }
        })
      }

      // Notify coordinators of affected events
      for (const event of affectedEvents) {
        await this.createNotification(tx, {
          userId: event.coordinatorId,
          eventId: event.id,
          type: NotificationType.MAINTENANCE_ALERT,
          title: 'Maintenance Alert',
          message: message || `Maintenance scheduled for resources used in "${event.title}"`,
          data: {
            eventTitle: event.title,
            resourceId,
            venueId
          }
        })
      }

      // Also notify admins
      const admins = await tx.user.findMany({
        where: { role: 'ADMIN_ITC', isActive: true },
        select: { id: true }
      })

      for (const admin of admins) {
        await this.createNotification(tx, {
          userId: admin.id,
          type: NotificationType.MAINTENANCE_ALERT,
          title: 'Maintenance Scheduled',
          message: message || 'Maintenance window has been scheduled',
          data: { resourceId, venueId }
        })
      }
    })
  }

  /**
   * Clean up old notifications
   */
  static async cleanupOldNotifications(daysOld: number = 30) {
    const cutoffDate = new Date()
    cutoffDate.setDate(cutoffDate.getDate() - daysOld)

    return await prisma.notification.deleteMany({
      where: {
        createdAt: { lt: cutoffDate },
        isRead: true
      }
    })
  }
}