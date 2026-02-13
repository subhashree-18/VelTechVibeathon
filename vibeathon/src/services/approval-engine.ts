import { prisma } from '@/lib/prisma'
import { ApprovalStage, ApprovalAction, EventStatus, Role } from '@prisma/client'
import { NotificationService } from './notification-service'
import { AllocationEngine } from './allocation-engine'

export interface ApprovalContext {
  approverId: string
  action: ApprovalAction
  comments?: string
  eventId: string
}

export class ApprovalEngine {
  /**
   * Process an approval action
   */
  static async processApproval({
    approverId,
    action,
    comments,
    eventId
  }: ApprovalContext): Promise<{ success: boolean; nextStage?: ApprovalStage; error?: string }> {
    
    return await prisma.$transaction(async (tx) => {
      // Get current event state
      const event = await tx.event.findUnique({
        where: { id: eventId },
        include: {
          coordinator: true,
          school: true,
          department: true
        }
      })

      if (!event) {
        throw new Error('Event not found')
      }

      // Get approver details
      const approver = await tx.user.findUnique({
        where: { id: approverId }
      })

      if (!approver) {
        throw new Error('Approver not found')
      }

      // Validate approval permissions
      const canApprove = this.validateApprovalPermission(
        approver.role,
        event.approvalStage,
        approver.schoolId,
        approver.departmentId,
        event.schoolId,
        event.departmentId
      )

      if (!canApprove) {
        return {
          success: false,
          error: 'Insufficient permissions to approve this event'
        }
      }

      // Process based on action
      let nextStage: ApprovalStage
      let eventStatus: EventStatus = event.status

      switch (action) {
        case ApprovalAction.APPROVED:
          nextStage = this.getNextApprovalStage(event.approvalStage)
          if (nextStage === ApprovalStage.APPROVED) {
            // Final approval - trigger allocation
            const allocationResult = await AllocationEngine.allocateEvent(eventId)
            if (allocationResult.success) {
              eventStatus = EventStatus.APPROVED
            } else {
              // Allocation failed - back to previous stage with explanation
              nextStage = event.approvalStage
              eventStatus = EventStatus.SUBMITTED
              comments = `Allocation failed: ${allocationResult.explanation}`
              action = ApprovalAction.MODIFICATION_REQUIRED
            }
          }
          break

        case ApprovalAction.REJECTED:
          nextStage = ApprovalStage.REJECTED
          eventStatus = EventStatus.REJECTED
          break

        case ApprovalAction.MODIFICATION_REQUIRED:
          nextStage = ApprovalStage.MODIFICATION_REQUIRED
          eventStatus = EventStatus.SUBMITTED
          break

        default:
          return { success: false, error: 'Invalid approval action' }
      }

      // Update event
      await tx.event.update({
        where: { id: eventId },
        data: {
          approvalStage: nextStage,
          status: eventStatus,
          rejectionReason: action === ApprovalAction.REJECTED ? comments : null,
          updatedAt: new Date()
        }
      })

      // Record approval step
      await tx.approvalStep.create({
        data: {
          eventId,
          approverId,
          stage: nextStage,
          action,
          comments,
          timestamp: new Date()
        }
      })

      // Send notifications
      await this.sendApprovalNotifications(tx, event, action, nextStage, approver, comments)

      return {
        success: true,
        nextStage
      }
    })
  }

  /**
   * Validate if user can approve at current stage
   */
  private static validateApprovalPermission(
    approverRole: Role,
    currentStage: ApprovalStage,
    approverSchoolId: string | null,
    approverDepartmentId: string | null,
    eventSchoolId: string,
    eventDepartmentId: string
  ): boolean {
    switch (currentStage) {
      case ApprovalStage.SUBMITTED:
        return approverRole === Role.HOD && 
               approverDepartmentId === eventDepartmentId

      case ApprovalStage.HOD_APPROVED:
        return approverRole === Role.DEAN && 
               approverSchoolId === eventSchoolId

      case ApprovalStage.DEAN_APPROVED:
        return approverRole === Role.INSTITUTIONAL_HEAD

      default:
        return false
    }
  }

  /**
   * Get next stage in approval workflow
   */
  private static getNextApprovalStage(currentStage: ApprovalStage): ApprovalStage {
    const workflow: Record<ApprovalStage, ApprovalStage> = {
      [ApprovalStage.DRAFT]: ApprovalStage.SUBMITTED,
      [ApprovalStage.SUBMITTED]: ApprovalStage.HOD_APPROVED,
      [ApprovalStage.HOD_APPROVED]: ApprovalStage.DEAN_APPROVED,
      [ApprovalStage.DEAN_APPROVED]: ApprovalStage.HEAD_APPROVED,
      [ApprovalStage.HEAD_APPROVED]: ApprovalStage.APPROVED,
      [ApprovalStage.APPROVED]: ApprovalStage.APPROVED, // Terminal state
      [ApprovalStage.REJECTED]: ApprovalStage.REJECTED, // Terminal state
      [ApprovalStage.MODIFICATION_REQUIRED]: ApprovalStage.SUBMITTED, // Resets workflow
    }

    return workflow[currentStage]
  }

  /**
   * Get the required approver role for a stage
   */
  static getRequiredApproverRole(stage: ApprovalStage): Role | null {
    const stageToRole: Record<ApprovalStage, Role | null> = {
      [ApprovalStage.SUBMITTED]: Role.HOD,
      [ApprovalStage.HOD_APPROVED]: Role.DEAN,
      [ApprovalStage.DEAN_APPROVED]: Role.INSTITUTIONAL_HEAD,
      [ApprovalStage.HEAD_APPROVED]: null, // System allocation
      [ApprovalStage.APPROVED]: null,
      [ApprovalStage.REJECTED]: null,
      [ApprovalStage.MODIFICATION_REQUIRED]: null,
      [ApprovalStage.DRAFT]: null,
    }

    return stageToRole[stage]
  }

  /**
   * Send notifications based on approval action
   */
  private static async sendApprovalNotifications(
    tx: any,
    event: any,
    action: ApprovalAction,
    newStage: ApprovalStage,
    approver: any,
    comments?: string
  ) {
    const baseNotification = {
      eventId: event.id,
      data: {
        eventTitle: event.title,
        approverName: `${approver.firstName} ${approver.lastName}`,
        stage: newStage,
        comments
      }
    }

    switch (action) {
      case ApprovalAction.APPROVED:
        // Notify coordinator of approval
        await NotificationService.createNotification(tx, {
          ...baseNotification,
          userId: event.coordinatorId,
          type: 'EVENT_APPROVED',
          title: 'Event Approved',
          message: `Your event "${event.title}" has been approved at ${newStage} stage`
        })

        // If not final approval, notify next approver
        if (newStage !== ApprovalStage.APPROVED) {
          const nextApproverRole = this.getRequiredApproverRole(newStage)
          if (nextApproverRole) {
            const nextApprovers = await tx.user.findMany({
              where: {
                role: nextApproverRole,
                isActive: true,
                ...(nextApproverRole === Role.HOD && { departmentId: event.departmentId }),
                ...(nextApproverRole === Role.DEAN && { schoolId: event.schoolId })
              }
            })

            for (const approver of nextApprovers) {
              await NotificationService.createNotification(tx, {
                ...baseNotification,
                userId: approver.id,
                type: 'EVENT_SUBMITTED',
                title: 'Event Awaiting Approval',
                message: `Event "${event.title}" requires your approval`
              })
            }
          }
        }
        break

      case ApprovalAction.REJECTED:
        await NotificationService.createNotification(tx, {
          ...baseNotification,
          userId: event.coordinatorId,
          type: 'EVENT_REJECTED',
          title: 'Event Rejected',
          message: `Your event "${event.title}" has been rejected. Reason: ${comments}`
        })
        break

      case ApprovalAction.MODIFICATION_REQUIRED:
        await NotificationService.createNotification(tx, {
          ...baseNotification,
          userId: event.coordinatorId,
          type: 'EVENT_MODIFICATION_REQUIRED',
          title: 'Event Modification Required',
          message: `Your event "${event.title}" requires modifications. Comments: ${comments}`
        })
        break
    }
  }

  /**
   * Submit event for approval (initial submission)
   */
  static async submitEventForApproval(eventId: string, coordinatorId: string): Promise<{ success: boolean; error?: string }> {
    return await prisma.$transaction(async (tx) => {
      const event = await tx.event.findUnique({
        where: { id: eventId },
        include: {
          coordinator: true,
          department: true,
          school: true
        }
      })

      if (!event) {
        return { success: false, error: 'Event not found' }
      }

      if (event.coordinatorId !== coordinatorId) {
        return { success: false, error: 'Unauthorized' }
      }

      if (event.status !== EventStatus.DRAFT) {
        return { success: false, error: 'Event is not in draft status' }
      }

      // Update event status
      await tx.event.update({
        where: { id: eventId },
        data: {
          status: EventStatus.SUBMITTED,
          approvalStage: ApprovalStage.SUBMITTED,
          updatedAt: new Date()
        }
      })

      // Create approval step record
      await tx.approvalStep.create({
        data: {
          eventId,
          approverId: coordinatorId,
          stage: ApprovalStage.SUBMITTED,
          action: ApprovalAction.SUBMITTED,
          comments: 'Event submitted for approval',
          timestamp: new Date()
        }
      })

      // Notify HODs in the department
      const hods = await tx.user.findMany({
        where: {
          role: Role.HOD,
          departmentId: event.departmentId,
          isActive: true
        }
      })

      for (const hod of hods) {
        await NotificationService.createNotification(tx, {
          userId: hod.id,
          eventId: event.id,
          type: 'EVENT_SUBMITTED',
          title: 'New Event Awaiting Approval',
          message: `Event "${event.title}" has been submitted for approval by ${event.coordinator.firstName} ${event.coordinator.lastName}`,
          data: {
            eventTitle: event.title,
            coordinatorName: `${event.coordinator.firstName} ${event.coordinator.lastName}`,
            department: event.department.name
          }
        })
      }

      return { success: true }
    })
  }

  /**
   * Get events pending approval for a user
   */
  static async getPendingApprovals(userId: string) {
    const user = await prisma.user.findUnique({
      where: { id: userId }
    })

    if (!user) {
      throw new Error('User not found')
    }

    let whereClause: any = {
      status: EventStatus.SUBMITTED
    }

    // Filter based on role and scope
    switch (user.role) {
      case Role.HOD:
        whereClause.approvalStage = ApprovalStage.SUBMITTED
        whereClause.departmentId = user.departmentId
        break

      case Role.DEAN:
        whereClause.approvalStage = ApprovalStage.HOD_APPROVED
        whereClause.schoolId = user.schoolId
        break

      case Role.INSTITUTIONAL_HEAD:
        whereClause.approvalStage = ApprovalStage.DEAN_APPROVED
        break

      default:
        return [] // Other roles cannot approve
    }

    return await prisma.event.findMany({
      where: whereClause,
      include: {
        coordinator: {
          select: {
            firstName: true,
            lastName: true,
            email: true
          }
        },
        department: {
          select: {
            name: true,
            code: true
          }
        },
        school: {
          select: {
            name: true,
            code: true
          }
        },
        resourceRequests: {
          include: {
            resource: {
              select: {
                name: true,
                category: true,
                unit: true
              }
            }
          }
        }
      },
      orderBy: {
        createdAt: 'asc'
      }
    })
  }
}