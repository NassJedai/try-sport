/**
 * Cancellation windows are expressed in hours before the session starts and are
 * stored per offer, so a €0 yoga trial and a €40 premium recovery session can
 * carry different rules without a schema change.
 */

export const CANCELLATION_POLICIES = ['FLEXIBLE', 'STANDARD', 'STRICT'] as const;
export type CancellationPolicy = (typeof CANCELLATION_POLICIES)[number];

export interface CancellationPolicyDefinition {
  /** Free cancellation is allowed up to this many hours before the start. */
  readonly freeUntilHoursBefore: number;
  readonly labelFr: string;
}

export const CANCELLATION_POLICY_DEFINITIONS: Record<
  CancellationPolicy,
  CancellationPolicyDefinition
> = {
  FLEXIBLE: {
    freeUntilHoursBefore: 1,
    labelFr: 'Annulation gratuite jusqu’à 1 h avant la séance.',
  },
  STANDARD: {
    freeUntilHoursBefore: 12,
    labelFr: 'Annulation gratuite jusqu’à 12 h avant la séance.',
  },
  STRICT: {
    freeUntilHoursBefore: 24,
    labelFr: 'Annulation gratuite jusqu’à 24 h avant la séance.',
  },
};

export const DEFAULT_CANCELLATION_POLICY: CancellationPolicy = 'STANDARD';

export interface CancellationAssessment {
  readonly canCancel: boolean;
  /** Whether a paid booking is refunded in full when cancelled right now. */
  readonly refundable: boolean;
  readonly freeUntil: Date;
}

/**
 * A user may always cancel before the session starts — refusing to let someone
 * cancel only produces a no-show. What the window governs is the refund.
 */
export function assessCancellation(input: {
  policy: CancellationPolicy;
  slotStartAt: Date;
  now: Date;
}): CancellationAssessment {
  const { freeUntilHoursBefore } = CANCELLATION_POLICY_DEFINITIONS[input.policy];
  const freeUntil = new Date(input.slotStartAt.getTime() - freeUntilHoursBefore * 3_600_000);

  return {
    canCancel: input.now.getTime() < input.slotStartAt.getTime(),
    refundable: input.now.getTime() <= freeUntil.getTime(),
    freeUntil,
  };
}
