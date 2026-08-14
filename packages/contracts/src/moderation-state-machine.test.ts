import { describe, expect, it } from 'vitest';
import { OFFER_STATUSES, VENUE_STATUSES } from './enums.js';
import {
  assertVenueTransition,
  canTransitionOffer,
  canTransitionVenue,
  InvalidModerationTransitionError,
  isOfferBookable,
  isVenueDiscoverable,
} from './moderation-state-machine.js';

describe('venue moderation', () => {
  it('walks the submission path', () => {
    expect(canTransitionVenue('DRAFT', 'PENDING_APPROVAL', 'BUSINESS')).toBe(true);
    expect(canTransitionVenue('PENDING_APPROVAL', 'ACTIVE', 'ADMIN')).toBe(true);
  });

  it('does not let a business approve its own venue', () => {
    // The whole point of a moderation queue.
    expect(canTransitionVenue('PENDING_APPROVAL', 'ACTIVE', 'BUSINESS')).toBe(false);
    expect(canTransitionVenue('DRAFT', 'ACTIVE', 'BUSINESS')).toBe(false);
  });

  it('does not let a business lift its own suspension', () => {
    // A venue suspended for a safety complaint must not be able to pause and
    // resume itself back into the marketplace.
    expect(canTransitionVenue('SUSPENDED', 'ACTIVE', 'BUSINESS')).toBe(false);
    expect(canTransitionVenue('SUSPENDED', 'PAUSED', 'BUSINESS')).toBe(false);
    expect(canTransitionVenue('SUSPENDED', 'ACTIVE', 'ADMIN')).toBe(true);
  });

  it('lets a business pause and resume itself', () => {
    expect(canTransitionVenue('ACTIVE', 'PAUSED', 'BUSINESS')).toBe(true);
    expect(canTransitionVenue('PAUSED', 'ACTIVE', 'BUSINESS')).toBe(true);
  });

  it('lets a rejected venue be fixed and resubmitted', () => {
    expect(canTransitionVenue('REJECTED', 'PENDING_APPROVAL', 'BUSINESS')).toBe(true);
  });

  it('only a business may suspend nothing, and only an admin may suspend', () => {
    expect(canTransitionVenue('ACTIVE', 'SUSPENDED', 'BUSINESS')).toBe(false);
    expect(canTransitionVenue('ACTIVE', 'SUSPENDED', 'ADMIN')).toBe(true);
  });

  it('treats ARCHIVED as terminal for every actor', () => {
    for (const to of VENUE_STATUSES) {
      for (const actor of ['BUSINESS', 'ADMIN', 'SYSTEM'] as const) {
        expect(canTransitionVenue('ARCHIVED', to, actor)).toBe(false);
      }
    }
  });

  it('never allows a self-transition', () => {
    for (const status of VENUE_STATUSES) {
      for (const actor of ['BUSINESS', 'ADMIN', 'SYSTEM'] as const) {
        expect(canTransitionVenue(status, status, actor)).toBe(false);
      }
    }
  });

  it('throws a named error on an invalid transition', () => {
    expect(() => assertVenueTransition('SUSPENDED', 'ACTIVE', 'BUSINESS')).toThrow(
      InvalidModerationTransitionError,
    );
    expect(() => assertVenueTransition('PENDING_APPROVAL', 'ACTIVE', 'ADMIN')).not.toThrow();
  });
});

describe('offer moderation', () => {
  it('requires admin approval to publish', () => {
    expect(canTransitionOffer('PENDING_APPROVAL', 'ACTIVE', 'ADMIN')).toBe(true);
    expect(canTransitionOffer('PENDING_APPROVAL', 'ACTIVE', 'BUSINESS')).toBe(false);
  });

  it('lets the system pause offers when their venue leaves ACTIVE', () => {
    // Otherwise suspending a venue would leave its offers bookable.
    expect(canTransitionOffer('ACTIVE', 'PAUSED', 'SYSTEM')).toBe(true);
    expect(canTransitionOffer('PAUSED', 'ACTIVE', 'SYSTEM')).toBe(true);
  });

  it('treats ARCHIVED as terminal', () => {
    for (const to of OFFER_STATUSES) {
      expect(canTransitionOffer('ARCHIVED', to, 'ADMIN')).toBe(false);
    }
  });
});

describe('discoverability', () => {
  it('exposes only ACTIVE venues', () => {
    for (const status of VENUE_STATUSES) {
      expect(isVenueDiscoverable(status)).toBe(status === 'ACTIVE');
    }
  });

  it('requires both the offer and its venue to be active', () => {
    expect(isOfferBookable('ACTIVE', 'ACTIVE')).toBe(true);
    // A live offer at a suspended venue must not be bookable.
    expect(isOfferBookable('ACTIVE', 'SUSPENDED')).toBe(false);
    expect(isOfferBookable('ACTIVE', 'PAUSED')).toBe(false);
    expect(isOfferBookable('PAUSED', 'ACTIVE')).toBe(false);
    expect(isOfferBookable('PENDING_APPROVAL', 'ACTIVE')).toBe(false);
  });
});
