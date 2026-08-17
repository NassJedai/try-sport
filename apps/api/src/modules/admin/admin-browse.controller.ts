import { Controller, Get, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { RESERVATION_STATUSES } from '@try/contracts';
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

const paymentsQuerySchema = z.object({
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

  @Get('venues/incomplete')
  @ApiOperation({ summary: 'Lieux inscrits dont le dossier reste incomplet, à relancer' })
  incompleteVenues(@CurrentUser() user: AuthenticatedUser) {
    return this.browse.incompleteVenues(user);
  }
}
