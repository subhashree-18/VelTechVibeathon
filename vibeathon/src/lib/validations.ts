import { z } from 'zod'
import { Role, EventStatus, ApprovalStage, ResourceCategory } from '@prisma/client'

// Auth schemas
export const loginSchema = z.object({
  email: z.string().email('Invalid email address'),
  password: z.string().min(6, 'Password must be at least 6 characters'),
})

export const registerSchema = z.object({
  email: z.string().email('Invalid email address'),
  password: z.string().min(8, 'Password must be at least 8 characters'),
  firstName: z.string().min(1, 'First name is required'),
  lastName: z.string().min(1, 'Last name is required'),
  role: z.nativeEnum(Role),
  schoolId: z.string().optional(),
  departmentId: z.string().optional(),
})

// Event schemas
export const eventRequestSchema = z.object({
  title: z.string().min(1, 'Title is required').max(200, 'Title too long'),
  description: z.string().optional(),
  scheduleStart: z.string().datetime('Invalid start date'),
  scheduleEnd: z.string().datetime('Invalid end date'),
  participantCount: z.number().min(1, 'Must have at least 1 participant').max(10000, 'Too many participants'),
  venueTypePreference: z.string().optional(),
  requirements: z.any().optional(),
})
.refine(data => new Date(data.scheduleEnd) > new Date(data.scheduleStart), {
  message: 'End time must be after start time',
  path: ['scheduleEnd']
})

export const approvalActionSchema = z.object({
  action: z.enum(['APPROVED', 'REJECTED', 'MODIFICATION_REQUIRED']),
  comments: z.string().optional(),
})

// Resource schemas
export const resourceSchema = z.object({
  name: z.string().min(1, 'Name is required'),
  category: z.nativeEnum(ResourceCategory),
  totalQuantity: z.number().min(0, 'Quantity cannot be negative'),
  unit: z.string().min(1, 'Unit is required'),
  description: z.string().optional(),
})

export const resourceRequestSchema = z.object({
  resourceId: z.string().cuid('Invalid resource ID'),
  quantityNeeded: z.number().min(1, 'Quantity must be at least 1'),
  priority: z.enum(['high', 'normal', 'low']),
  justification: z.string().optional(),
})

// Venue schemas
export const venueSchema = z.object({
  name: z.string().min(1, 'Name is required'),
  type: z.string().min(1, 'Type is required'),
  capacity: z.number().min(1, 'Capacity must be at least 1'),
  location: z.string().min(1, 'Location is required'),
  facilities: z.array(z.string()).optional(),
})

export const venueBookingSchema = z.object({
  venueId: z.string().cuid('Invalid venue ID'),
  startTime: z.string().datetime('Invalid start time'),
  endTime: z.string().datetime('Invalid end time'),
})
.refine(data => new Date(data.endTime) > new Date(data.startTime), {
  message: 'End time must be after start time',
  path: ['endTime']
})

// Notification schemas
export const notificationSchema = z.object({
  title: z.string().min(1, 'Title is required'),
  message: z.string().min(1, 'Message is required'),
  type: z.string(),
  data: z.any().optional(),
})

// Query parameter schemas
export const eventQuerySchema = z.object({
  page: z.coerce.number().min(1).default(1),
  limit: z.coerce.number().min(1).max(100).default(10),
  status: z.nativeEnum(EventStatus).optional(),
  approvalStage: z.nativeEnum(ApprovalStage).optional(),
  startDate: z.string().datetime().optional(),
  endDate: z.string().datetime().optional(),
  search: z.string().optional(),
})

export const resourceQuerySchema = z.object({
  page: z.coerce.number().min(1).default(1),
  limit: z.coerce.number().min(1).max(100).default(10),
  category: z.nativeEnum(ResourceCategory).optional(),
  available: z.coerce.boolean().optional(),
  search: z.string().optional(),
})

// API response schemas
export const apiResponseSchema = z.object({
  success: z.boolean(),
  data: z.any().optional(),
  error: z.string().optional(),
  message: z.string().optional(),
})

export type LoginSchema = z.infer<typeof loginSchema>
export type RegisterSchema = z.infer<typeof registerSchema>
export type EventRequestSchema = z.infer<typeof eventRequestSchema>
export type ApprovalActionSchema = z.infer<typeof approvalActionSchema>
export type ResourceSchema = z.infer<typeof resourceSchema>
export type ResourceRequestSchema = z.infer<typeof resourceRequestSchema>
export type VenueSchema = z.infer<typeof venueSchema>
export type VenueBookingSchema = z.infer<typeof venueBookingSchema>
export type NotificationSchema = z.infer<typeof notificationSchema>
export type EventQuerySchema = z.infer<typeof eventQuerySchema>
export type ResourceQuerySchema = z.infer<typeof resourceQuerySchema>
export type ApiResponse = z.infer<typeof apiResponseSchema>