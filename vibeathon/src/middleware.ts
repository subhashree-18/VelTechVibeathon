import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import { AuthService } from '@/lib/auth'

// Rate limiting store (in production, use Redis)
const rateLimitMap = new Map<string, { count: number; resetTime: number }>()

export async function middleware(request: NextRequest) {
  // Apply rate limiting
  const clientIP = request.ip || 'anonymous'
  const now = Date.now()
  const windowMs = 15 * 60 * 1000 // 15 minutes
  const maxRequests = 100

  const clientData = rateLimitMap.get(clientIP)
  
  if (clientData) {
    if (now > clientData.resetTime) {
      // Reset window
      rateLimitMap.set(clientIP, { count: 1, resetTime: now + windowMs })
    } else {
      clientData.count++
      if (clientData.count > maxRequests) {
        return NextResponse.json(
          { error: 'Too many requests' },
          { status: 429 }
        )
      }
    }
  } else {
    rateLimitMap.set(clientIP, { count: 1, resetTime: now + windowMs })
  }

  // Protected routes
  const protectedPaths = ['/dashboard', '/api/events', '/api/venues', '/api/resources']
  const isProtectedPath = protectedPaths.some(path => request.nextUrl.pathname.startsWith(path))

  if (isProtectedPath) {
    const user = await AuthService.getCurrentUser(request)
    
    if (!user) {
      if (request.nextUrl.pathname.startsWith('/api/')) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
      }
      return NextResponse.redirect(new URL('/auth/login', request.url))
    }

    // Add user info to headers for downstream handlers
    const response = NextResponse.next()
    response.headers.set('x-user-id', user.id)
    response.headers.set('x-user-role', user.role)
    if (user.schoolId) response.headers.set('x-user-school', user.schoolId)
    if (user.departmentId) response.headers.set('x-user-department', user.departmentId)
    
    return response
  }

  // Redirect authenticated users away from auth pages
  const authPaths = ['/auth/login', '/auth/register']
  if (authPaths.includes(request.nextUrl.pathname)) {
    const user = await AuthService.getCurrentUser(request)
    if (user) {
      return NextResponse.redirect(new URL('/dashboard', request.url))
    }
  }

  return NextResponse.next()
}

export const config = {
  matcher: [
    '/dashboard/:path*',
    '/api/:path*',
    '/auth/:path*',
    '/((?!_next/static|_next/image|favicon.ico).*)'
  ]
}