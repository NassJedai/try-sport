import { Controller, Get, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { PAYMENT_STATUSES, RESERVATION_STATUSES, VENUE_STATUSES } from '@try/contracts';
import { Roles } from '../../common/auth/auth.guard.js';
import { CurrentUser, type AuthenticatedUser } from '../../common/auth/current-user.js';
import { zodQuery } from '../../common/zod-validation.pipe.js';
import { AdminBrowseService } from './admin-browse.service.js';

const usersQuerySchema = z.object({
  q: z.string().trim().max(120).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

const bookingsQuerySchema = z.object({
  status: z.enum(RESERVATION_STATUSES).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

/**
 * `status` filtre sur un statut exact de `PAYMENT_STATUSES`, pas sur les
 * regroupements « situation » de `payment-capture.ts`
 * (`CAPTURED`/`IN_FLIGHT`/`STOPPED`). Ces groupes existent pour trancher « une
 * commission a-t-elle existé ? », une question plus grossière que celle d'un
 * admin au clavier : « montre-moi les remboursements » veut `REFUNDED`
 * précisément, pas tout `CAPTURED` — ce dernier bucket mélangerait `SUCCEEDED`
 * dedans et rendrait le filtre inutilisable pour ce cas d'usage réel. Voir
 * `AdminBrowseService.payments()` pour le detail.
 *
 * `cursor` suit `packages/utils/src/pagination.ts` (`encodeCursor`/
 * `decodeCursor`/`buildCursorPage`) : un curseur d'ensemble ordonné (createdAt,
 * id), pas un offset — stable si des paiements arrivent pendant qu'un admin
 * feuillette. Les bornes de `limit` restent celles des routes sœurs de ce
 * contrôleur (1-100, défaut 50), pas celles de `cursorPaginationSchema`
 * (1-50, défaut 20) qui servent un usage public différent.
 */
const paymentsQuerySchema = z.object({
  status: z.enum(PAYMENT_STATUSES).optional(),
  cursor: z.string().max(512).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

/**
 * Même trio que `paymentsQuerySchema` juste au-dessus (filtre exact + curseur
 * keyset + limite bornée) — voir `AdminBrowseService.venues()`. `q` cherche
 * dans le nom du lieu ou celui de l'établissement, comme `usersQuerySchema`
 * cherche dans l'e-mail ou le prénom.
 */
const venuesQuerySchema = z.object({
  q: z.string().trim().max(120).optional(),
  status: z.enum(VENUE_STATUSES).optional(),
  cursor: z.string().max(512).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

/**
 * Navigation back-office, lecture seule.
 *
 * Le rôle est vérifié deux fois — par le garde global via @Roles, puis par le
 * service — parce que ces vues exposent des e-mails et des montants : le genre
 * d'endpoint qu'on ne laisse pas protégé par une seule couche.
 */
@ApiTags('admin')
@Controller({ path: 'admin', version: '1' })
@Roles('ADMIN', 'SUPER_ADMIN')
export class AdminBrowseController {
  constructor(private readonly browse: AdminBrowseService) {}

  @Get('users')
  @ApiOperation({ summary: 'Recherche d’utilisateurs par e-mail ou prénom' })
  users(
    @CurrentUser() user: AuthenticatedUser,
    @Query(zodQuery(usersQuerySchema)) query: unknown,
  ) {
    return this.browse.users(user, query as z.infer<typeof usersQuerySchema>);
  }

  @Get('bookings')
  @ApiOperation({ summary: 'Dernières réservations, filtrables par statut' })
  bookings(
    @CurrentUser() user: AuthenticatedUser,
    @Query(zodQuery(bookingsQuerySchema)) query: unknown,
  ) {
    return this.browse.bookings(user, query as z.infer<typeof bookingsQuerySchema>);
  }

  @Get('payments')
  @ApiOperation({ summary: 'Derniers paiements avec commission et remboursements' })
  payments(
    @CurrentUser() user: AuthenticatedUser,
    @Query(zodQuery(paymentsQuerySchema)) query: unknown,
  ) {
    return this.browse.payments(user, query as z.infer<typeof paymentsQuerySchema>);
  }

  @Get('venues')
  @ApiOperation({ summary: 'Recherche de lieux par nom, établissement ou statut' })
  venues(
    @CurrentUser() user: AuthenticatedUser,
    @Query(zodQuery(venuesQuerySchema)) query: unknown,
  ) {
    return this.browse.venues(user, query as z.infer<typeof venuesQuerySchema>);
  }

  @Get('venues/incomplete')
  @ApiOperation({ summary: 'Lieux inscrits dont le dossier reste incomplet, à relancer' })
  incompleteVenues(@CurrentUser() user: AuthenticatedUser) {
    return this.browse.incompleteVenues(user);
  }
}
