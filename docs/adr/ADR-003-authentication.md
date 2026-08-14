# ADR-003 — Authentication

**Status:** accepted · **Date:** 2026-08-14

## Context

Consumers sign in with email OTP, Google or Apple. Businesses use email or
Google. Admins need stronger protection and MFA. The backend must verify tokens
itself, and the frontend must never decide permissions.

## Options

**Supabase Auth / Clerk / Auth0.** Fast to adopt, MFA and social login included.
Each pulls user identity into a vendor and puts the session contract outside our
control; Clerk and Auth0 also price per MAU, which scales against us precisely
when growth is working.

**Own implementation.** More code to get right, and the parts that must be right
(token signing, rotation, replay detection) are the parts with real security
consequences.

## Decision

**Own JWT-based sessions**, with the identity provider behind an abstraction.

- Access tokens: HS256, 15 minutes, carrying role and business memberships.
- Refresh tokens: opaque, high-entropy, stored hashed, rotated on every use,
  with family revocation on reuse.
- OTP codes: stored hashed, single use, attempt-capped.
- A deliberately small HS256 implementation instead of a JOSE library: the
  algorithm is fixed, so algorithm-confusion attacks have no surface.

## Consequences

- MFA for admins is ours to build; tracked, not shipped.
- `auth_identities` already models external providers, so adding Google/Apple is
  verifying their token server-side and inserting a row.
- No per-MAU cost, and user identity stays in our database.
