import { prisma } from '@/lib/prisma'
import { EventStatus, ApprovalStage, ApprovalAction } from '@prisma/client'

export interface AllocationResult {
  success: boolean
  venueId?: string
  resourceAllocations?: { resourceId: string; allocatedQuantity: number }[]
  conflicts?: AllocationConflict[]
  explanation?: string
}

export interface AllocationConflict {
  type: 'venue_unavailable' | 'resource_shortage' | 'time_overlap'
  conflictingEventIds: string[]
  details: string
  suggestions?: string[]
}

export class AllocationEngine {
  /**
   * Main allocation function - called on final approval
   */
  static async allocateEvent(eventId: string): Promise<AllocationResult> {
    return await prisma.$transaction(async (tx) => {
      // Lock the event for update
      const event = await tx.event.findUnique({
        where: { id: eventId },
        include: {
          resourceRequests: {
            include: { resource: true }
          }
        }
      })

      if (!event) {
        throw new Error('Event not found')
      }

      if (event.approvalStage !== ApprovalStage.HEAD_APPROVED) {
        throw new Error('Event not ready for allocation')
      }

      try {
        // 1. Allocate venue
        const venueResult = await this.allocateVenue(tx, event)
        if (!venueResult.success) {
          return {
            success: false,
            conflicts: venueResult.conflicts,
            explanation: 'Venue allocation failed: ' + venueResult.explanation
          }
        }

        // 2. Allocate resources
        const resourceResult = await this.allocateResources(tx, event)
        if (!resourceResult.success) {
          return {
            success: false,
            conflicts: resourceResult.conflicts,
            explanation: 'Resource allocation failed: ' + resourceResult.explanation
          }
        }

        // 3. Update event status
        await tx.event.update({
          where: { id: eventId },
          data: {
            status: EventStatus.APPROVED,
            approvalStage: ApprovalStage.APPROVED,
          }
        })

        // 4. Create approval step record
        await tx.approvalStep.create({
          data: {
            eventId,
            approverId: 'system', // System allocation
            stage: ApprovalStage.APPROVED,
            action: ApprovalAction.APPROVED,
            comments: 'Automatic allocation completed successfully',
          }
        })

        return {
          success: true,
          venueId: venueResult.venueId,
          resourceAllocations: resourceResult.allocations,
          explanation: 'Event successfully allocated'
        }

      } catch (error) {
        throw error // Transaction will rollback
      }
    }, {
      isolationLevel: 'Serializable' // Highest isolation level for allocation
    })
  }

  /**
   * Venue allocation logic
   */
  private static async allocateVenue(tx: any, event: any): Promise<{
    success: boolean
    venueId?: string
    conflicts?: AllocationConflict[]
    explanation?: string
  }> {
    // Find available venues matching criteria
    const candidateVenues = await tx.venue.findMany({
      where: {
        isActive: true,
        maintenanceMode: false,
        capacity: { gte: event.participantCount },
        ...(event.venueTypePreference && {
          type: event.venueTypePreference
        })
      },
      orderBy: [
        { capacity: 'asc' }, // Minimize waste
        { name: 'asc' }
      ]
    })

    if (candidateVenues.length === 0) {
      return {
        success: false,
        explanation: `No venues found with capacity >= ${event.participantCount}`,
        conflicts: [{
          type: 'venue_unavailable',
          conflictingEventIds: [],
          details: 'No suitable venues available',
          suggestions: ['Consider reducing participant count', 'Choose different time slot']
        }]
      }
    }

    // Check for time conflicts
    for (const venue of candidateVenues) {
      const conflictingBookings = await tx.venueBooking.findMany({
        where: {
          venueId: venue.id,
          status: 'confirmed',
          AND: [
            { startTime: { lt: event.scheduleEnd } },
            { endTime: { gt: event.scheduleStart } }
          ]
        },
        include: { event: true }
      })

      if (conflictingBookings.length === 0) {
        // This venue is available - book it
        await tx.venueBooking.create({
          data: {
            venueId: venue.id,
            eventId: event.id,
            startTime: event.scheduleStart,
            endTime: event.scheduleEnd,
            status: 'confirmed'
          }
        })

        return {
          success: true,
          venueId: venue.id,
          explanation: `Allocated venue: ${venue.name}`
        }
      }
    }

    // No venue available
    const allConflicts = await Promise.all(
      candidateVenues.map(async (venue) => {
        const conflicts = await tx.venueBooking.findMany({
          where: {
            venueId: venue.id,
            status: 'confirmed',
            AND: [
              { startTime: { lt: event.scheduleEnd } },
              { endTime: { gt: event.scheduleStart } }
            ]
          },
          include: { event: { select: { id: true, title: true } } }
        })
        return conflicts.map(c => c.event.id)
      })
    )

    return {
      success: false,
      explanation: 'All suitable venues are booked during requested time',
      conflicts: [{
        type: 'venue_unavailable',
        conflictingEventIds: allConflicts.flat(),
        details: 'Time slot conflicts with existing bookings',
        suggestions: [
          'Choose different time slot',
          'Consider smaller venue capacity requirement',
          'Contact conflicting events for rescheduling'
        ]
      }]
    }
  }

  /**
   * Resource allocation logic
   */
  private static async allocateResources(tx: any, event: any): Promise<{
    success: boolean
    allocations?: { resourceId: string; allocatedQuantity: number }[]
    conflicts?: AllocationConflict[]
    explanation?: string
  }> {
    const allocations: { resourceId: string; allocatedQuantity: number }[] = []
    const conflicts: AllocationConflict[] = []

    for (const resourceRequest of event.resourceRequests) {
      const resource = resourceRequest.resource

      // Calculate available quantity during event time
      const overlappingBookings = await tx.resourceBooking.findMany({
        where: {
          resourceId: resource.id,
          status: 'confirmed',
          AND: [
            { startTime: { lt: event.scheduleEnd } },
            { endTime: { gt: event.scheduleStart } }
          ]
        }
      })

      const bookedQuantity = overlappingBookings.reduce((sum, booking) => sum + booking.quantity, 0)
      const availableQuantity = resource.totalQuantity - bookedQuantity

      if (availableQuantity >= resourceRequest.quantityNeeded) {
        // Allocate the full requested quantity
        await tx.resourceBooking.create({
          data: {
            resourceId: resource.id,
            eventId: event.id,
            quantity: resourceRequest.quantityNeeded,
            startTime: event.scheduleStart,
            endTime: event.scheduleEnd,
            status: 'confirmed'
          }
        })

        // Update resource request status
        await tx.resourceRequest.update({
          where: { id: resourceRequest.id },
          data: {
            isAllocated: true,
            allocatedQuantity: resourceRequest.quantityNeeded
          }
        })

        allocations.push({
          resourceId: resource.id,
          allocatedQuantity: resourceRequest.quantityNeeded
        })

      } else {
        // Not enough resources available
        const conflictingBookings = await tx.resourceBooking.findMany({
          where: {
            resourceId: resource.id,
            status: 'confirmed',
            AND: [
              { startTime: { lt: event.scheduleEnd } },
              { endTime: { gt: event.scheduleStart } }
            ]
          },
          include: { event: { select: { id: true, title: true } } }
        })

        conflicts.push({
          type: 'resource_shortage',
          conflictingEventIds: conflictingBookings.map(b => b.event.id),
          details: `${resource.name}: Need ${resourceRequest.quantityNeeded}, only ${availableQuantity} available (${bookedQuantity} already booked)`,
          suggestions: [
            'Reduce quantity requirement',
            'Choose different time slot',
            'Find alternative resources'
          ]
        })
      }
    }

    if (conflicts.length > 0) {
      return {
        success: false,
        conflicts,
        explanation: `Failed to allocate ${conflicts.length} resources`
      }
    }

    return {
      success: true,
      allocations,
      explanation: `Successfully allocated ${allocations.length} resources`
    }
  }

  /**
   * Check allocation feasibility without actually allocating
   */
  static async checkAllocationFeasibility(eventId: string): Promise<AllocationResult> {
    const event = await prisma.event.findUnique({
      where: { id: eventId },
      include: {
        resourceRequests: {
          include: { resource: true }
        }
      }
    })

    if (!event) {
      throw new Error('Event not found')
    }

    // Simulate allocation without actual database changes
    const venueCheck = await this.checkVenueAvailability(event)
    const resourceCheck = await this.checkResourceAvailability(event)

    return {
      success: venueCheck.success && resourceCheck.success,
      conflicts: [...(venueCheck.conflicts || []), ...(resourceCheck.conflicts || [])],
      explanation: `Feasibility check: ${venueCheck.success ? 'Venue OK' : 'Venue issues'}, ${resourceCheck.success ? 'Resources OK' : 'Resource issues'}`
    }
  }

  private static async checkVenueAvailability(event: any) {
    const candidateVenues = await prisma.venue.findMany({
      where: {
        isActive: true,
        maintenanceMode: false,
        capacity: { gte: event.participantCount }
      }
    })

    if (candidateVenues.length === 0) {
      return {
        success: false,
        conflicts: [{
          type: 'venue_unavailable' as const,
          conflictingEventIds: [],
          details: 'No suitable venues available',
        }]
      }
    }

    for (const venue of candidateVenues) {
      const conflicts = await prisma.venueBooking.findMany({
        where: {
          venueId: venue.id,
          status: 'confirmed',
          AND: [
            { startTime: { lt: event.scheduleEnd } },
            { endTime: { gt: event.scheduleStart } }
          ]
        }
      })

      if (conflicts.length === 0) {
        return { success: true }
      }
    }

    return {
      success: false,
      conflicts: [{
        type: 'venue_unavailable' as const,
        conflictingEventIds: [],
        details: 'All suitable venues are booked'
      }]
    }
  }

  private static async checkResourceAvailability(event: any) {
    const conflicts: AllocationConflict[] = []

    for (const resourceRequest of event.resourceRequests) {
      const overlappingBookings = await prisma.resourceBooking.findMany({
        where: {
          resourceId: resourceRequest.resourceId,
          status: 'confirmed',
          AND: [
            { startTime: { lt: event.scheduleEnd } },
            { endTime: { gt: event.scheduleStart } }
          ]
        }
      })

      const bookedQuantity = overlappingBookings.reduce((sum, booking) => sum + booking.quantity, 0)
      const availableQuantity = resourceRequest.resource.totalQuantity - bookedQuantity

      if (availableQuantity < resourceRequest.quantityNeeded) {
        conflicts.push({
          type: 'resource_shortage',
          conflictingEventIds: overlappingBookings.map(b => b.eventId),
          details: `${resourceRequest.resource.name}: Need ${resourceRequest.quantityNeeded}, only ${availableQuantity} available`
        })
      }
    }

    return {
      success: conflicts.length === 0,
      conflicts: conflicts.length > 0 ? conflicts : undefined
    }
  }
}