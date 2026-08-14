import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { BusinessRole, UserRole } from '@try/contracts';
import type { FastifyRequest } from 'fastify';

export interface AuthenticatedUser {
  id: string;
  email: string;
  role: UserRole;
  memberships: { businessId: string; role: BusinessRole }[];
}

/** Requests carry the authenticated principal once the guard has verified it. */
export interface RequestWithUser extends FastifyRequest {
  user?: AuthenticatedUser;
}

export const CurrentUser = createParamDecorator(
  (_data: unknown, context: ExecutionContext): AuthenticatedUser | undefined =>
    context.switchToHttp().getRequest<RequestWithUser>().user,
);

/**
 * Membership lookup used by every business-scoped endpoint.
 * Platform admins are treated as owners so support can act on any business.
 */
export function businessRoleOf(
  user: AuthenticatedUser,
  businessId: string,
): BusinessRole | null {
  if (user.role === 'ADMIN' || user.role === 'SUPER_ADMIN') return 'OWNER';
  return user.memberships.find((m) => m.businessId === businessId)?.role ?? null;
}

const BUSINESS_ROLE_RANK: Record<BusinessRole, number> = {
  STAFF: 1,
  MANAGER: 2,
  OWNER: 3,
};

export function hasBusinessRole(
  user: AuthenticatedUser,
  businessId: string,
  minimum: BusinessRole,
): boolean {
  const role = businessRoleOf(user, businessId);
  return role !== null && BUSINESS_ROLE_RANK[role] >= BUSINESS_ROLE_RANK[minimum];
}

export function isPlatformAdmin(user: AuthenticatedUser): boolean {
  return user.role === 'ADMIN' || user.role === 'SUPER_ADMIN';
}
