import { EventEmitter } from 'node:events';
import { Inject, Injectable } from '@nestjs/common';
import { getRequestId } from '@try/logger';
import type { Logger } from '@try/logger';
import type { OfferStatus, VenueStatus } from '@try/contracts';
import { LOGGER } from '../../common/logger.module.js';

/**
 * In-process domain events.
 *
 * The modular monolith uses these to decouple side effects (email, push,
 * analytics) from the transaction that caused them: confirming a booking must not
 * wait on an email provider, and an email provider outage must not roll back a
 * confirmed booking.
 *
 * Deliberately not Kafka. When a module needs to be extracted, these event names
 * are already the seam — the emit sites do not change, only the transport behind
 * this class.
 */

export interface DomainEventMap {
  BookingConfirmed: {
    reservationId: string;
    userId: string;
    businessId: string;
    venueId: string;
    offerId: string;
    isFree: boolean;
  };
  BookingPaymentPending: {
    reservationId: string;
    userId: string;
    businessId: string;
    venueId: string;
    offerId: string;
    isFree: boolean;
  };
  BookingCancelled: {
    reservationId: string;
    userId: string;
    businessId: string;
    refunded: boolean;
  };
  BookingExpired: { reservationId: string; userId: string };
  CheckInCompleted: {
    reservationId: string;
    userId: string;
    businessId: string;
    venueId: string;
    method: 'qr' | 'code';
  };
  TrialCompleted: { reservationId: string; userId: string; businessId: string; venueId: string };
  ReviewSubmitted: { reservationId: string; userId: string; venueId: string; rating: number };
  LeadConverted: { leadId: string; businessId: string; revenueMinor: number };
  PaymentSucceeded: { reservationId: string; paymentId: string; amount: number };
  PaymentFailed: { reservationId: string; paymentId: string; failureCode: string | null };
  PaymentRefunded: {
    reservationId: string;
    paymentId: string;
    providerRefundId: string;
    amountMinor: number;
    cumulativeRefundedMinor: number;
    platformFeeReversedMinor: number;
    isFullRefund: boolean;
  };
  /**
   * Un champ `IDENTITY` (nom, adresse, fuseau…) vient de changer sur un lieu
   * déjà en ligne (`ACTIVE`/`PAUSED`) — voir `editable-fields.ts`. L'écriture
   * est déjà passée, ce n'est jamais une décision : c'est une notification.
   * Émis par `OnboardingService.updateVenue`, après commit.
   *
   * Porte la valeur avant/après de chaque champ réellement modifié — pas
   * seulement son nom. `updateVenue` lit déjà la ligne existante pour sa
   * fusion (`key in dto ? dto.key : existing.key`) : les deux valeurs sont
   * déjà en main au moment d'émettre, les transmettre ne coûte rien et évite
   * qu'un consommateur (l'alerte admin) doive aller les rechercher ailleurs.
   */
  VenueIdentityChanged: {
    venueId: string;
    businessId: string;
    /** Qui a fait le changement — un membre du gérant, jamais le système. */
    actorId: string;
    /**
     * Uniquement les champs `IDENTITY` réellement modifiés dans cette
     * requête — jamais les huit systématiquement.
     */
    changes: readonly { field: string; oldValue: unknown; newValue: unknown }[];
  };
  /**
   * `legalName` ou `vatNumber` vient de changer sur un établissement déjà
   * `ACTIVE` — l'analogue de `VenueIdentityChanged` côté établissement plutôt
   * que côté lieu. Il n'existe pas de classification `FieldClass` pour
   * `businesses` comme `editable-fields.ts` en a une pour `venues`/`offers` :
   * `BusinessService.updateBusiness` décide seul que ces deux champs sont
   * ceux qui comptent pour cette alerte — `contactEmail`/`contactPhone` n'en
   * déclenchent pas, exploitation courante plutôt qu'identité contractuelle.
   * L'écriture est déjà passée ; ceci est une notification, jamais une
   * décision. Émis par `BusinessService.updateBusiness`, après commit.
   */
  BusinessIdentityChanged: {
    businessId: string;
    /** Qui a fait le changement — un membre OWNER du gérant, jamais le système. */
    actorId: string;
    /** Uniquement `legalName`/`vatNumber` réellement modifiés dans cette requête. */
    changes: readonly { field: string; oldValue: unknown; newValue: unknown }[];
  };
  /**
   * Décision de modération admin sur un lieu — approbation, refus, suspension,
   * réintégration. Émis par `ModerationService.decideVenue` (lot 2), pas ici :
   * ce fichier ne fait que déclarer la forme que le lot 2 doit respecter.
   */
  VenueModerationDecided: {
    venueId: string;
    businessId: string;
    decision: 'APPROVE' | 'REJECT' | 'SUSPEND' | 'REINSTATE';
    status: VenueStatus;
    /** Motif de refus ou de suspension ; `null` sinon. */
    reason: string | null;
  };
  /**
   * Décision de modération admin sur une offre. Émis par
   * `ModerationService.decideOffer` (lot 2), déclaré ici pour la même raison
   * que `VenueModerationDecided`.
   */
  OfferModerationDecided: {
    offerId: string;
    venueId: string;
    businessId: string;
    decision: 'APPROVE' | 'REJECT' | 'PAUSE';
    status: OfferStatus;
    reason: string | null;
  };
}

export type DomainEventName = keyof DomainEventMap;

export type DomainEventHandler<K extends DomainEventName> = (
  payload: DomainEventMap[K] & { requestId: string | undefined },
) => void | Promise<void>;

@Injectable()
export class DomainEvents {
  private readonly emitter = new EventEmitter();

  constructor(@Inject(LOGGER) private readonly logger: Logger) {
    // Listeners are side effects; one failing must never take down the emitter
    // or, worse, surface as an unhandled rejection that kills the process.
    this.emitter.setMaxListeners(50);
  }

  emit<K extends DomainEventName>(name: K, payload: DomainEventMap[K]): void {
    this.emitter.emit(name, { ...payload, requestId: getRequestId() });
  }

  on<K extends DomainEventName>(name: K, handler: DomainEventHandler<K>): void {
    this.emitter.on(name, (payload: DomainEventMap[K] & { requestId: string | undefined }) => {
      void (async () => {
        try {
          await handler(payload);
        } catch (error) {
          this.logger.error(
            { err: error, event: name, requestId: payload.requestId },
            'domain event handler failed',
          );
        }
      })();
    });
  }
}
