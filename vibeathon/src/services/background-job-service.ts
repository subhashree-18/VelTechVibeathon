import { prisma } from '@/lib/prisma'
import { JobType, JobStatus } from '@prisma/client'

export interface JobPayload {
  [key: string]: any
}

export class BackgroundJobService {
  /**
   * Schedule a background job
   */
  static async scheduleJob(
    type: JobType,
    payload: JobPayload,
    scheduledFor: Date = new Date(),
    maxAttempts: number = 3
  ) {
    return await prisma.backgroundJob.create({
      data: {
        type,
        payload,
        scheduledFor,
        maxAttempts,
        status: JobStatus.PENDING
      }
    })
  }

  /**
   * Process pending jobs
   */
  static async processPendingJobs() {
    const pendingJobs = await prisma.backgroundJob.findMany({
      where: {
        status: JobStatus.PENDING,
        scheduledFor: { lte: new Date() }
      },
      orderBy: { scheduledFor: 'asc' },
      take: 10 // Process 10 jobs at a time
    })

    for (const job of pendingJobs) {
      await this.processJob(job.id)
    }
  }

  /**
   * Process a specific job
   */
  static async processJob(jobId: string) {
    const job = await prisma.backgroundJob.findUnique({
      where: { id: jobId }
    })

    if (!job) return

    try {
      // Mark as processing
      await prisma.backgroundJob.update({
        where: { id: jobId },
        data: { status: JobStatus.PROCESSING }
      })

      // Process based on job type
      switch (job.type) {
        case JobType.AUTO_RESOURCE_RELEASE:
          await this.processAutoResourceRelease(job.payload)
          break

        case JobType.CLEANUP_STALE_ALLOCATIONS:
          await this.processCleanupStaleAllocations(job.payload)
          break

        case JobType.REFRESH_OCCUPANCY_SNAPSHOTS:
          await this.processRefreshOccupancySnapshots(job.payload)
          break

        case JobType.NOTIFICATION_RETRY:
          await this.processNotificationRetry(job.payload)
          break

        case JobType.EVENT_REMINDER:
          await this.processEventReminder(job.payload)
          break

        default:
          throw new Error(`Unknown job type: ${job.type}`)
      }

      // Mark as completed
      await prisma.backgroundJob.update({
        where: { id: jobId },
        data: {
          status: JobStatus.COMPLETED,
          completedAt: new Date(),
          error: null
        }
      })

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error'
      
      await prisma.backgroundJob.update({
        where: { id: jobId },
        data: {
          attempts: { increment: 1 },
          error: errorMessage,
          status: job.attempts + 1 >= job.maxAttempts ? JobStatus.FAILED : JobStatus.RETRYING
        }
      })

      // Reschedule if not exceeded max attempts
      if (job.attempts + 1 < job.maxAttempts) {
        const retryDelay = Math.min(1000 * Math.pow(2, job.attempts), 300000) // Exponential backoff, max 5 min
        const nextAttempt = new Date(Date.now() + retryDelay)
        
        await prisma.backgroundJob.update({
          where: { id: jobId },
          data: {
            scheduledFor: nextAttempt,
            status: JobStatus.PENDING
          }
        })
      }
    }
  }

  /**
   * Auto release resources after event completion
   */
  private static async processAutoResourceRelease(payload: JobPayload) {
    const { eventId } = payload

    await prisma.$transaction(async (tx) => {
      const event = await tx.event.findUnique({
        where: { id: eventId },
        include: {
          venueBookings: true,
          resourceBookings: true
        }
      })

      if (!event) return

      // Only release if event is completed or ended
      const now = new Date()
      if (event.scheduleEnd > now && event.status !== 'COMPLETED') {
        return
      }

      // Cancel all bookings
      await tx.venueBooking.updateMany({
        where: { eventId },
        data: { status: 'cancelled' }
      })

      await tx.resourceBooking.updateMany({
        where: { eventId },
        data: { status: 'cancelled' }
      })

      // Update resource availability
      for (const booking of event.resourceBookings) {
        await tx.resource.update({
          where: { id: booking.resourceId },
          data: {
            availableQuantity: { increment: booking.quantity }
          }
        })
      }

      // Log the release
      await tx.auditLog.create({
        data: {
          eventId,
          userId: 'system',
          action: 'auto_release',
          entityType: 'event',
          entityId: eventId,
          newData: { message: 'Resources automatically released after event completion' },
          timestamp: new Date()
        }
      })
    })
  }

  /**
   * Clean up stale allocations
   */
  private static async processCleanupStaleAllocations(payload: JobPayload) {
    const cutoffDate = new Date(Date.now() - 24 * 60 * 60 * 1000) // 24 hours ago

    await prisma.$transaction(async (tx) => {
      // Find and clean up provisional bookings that are too old
      const staleVenueBookings = await tx.venueBooking.findMany({
        where: {
          status: 'provisional',
          createdAt: { lt: cutoffDate }
        }
      })

      const staleResourceBookings = await tx.resourceBooking.findMany({
        where: {
          status: 'provisional',
          createdAt: { lt: cutoffDate }
        }
      })

      // Remove stale venue bookings
      await tx.venueBooking.deleteMany({
        where: {
          id: { in: staleVenueBookings.map(b => b.id) }
        }
      })

      // Remove stale resource bookings and restore quantities
      for (const booking of staleResourceBookings) {
        await tx.resource.update({
          where: { id: booking.resourceId },
          data: {
            availableQuantity: { increment: booking.quantity }
          }
        })
      }

      await tx.resourceBooking.deleteMany({
        where: {
          id: { in: staleResourceBookings.map(b => b.id) }
        }
      })

      // Log cleanup
      if (staleVenueBookings.length > 0 || staleResourceBookings.length > 0) {
        await tx.auditLog.create({
          data: {
            userId: 'system',
            action: 'cleanup_stale',
            entityType: 'booking',
            entityId: 'bulk',
            newData: {
              venueBookingsRemoved: staleVenueBookings.length,
              resourceBookingsRemoved: staleResourceBookings.length
            },
            timestamp: new Date()
          }
        })
      }
    })
  }

  /**
   * Refresh occupancy snapshots for analytics
   */
  private static async processRefreshOccupancySnapshots(payload: JobPayload) {
    const { date } = payload
    const targetDate = date ? new Date(date) : new Date()

    await prisma.$transaction(async (tx) => {
      // Get all venues
      const venues = await tx.venue.findMany({
        where: { isActive: true }
      })

      for (const venue of venues) {
        // Generate time slots for the day (e.g., hourly slots)
        const timeSlots = this.generateTimeSlots()

        for (const timeSlot of timeSlots) {
          const [startHour, endHour] = timeSlot.split('-').map(t => parseInt(t.substring(0, 2)))
          
          const slotStart = new Date(targetDate)
          slotStart.setHours(startHour, 0, 0, 0)
          
          const slotEnd = new Date(targetDate)
          slotEnd.setHours(endHour, 0, 0, 0)

          // Check if venue is booked during this slot
          const booking = await tx.venueBooking.findFirst({
            where: {
              venueId: venue.id,
              status: 'confirmed',
              startTime: { lt: slotEnd },
              endTime: { gt: slotStart }
            },
            include: { event: true }
          })

          let occupancyStatus = 'free'
          let eventId = null
          let utilizationPercent = 0

          if (booking) {
            occupancyStatus = 'occupied'
            eventId = booking.eventId
            utilizationPercent = 100
          }

          // Check for maintenance
          const maintenance = await tx.maintenanceWindow.findFirst({
            where: {
              venueId: venue.id,
              startTime: { lt: slotEnd },
              endTime: { gt: slotStart }
            }
          })

          if (maintenance) {
            occupancyStatus = 'maintenance'
            utilizationPercent = 0
          }

          // Upsert occupancy snapshot
          await tx.occupancySnapshot.upsert({
            where: {
              venueId_date_timeSlot: {
                venueId: venue.id,
                date: targetDate,
                timeSlot
              }
            },
            update: {
              occupancyStatus,
              eventId,
              utilizationPercent
            },
            create: {
              venueId: venue.id,
              date: targetDate,
              timeSlot,
              occupancyStatus,
              eventId,
              utilizationPercent
            }
          })
        }
      }
    })
  }

  /**
   * Generate hourly time slots for a day
   */
  private static generateTimeSlots(): string[] {
    const slots: string[] = []
    for (let hour = 0; hour < 24; hour++) {
      const start = hour.toString().padStart(2, '0') + '00'
      const end = ((hour + 1) % 24).toString().padStart(2, '0') + '00'
      slots.push(`${start}-${end}`)
    }
    return slots
  }

  /**
   * Retry failed notifications
   */
  private static async processNotificationRetry(payload: JobPayload) {
    // Implementation for notification retry logic
    // This could involve re-sending emails, SMS, etc.
    console.log('Processing notification retry:', payload)
  }

  /**
   * Send event reminders
   */
  private static async processEventReminder(payload: JobPayload) {
    const { eventId, reminderType } = payload

    const event = await prisma.event.findUnique({
      where: { id: eventId },
      include: { coordinator: true }
    })

    if (!event) return

    // Create reminder notification
    await prisma.notification.create({
      data: {
        userId: event.coordinatorId,
        eventId: event.id,
        type: 'EVENT_REMINDER',
        title: `Event Reminder: ${reminderType}`,
        message: `Your event "${event.title}" ${reminderType === 'start' ? 'starts' : 'ends'} soon`,
        data: { reminderType }
      }
    })
  }

  /**
   * Schedule automatic jobs for an event
   */
  static async scheduleEventJobs(eventId: string, scheduleStart: Date, scheduleEnd: Date) {
    const jobs = []

    // Schedule reminder 1 hour before start
    const reminderTime = new Date(scheduleStart.getTime() - 60 * 60 * 1000)
    if (reminderTime > new Date()) {
      jobs.push(
        this.scheduleJob(JobType.EVENT_REMINDER, { eventId, reminderType: 'start' }, reminderTime)
      )
    }

    // Schedule auto-release 1 hour after end
    const releaseTime = new Date(scheduleEnd.getTime() + 60 * 60 * 1000)
    jobs.push(
      this.scheduleJob(JobType.AUTO_RESOURCE_RELEASE, { eventId }, releaseTime)
    )

    await Promise.all(jobs)
  }

  /**
   * Get job statistics
   */
  static async getJobStats() {
    const stats = await prisma.backgroundJob.groupBy({
      by: ['status', 'type'],
      _count: true
    })

    return stats.reduce((acc, stat) => {
      if (!acc[stat.type]) acc[stat.type] = {}
      acc[stat.type][stat.status] = stat._count
      return acc
    }, {} as Record<string, Record<string, number>>)
  }
}