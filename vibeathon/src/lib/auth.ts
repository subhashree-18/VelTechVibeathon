import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'
import { NextRequest } from 'next/server'
import { prisma } from './prisma'
import { User, Role } from '@prisma/client'

const JWT_SECRET = process.env.JWT_SECRET || 'fallback-secret-for-dev'

export interface AuthUser extends Pick<User, 'id' | 'email' | 'firstName' | 'lastName' | 'role' | 'schoolId' | 'departmentId'> {}

export interface JWTPayload {
  userId: string
  email: string
  role: Role
  schoolId?: string
  departmentId?: string
}

export class AuthService {
  static async hashPassword(password: string): Promise<string> {
    return bcrypt.hash(password, 12)
  }

  static async verifyPassword(password: string, hashedPassword: string): Promise<boolean> {
    return bcrypt.compare(password, hashedPassword)
  }

  static generateToken(user: AuthUser): string {
    const payload: JWTPayload = {
      userId: user.id,
      email: user.email,
      role: user.role,
      schoolId: user.schoolId || undefined,
      departmentId: user.departmentId || undefined,
    }

    return jwt.sign(payload, JWT_SECRET, { 
      expiresIn: '7d',
      issuer: 'vibeathon-app'
    })
  }

  static verifyToken(token: string): JWTPayload | null {
    try {
      return jwt.verify(token, JWT_SECRET, { issuer: 'vibeathon-app' }) as JWTPayload
    } catch {
      return null
    }
  }

  static async getCurrentUser(request: NextRequest): Promise<AuthUser | null> {
    const token = request.cookies.get('auth-token')?.value

    if (!token) return null

    const payload = this.verifyToken(token)
    if (!payload) return null

    const user = await prisma.user.findUnique({
      where: { id: payload.userId },
      select: {
        id: true,
        email: true,
        firstName: true,
        lastName: true,
        role: true,
        schoolId: true,
        departmentId: true,
        isActive: true,
      }
    })

    if (!user || !user.isActive) return null

    return user
  }
}

// Role-based access control utilities
export const RBAC = {
  canViewEvent: (userRole: Role, userSchoolId?: string, userDepartmentId?: string, eventSchoolId?: string, eventDepartmentId?: string): boolean => {
    switch (userRole) {
      case Role.EVENT_COORDINATOR:
        // Can only view own department events
        return userDepartmentId === eventDepartmentId
      case Role.HOD:
        // Can view department events
        return userDepartmentId === eventDepartmentId
      case Role.DEAN:
        // Can view school events
        return userSchoolId === eventSchoolId
      case Role.INSTITUTIONAL_HEAD:
      case Role.ADMIN_ITC:
        // Can view all events
        return true
      default:
        return false
    }
  },

  canApproveEvent: (userRole: Role, approvalStage: string): boolean => {
    switch (userRole) {
      case Role.HOD:
        return approvalStage === 'SUBMITTED'
      case Role.DEAN:
        return approvalStage === 'HOD_APPROVED'
      case Role.INSTITUTIONAL_HEAD:
        return approvalStage === 'DEAN_APPROVED'
      default:
        return false
    }
  },

  canManageResources: (userRole: Role): boolean => {
    return [Role.ADMIN_ITC, Role.INSTITUTIONAL_HEAD].includes(userRole)
  },

  canCreateEvent: (userRole: Role): boolean => {
    return userRole === Role.EVENT_COORDINATOR
  }
}