import type { OfferStatus, VenueStatus } from './enums.js';

/**
 * Moderation lifecycle for supply.
 *
 * Every venue and offer that reaches a consumer has been through here. The rules
 * are explicit for the same reason the reservation machine is: "can this venue be
 * un-suspended by its own owner?" must have one answer, in one place, that a test
 * can pin down.
 */

export const MODERATION_ACTORS = ['BUSINESS', 'ADMIN', 'SYSTEM'] as const;
export type ModerationActor = (typeof MODERATION_ACTORS)[number];

interface Transition<TStatus extends string> {
  readonly to: TStatus;
  readonly actors: readonly ModerationActor[];
  readonly reason: string;
}

const VENUE_TRANSITIONS: Record<VenueStatus, readonly Transition<VenueStatus>[]> = {
  DRAFT: [
    {
      to: 'PENDING_APPROVAL',
      actors: ['BUSINESS'],
      reason: 'Business submitted the venue for review.',
    },
    { to: 'ARCHIVED', actors: ['BUSINESS', 'ADMIN'], reason: 'Abandoned before submission.' },
  ],
  PENDING_APPROVAL: [
    { to: 'ACTIVE', actors: ['ADMIN'], reason: 'Approved by moderation.' },
    { to: 'REJECTED', actors: ['ADMIN'], reason: 'Rejected with a reason the business can act on.' },
    { to: 'DRAFT', actors: ['BUSINESS'], reason: 'Business withdrew the submission to edit it.' },
  ],
  REJECTED: [
    {
      to: 'PENDING_APPROVAL',
      actors: ['BUSINESS'],
      reason: 'Resubmitted after addressing the rejection.',
    },
    { to: 'ARCHIVED', actors: ['BUSINESS', 'ADMIN'], reason: 'Given up on.' },
  ],
  ACTIVE: [
    { to: 'PAUSED', actors: ['BUSINESS', 'ADMIN'], reason: 'Temporarily not accepting trials.' },
    {
      to: 'SUSPENDED',
      actors: ['ADMIN'],
      reason: 'Suspended by the platform for a policy or quality issue.',
    },
    { to: 'ARCHIVED', actors: ['BUSINESS', 'ADMIN'], reason: 'Permanently closed.' },
  ],
  PAUSED: [
    { to: 'ACTIVE', actors: ['BUSINESS', 'ADMIN'], reason: 'Resumed by the business.' },
    { to: 'SUSPENDED', actors: ['ADMIN'], reason: 'Suspended while paused.' },
    { to: 'ARCHIVED', actors: ['BUSINESS', 'ADMIN'], reason: 'Permanently closed.' },
  ],
  /**
   * A suspension is a platform decision. Only an admin lifts it — otherwise a
   * venue suspended for a safety complaint could simply pause and resume itself
   * back into the marketplace.
   */
  SUSPENDED: [
    { to: 'ACTIVE', actors: ['ADMIN'], reason: 'Reinstated after review.' },
    { to: 'ARCHIVED', actors: ['ADMIN'], reason: 'Removed permanently.' },
  ],
  ARCHIVED: [],
};

const OFFER_TRANSITIONS: Record<OfferStatus, readonly Transition<OfferStatus>[]> = {
  DRAFT: [
    { to: 'PENDING_APPROVAL', actors: ['BUSINESS'], reason: 'Submitted for review.' },
    { to: 'ARCHIVED', actors: ['BUSINESS', 'ADMIN'], reason: 'Abandoned before submission.' },
  ],
  PENDING_APPROVAL: [
    { to: 'ACTIVE', actors: ['ADMIN'], reason: 'Approved and published.' },
    { to: 'REJECTED', actors: ['ADMIN'], reason: 'Rejected with a reason.' },
    { to: 'DRAFT', actors: ['BUSINESS'], reason: 'Withdrawn to edit.' },
  ],
  REJECTED: [
    { to: 'PENDING_APPROVAL', actors: ['BUSINESS'], reason: 'Resubmitted after changes.' },
    { to: 'ARCHIVED', actors: ['BUSINESS', 'ADMIN'], reason: 'Given up on.' },
  ],
  ACTIVE: [
    { to: 'PAUSED', actors: ['BUSINESS', 'ADMIN'], reason: 'Temporarily withdrawn from discovery.' },
    { to: 'ARCHIVED', actors: ['BUSINESS', 'ADMIN'], reason: 'Retired.' },
    /**
     * SYSTEM pauses an offer when its parent venue leaves ACTIVE. Without this,
     * suspending a venue would leave its offers bookable.
     */
    { to: 'PAUSED', actors: ['SYSTEM'], reason: 'Parent venue is no longer active.' },
  ],
  PAUSED: [
    { to: 'ACTIVE', actors: ['BUSINESS', 'ADMIN', 'SYSTEM'], reason: 'Resumed.' },
    { to: 'ARCHIVED', actors: ['BUSINESS', 'ADMIN'], reason: 'Retired.' },
  ],
  ARCHIVED: [],
};

export class InvalidModerationTransitionError extends Error {
  constructor(entity: 'venue' | 'offer', from: string, to: string, actor: ModerationActor) {
    super(`${actor} cannot move a ${entity} from ${from} to ${to}.`);
    this.name = 'InvalidModerationTransitionError';
  }
}

export function canTransitionVenue(
  from: VenueStatus,
  to: VenueStatus,
  actor: ModerationActor,
): boolean {
  return VENUE_TRANSITIONS[from].some(
    (transition) => transition.to === to && transition.actors.includes(actor),
  );
}

export function canTransitionOffer(
  from: OfferStatus,
  to: OfferStatus,
  actor: ModerationActor,
): boolean {
  return OFFER_TRANSITIONS[from].some(
    (transition) => transition.to === to && transition.actors.includes(actor),
  );
}

export function assertVenueTransition(
  from: VenueStatus,
  to: VenueStatus,
  actor: ModerationActor,
): void {
  if (!canTransitionVenue(from, to, actor)) {
    throw new InvalidModerationTransitionError('venue', from, to, actor);
  }
}

export function assertOfferTransition(
  from: OfferStatus,
  to: OfferStatus,
  actor: ModerationActor,
): void {
  if (!canTransitionOffer(from, to, actor)) {
    throw new InvalidModerationTransitionError('offer', from, to, actor);
  }
}

/** Only ACTIVE supply is discoverable. Used by both the API and the moderation UI. */
export function isVenueDiscoverable(status: VenueStatus): boolean {
  return status === 'ACTIVE';
}

export function isOfferBookable(offerStatus: OfferStatus, venueStatus: VenueStatus): boolean {
  return offerStatus === 'ACTIVE' && venueStatus === 'ACTIVE';
}

/** A rejection must always carry a reason the business can act on. */
export const REJECTION_REASON_MIN_LENGTH = 10;
