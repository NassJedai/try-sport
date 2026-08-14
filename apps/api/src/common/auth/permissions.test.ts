import { describe, expect, it } from 'vitest';
import { businessRoleOf, hasBusinessRole, isPlatformAdmin } from './current-user.js';
import type { AuthenticatedUser } from './current-user.js';

const BUSINESS_A = 'business-a';
const BUSINESS_B = 'business-b';

const consumer: AuthenticatedUser = {
  id: 'u1',
  email: 'user@try.local',
  role: 'USER',
  memberships: [],
};

const staffOfA: AuthenticatedUser = {
  id: 'u2',
  email: 'staff@try.local',
  role: 'BUSINESS_MEMBER',
  memberships: [{ businessId: BUSINESS_A, role: 'STAFF' }],
};

const managerOfA: AuthenticatedUser = {
  ...staffOfA,
  id: 'u3',
  memberships: [{ businessId: BUSINESS_A, role: 'MANAGER' }],
};

const ownerOfA: AuthenticatedUser = {
  ...staffOfA,
  id: 'u4',
  memberships: [{ businessId: BUSINESS_A, role: 'OWNER' }],
};

const admin: AuthenticatedUser = {
  id: 'u5',
  email: 'admin@try.local',
  role: 'SUPER_ADMIN',
  memberships: [],
};

describe('business permissions', () => {
  it('denies a consumer any business access', () => {
    expect(businessRoleOf(consumer, BUSINESS_A)).toBeNull();
    expect(hasBusinessRole(consumer, BUSINESS_A, 'STAFF')).toBe(false);
  });

  it('does not let business A act on business B', () => {
    // The isolation guarantee the whole marketplace depends on.
    for (const actor of [staffOfA, managerOfA, ownerOfA]) {
      expect(hasBusinessRole(actor, BUSINESS_B, 'STAFF')).toBe(false);
      expect(businessRoleOf(actor, BUSINESS_B)).toBeNull();
    }
  });

  it('enforces the role hierarchy within a business', () => {
    // Staff can work the desk...
    expect(hasBusinessRole(staffOfA, BUSINESS_A, 'STAFF')).toBe(true);
    // ...but cannot see the CRM or override a check-in window.
    expect(hasBusinessRole(staffOfA, BUSINESS_A, 'MANAGER')).toBe(false);
    expect(hasBusinessRole(staffOfA, BUSINESS_A, 'OWNER')).toBe(false);

    expect(hasBusinessRole(managerOfA, BUSINESS_A, 'STAFF')).toBe(true);
    expect(hasBusinessRole(managerOfA, BUSINESS_A, 'MANAGER')).toBe(true);
    // Only an owner performs owner-level actions (billing, member removal).
    expect(hasBusinessRole(managerOfA, BUSINESS_A, 'OWNER')).toBe(false);

    expect(hasBusinessRole(ownerOfA, BUSINESS_A, 'OWNER')).toBe(true);
  });

  it('grants platform admins owner-level access for support', () => {
    expect(isPlatformAdmin(admin)).toBe(true);
    expect(businessRoleOf(admin, BUSINESS_A)).toBe('OWNER');
    expect(hasBusinessRole(admin, BUSINESS_B, 'OWNER')).toBe(true);
  });

  it('does not treat a consumer as a platform admin', () => {
    expect(isPlatformAdmin(consumer)).toBe(false);
    expect(isPlatformAdmin(ownerOfA)).toBe(false);
  });

  it('supports one account belonging to several businesses at different levels', () => {
    const multiBusiness: AuthenticatedUser = {
      ...staffOfA,
      memberships: [
        { businessId: BUSINESS_A, role: 'OWNER' },
        { businessId: BUSINESS_B, role: 'STAFF' },
      ],
    };

    expect(hasBusinessRole(multiBusiness, BUSINESS_A, 'OWNER')).toBe(true);
    expect(hasBusinessRole(multiBusiness, BUSINESS_B, 'STAFF')).toBe(true);
    // Being an owner of A grants nothing extra at B.
    expect(hasBusinessRole(multiBusiness, BUSINESS_B, 'MANAGER')).toBe(false);
  });

  it('ignores an unknown business id rather than defaulting to allow', () => {
    expect(hasBusinessRole(ownerOfA, 'business-that-does-not-exist', 'STAFF')).toBe(false);
  });
});
