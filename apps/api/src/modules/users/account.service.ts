import { Inject, Injectable } from '@nestjs/common';
import { and, eq, ne } from 'drizzle-orm';
import { acquireIdentityLock, schema } from '@try/database';
import type { Database, Transaction } from '@try/database';
import type { Clock } from '@try/utils';
import type { Logger } from '@try/logger';
import { DATABASE } from '../../common/database.module.js';
import { CLOCK } from '../../common/clock.js';
import { LOGGER } from '../../common/logger.module.js';
import { ApiException } from '../../common/errors/api-exception.js';
import { CryptoService } from '../../common/crypto.service.js';
import type { AuthenticatedUser } from '../../common/auth/current-user.js';
import { BookingService } from '../bookings/booking.service.js';
import { DomainEvents } from '../events/domain-events.js';
import { AuditService } from '../admin/audit.service.js';
import { NotificationService } from '../notifications/notification.service.js';

export interface DeleteAccountResult {
  deletedAt: string;
}

/**
 * Suppression de compte, exigée par la règle App Store 5.1.1(v) (« tout
 * compte créable doit être supprimable ») et par le droit à l'effacement du
 * RGPD.
 *
 * **Anonymiser, jamais effacer la ligne `users` elle-même.** Une réservation,
 * un paiement, une commission, une ligne de `trial_history` ne peuvent pas
 * disparaître : la salle a été payée, la comptabilité doit rester juste,
 * l'allocation d'essai ne doit pas se recharger. `packages/database/src/
 * schema/identity.ts` documente déjà cette séparation `users`/`profiles` —
 * ce service l'exécute, il ne l'invente pas.
 *
 * Ce qui est effacé, anonymisé, ou conservé tel quel, table par table :
 *
 * **Effacé (aucune valeur utile après la suppression, aucune obligation de
 * conservation)** : `profiles` (nom, avatar, téléphone, préférences —
 * précisément ce que `packages/database/src/schema/identity.ts` documente
 * comme « la donnée personnelle qu'un utilisateur peut demander à effacer »),
 * `user_interests`, `auth_identities` (liaison Google/Apple), `push_tokens`,
 * `refresh_tokens` (sessions actives), `notifications` (boîte de réception),
 * `favorites`, `attributions` (source d'acquisition marketing),
 * `referrals` (code de parrainage et ses compteurs), `idempotency_keys`,
 * et les `otp_codes` encore valides pour cette adresse.
 *
 * **Anonymisé** : la ligne `users` elle-même — adresse remplacée par un
 * identifiant synthétique non réversible (`email` reste `NOT NULL`, voir le
 * commentaire du schéma), `anonymizedAt` posé, `emailHash` écrit pour la
 * réactivation (voir plus bas). C'est la seule ligne qui survit sous une
 * forme dégradée plutôt que de disparaître ou de rester intacte : elle doit
 * rester une cible de jointure valide pour tout ce qui la référence encore.
 *
 * **Conservé tel quel, sans aucune modification** : `reservations`,
 * `payments`, `refunds`, `trial_history`, `check_ins`, `leads`, `audit_logs`.
 * Ce sont exactement les tables qui portent de l'argent, une obligation
 * comptable, ou l'historique d'essai anti-abus — leur `userId`/`actorId`
 * continue de désigner la même ligne `users`, désormais anonymisée, jamais
 * une ligne orpheline. `leads.notes` (note libre écrite par la salle sur ce
 * prospect) n'est pas expurgée : c'est une décision consciente, pas un oubli
 * — voir le rapport de ce lot pour l'arbitrage et pourquoi il mérite d'être
 * revu avec un avis juridique plutôt que tranché ici.
 *
 * **L'essai ne doit pas se recharger — la vraie difficulté de ce lot.**
 * Supprimer un compte puis se réinscrire avec la même adresse ne doit pas
 * redonner une séance découverte gratuite. `trial_history` n'est jamais
 * touché, donc il continue de bloquer une nouvelle réservation *si* la
 * réinscription retombe sur le même id `users` — ce qui exige de reconnaître
 * la réinscription. C'est le rôle de `emailHash`
 * (`CryptoService.hashErasedEmail`, pseudonyme HMAC non réversible sans
 * `EMAIL_ERASURE_PEPPER`) : `AuthService.findOrCreateUser` le recalcule à
 * chaque inscription et, s'il trouve une ligne anonymisée qui le porte,
 * réactive cette ligne au lieu d'en créer une vierge. Ce mécanisme ferme
 * précisément « supprimer puis se réinscrire à la MÊME adresse » ; il ne
 * ferme pas — et ne peut pas fermer — « se réinscrire avec une adresse
 * différente », qui redonne un essai aujourd'hui même sans jamais supprimer
 * de compte (c'est la portée de la règle d'essai elle-même, pas une faille
 * de la suppression).
 *
 * **Immédiat, pas différé.** Aucun délai de grâce : rien dans ce dépôt n'a de
 * notion de suppression programmée à annuler, et en ajouter une pour ce seul
 * geste aurait rouvert la fenêtre qu'`emailHash` ferme (un compte "en attente
 * de suppression" garde son adresse en clair). Un délai de grâce reste une
 * amélioration UX possible plus tard, pas une exigence de conformité.
 *
 * **Comptes protégés.** `ADMIN`/`SUPER_ADMIN` ne peuvent pas se supprimer
 * eux-mêmes par cette voie — un rôle de modération qui disparaît sans
 * remplacement est un risque qu'aucune heuristique ne tranche correctement
 * ici ; refuser et expliquer est la réponse retenue. Un `OWNER` unique d'au
 * moins un établissement est bloqué de la même façon tant qu'un autre
 * propriétaire n'a pas été ajouté — la salle ne doit jamais se retrouver sans
 * propriétaire.
 */
@Injectable()
export class AccountService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(LOGGER) private readonly logger: Logger,
    private readonly crypto: CryptoService,
    private readonly bookings: BookingService,
    private readonly notifications: NotificationService,
    private readonly events: DomainEvents,
    private readonly audit: AuditService,
  ) {}

  async deleteAccount(actor: AuthenticatedUser): Promise<DeleteAccountResult> {
    if (actor.role === 'ADMIN' || actor.role === 'SUPER_ADMIN') {
      throw new ApiException(
        'FORBIDDEN',
        'Les comptes d’administration ne peuvent pas être supprimés depuis cet endpoint. ' +
          'Demande à un autre administrateur, ou contacte le support.',
      );
    }

    const now = this.clock.now();

    const outcome = await this.db.transaction(async (tx) => {
      // Même clé que AuthService.findOrCreateUser : sérialise cette adresse
      // contre une réinscription concurrente (voir acquireIdentityLock).
      await acquireIdentityLock(tx, actor.email);

      const [user] = await tx
        .select()
        .from(schema.users)
        .where(eq(schema.users.id, actor.id))
        .for('update')
        .limit(1);

      if (!user) throw ApiException.notFound('user', actor.id);

      if (user.anonymizedAt) {
        // Double soumission (retry réseau, double clic) : pas d'effet de
        // bord supplémentaire, on rend le même résultat que la première fois.
        return { deletedAt: user.anonymizedAt, cancelled: [], email: null, firstName: null };
      }

      await this.assertNoSoleOwnership(tx, actor.id);

      const [profile] = await tx
        .select({ firstName: schema.profiles.firstName })
        .from(schema.profiles)
        .where(eq(schema.profiles.userId, actor.id))
        .limit(1);

      const cancelled = await this.bookings.cancelAllForDeletion(tx, actor.id, now);

      await tx.delete(schema.profiles).where(eq(schema.profiles.userId, actor.id));
      await tx.delete(schema.userInterests).where(eq(schema.userInterests.userId, actor.id));
      await tx.delete(schema.authIdentities).where(eq(schema.authIdentities.userId, actor.id));
      await tx.delete(schema.pushTokens).where(eq(schema.pushTokens.userId, actor.id));
      await tx.delete(schema.refreshTokens).where(eq(schema.refreshTokens.userId, actor.id));
      await tx.delete(schema.notifications).where(eq(schema.notifications.userId, actor.id));
      await tx.delete(schema.favorites).where(eq(schema.favorites.userId, actor.id));
      await tx.delete(schema.attributions).where(eq(schema.attributions.userId, actor.id));
      await tx.delete(schema.referrals).where(eq(schema.referrals.referrerUserId, actor.id));
      await tx.delete(schema.idempotencyKeys).where(eq(schema.idempotencyKeys.userId, actor.id));
      await tx.delete(schema.otpCodes).where(eq(schema.otpCodes.email, user.email));
      await tx.delete(schema.businessMembers).where(eq(schema.businessMembers.userId, actor.id));

      const emailHash = this.crypto.hashErasedEmail(user.email);
      await tx
        .update(schema.users)
        .set({
          email: `erased+${actor.id}@erased.try.invalid`,
          emailHash,
          anonymizedAt: now,
          lastSeenAt: now,
          updatedAt: now,
        })
        .where(eq(schema.users.id, actor.id));

      await this.audit.record(tx, {
        actorId: actor.id,
        actorType: 'USER',
        action: 'user.self_delete',
        entityType: 'user',
        entityId: actor.id,
        // Jamais l'adresse en clair dans l'audit : ce serait recréer, dans
        // une table différente, exactement ce que cette suppression efface.
        metadata: { reservationsCancelled: cancelled.length },
      });

      return {
        deletedAt: now,
        cancelled,
        email: user.email,
        firstName: profile?.firstName ?? null,
      };
    });

    /**
     * Après COMMIT, jamais depuis l'intérieur de la transaction ci-dessus —
     * voir la section « Emit after COMMIT » de domain-events.ts. Réutilise
     * l'événement `BookingCancelled` existant : les auditeurs déjà en place
     * (notifications, analytique) traitent une annulation liée à une
     * suppression de compte exactement comme n'importe quelle autre
     * annulation utilisateur, ce qui est le comportement correct.
     */
    for (const event of outcome.cancelled) this.events.emit('BookingCancelled', event);

    if (outcome.email) {
      void this.notifications.sendAccountDeletionConfirmation({
        email: outcome.email,
        firstName: outcome.firstName,
      });
    }

    this.logger.info(
      { userId: actor.id, reservationsCancelled: outcome.cancelled.length },
      'account anonymised (self-deletion)',
    );

    return { deletedAt: outcome.deletedAt.toISOString() };
  }

  /**
   * Refuse la suppression si l'utilisateur est l'unique `OWNER` d'au moins un
   * établissement — un établissement ne doit jamais se retrouver sans
   * propriétaire. `STAFF`/`MANAGER`, ou `OWNER` aux côtés d'un autre `OWNER`,
   * ne bloquent rien : leur ligne `business_members` est simplement retirée.
   */
  private async assertNoSoleOwnership(tx: Transaction, userId: string): Promise<void> {
    const owned = await tx
      .select({ businessId: schema.businessMembers.businessId })
      .from(schema.businessMembers)
      .where(and(eq(schema.businessMembers.userId, userId), eq(schema.businessMembers.role, 'OWNER')));

    for (const { businessId } of owned) {
      const others = await tx
        .select({ id: schema.businessMembers.id })
        .from(schema.businessMembers)
        .where(
          and(
            eq(schema.businessMembers.businessId, businessId),
            eq(schema.businessMembers.role, 'OWNER'),
            ne(schema.businessMembers.userId, userId),
          ),
        )
        .limit(1);

      if (others.length === 0) {
        throw new ApiException(
          'CONFLICT',
          'Tu es l’unique propriétaire d’au moins un établissement. Ajoute un autre ' +
            'propriétaire avant de supprimer ton compte, ou contacte le support.',
          undefined,
          { businessId },
        );
      }
    }
  }
}
