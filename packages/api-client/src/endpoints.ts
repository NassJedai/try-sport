import type {
  AuthSessionDto,
  AvailabilityResponseDto,
  BookingDto,
  BookingPageDto,
  BusinessBookingDto,
  BusinessMetricsDto,
  BusinessOfferDto,
  BusinessSlotDto,
  BusinessStatus,
  BusinessVenueDto,
  CheckInResultDto,
  DiscoveryHomeDto,
  LeadDto,
  MapOffersResponseDto,
  NotificationDto,
  OfferCardPageDto,
  OfferDetailDto,
  SearchOffersQueryDto,
  UpdateOfferDto,
  UpdateVenueDto,
  ViewerDto,
} from '@try/contracts';
import type { ApiClient } from './http.js';

/**
 * Réponse de `GET`/`PATCH /v1/businesses/:businessId`.
 *
 * Pas dans `@try/contracts` : aucun `BusinessDetailDto` n'y existe encore
 * pour ce lot (signalé à `contracts-guardian`, pas créé sur place). Cette
 * forme doit rester synchronisée à la main avec
 * `apps/api/src/modules/business/business-dto.mapper.ts` tant que ça dure —
 * contrairement aux DTO ci-dessus, un changement de forme côté API ne fera
 * pas échouer la compilation ici.
 */
export interface BusinessDetailDto {
  id: string;
  name: string;
  status: BusinessStatus;
  legalName: string | null;
  vatNumber: string | null;
  countryCode: string;
  contactEmail: string;
  contactPhone: string | null;
  createdAt: string;
}

/** Corps du `PATCH` — voir `apps/api/src/modules/business/update-business.schema.ts` pour les règles. */
export interface UpdateBusinessInput {
  legalName?: string;
  vatNumber?: string;
  contactEmail?: string;
  contactPhone?: string | null;
}

/**
 * Réponse de `GET /v1/admin/payments`.
 *
 * Même situation que `BusinessDetailDto` ci-dessus : pas de DTO dans
 * `@try/contracts`, à synchroniser à la main avec le type de retour de
 * `AdminBrowseService.payments()`
 * (`apps/api/src/modules/admin/admin-browse.service.ts`). Aujourd'hui aucun
 * appelant ne passe par ici — `apps/admin/app/payments/page.tsx` fait encore
 * un `apiClient.get()` brut avec sa propre interface locale (dette suivie
 * dans `TODO.md`, § « La console admin affiche encore la commission
 * brute »). Cette forme existe pour que ce futur branchement ait un type
 * correct à consommer dès le départ plutôt que de reproduire l'écart.
 *
 * `netPlatformFee` est `null` quand notre base n'a constaté aucun
 * encaissement (checkout jamais capturé — aucune commission n'a existé), et
 * un montant, éventuellement `0`, quand un encaissement a été constaté (`0`
 * signifie alors un remboursement intégral de la commission, pas une
 * absence de vente). Voir le commentaire sur `netPlatformFee` dans
 * `AdminBrowseService.payments()` pour le détail de la règle.
 */
export interface AdminPaymentDto {
  id: string;
  status: string;
  userEmail: string;
  businessName: string;
  amount: { amount: number; currency: string };
  platformFee: { amount: number; currency: string };
  netPlatformFee: { amount: number; currency: string } | null;
  refunded: { amount: number; currency: string };
  providerPaymentIntentId: string | null;
  createdAt: string;
}

/**
 * Corps de la requête `GET /v1/admin/payments` — voir `paymentsQuerySchema`
 * dans `apps/api/src/modules/admin/admin-browse.controller.ts` pour les
 * règles exactes (bornes de `limit`, `status` exact plutôt qu'un
 * regroupement `payment-capture.ts`).
 */
export interface AdminPaymentsQuery {
  status?: string;
  cursor?: string;
  limit?: number;
}

/**
 * Typed endpoint surface.
 *
 * Every response type comes from `@try/contracts`, which the API also validates
 * against — so a breaking server change becomes a compile error in the apps
 * rather than a runtime surprise on a user's phone.
 */
export function createEndpoints(client: ApiClient) {
  return {
    auth: {
      requestOtp: (email: string, locale: 'fr' | 'en' | 'nl' = 'fr') =>
        client.post<{ sent: true }>('/v1/auth/otp/request', { email, locale }, { anonymous: true }),

      verifyOtp: (input: {
        email: string;
        code: string;
        attribution?: Record<string, string>;
      }) => client.post<AuthSessionDto>('/v1/auth/otp/verify', input, { anonymous: true }),

      logout: (refreshToken: string) =>
        client.post<{ ok: true }>('/v1/auth/logout', { refreshToken }, { anonymous: true }),

      me: () => client.get<ViewerDto>('/v1/auth/me'),
    },

    discovery: {
      home: (input: {
        latitude?: number;
        longitude?: number;
        cityId?: string;
        radiusMeters?: number;
      }) => client.get<DiscoveryHomeDto>('/v1/discovery/home', { query: input }),

      search: (input: Partial<SearchOffersQueryDto>) =>
        client.get<OfferCardPageDto>('/v1/discovery/search', {
          query: input as Record<string, string | number | boolean | string[] | undefined>,
        }),

      map: (input: {
        bounds: {
          minLatitude: number;
          minLongitude: number;
          maxLatitude: number;
          maxLongitude: number;
        };
        categoryIds?: string[];
        freeOnly?: boolean;
        maxPrice?: number;
        limit?: number;
      }) => client.post<MapOffersResponseDto>('/v1/discovery/map', input),
    },

    offers: {
      detail: (offerId: string) => client.get<OfferDetailDto>(`/v1/offers/${offerId}`),

      availability: (offerId: string, days = 14) =>
        client.get<AvailabilityResponseDto>(`/v1/offers/${offerId}/availability`, {
          query: { days },
        }),
    },

    bookings: {
      /**
       * The idempotency key is required by the API. Generated by the caller and
       * kept stable across retries of the *same* user intent.
       */
      create: (
        input: { slotId: string; attribution?: Record<string, string> },
        idempotencyKey: string,
      ) =>
        client.post<{
          reservationId: string;
          status: string;
          requiresPayment: boolean;
          clientSecret: string | null;
        }>('/v1/bookings', input, { idempotencyKey }),

      list: (scope: 'UPCOMING' | 'PAST' | 'ALL' = 'UPCOMING', cursor?: string) =>
        client.get<BookingPageDto>('/v1/bookings', { query: { scope, cursor } }),

      detail: (bookingId: string) => client.get<BookingDto>(`/v1/bookings/${bookingId}`),

      cancel: (bookingId: string, reason?: string) =>
        client.post<{ refunded: boolean }>(`/v1/bookings/${bookingId}/cancel`, { reason }),
    },

    notifications: {
      list: (unreadOnly = false) =>
        client.get<{ items: NotificationDto[]; unreadCount: number }>('/v1/notifications', {
          query: { unreadOnly: unreadOnly ? 'true' : undefined },
        }),

      markRead: (notificationId: string) =>
        client.post<{ ok: boolean }>(`/v1/notifications/${notificationId}/read`, {}),

      markAllRead: () => client.post<{ updated: number }>('/v1/notifications/read-all', {}),
    },

    checkIns: {
      validate: (input: {
        venueId: string;
        qrToken?: string;
        shortCode?: string;
        override?: boolean;
        overrideReason?: string;
      }) => client.post<CheckInResultDto>('/v1/checkins', input),
    },

    business: {
      get: (businessId: string) =>
        client.get<BusinessDetailDto>(`/v1/businesses/${businessId}`),

      update: (businessId: string, input: UpdateBusinessInput) =>
        client.patch<BusinessDetailDto>(`/v1/businesses/${businessId}`, input),

      metrics: (input: { businessId: string; venueId?: string; from: string; to: string }) =>
        client.get<BusinessMetricsDto>(`/v1/businesses/${input.businessId}/metrics`, {
          query: { venueId: input.venueId, from: input.from, to: input.to },
        }),

      bookings: (input: { businessId: string; venueId?: string; date?: string }) =>
        client.get<{ items: BusinessBookingDto[]; nextCursor: string | null }>(
          `/v1/businesses/${input.businessId}/bookings`,
          { query: { venueId: input.venueId, date: input.date } },
        ),

      leads: (input: { businessId: string; status?: string; venueId?: string }) =>
        client.get<{ items: LeadDto[]; nextCursor: string | null }>(
          `/v1/businesses/${input.businessId}/leads`,
          { query: { status: input.status, venueId: input.venueId } },
        ),

      updateLead: (
        businessId: string,
        leadId: string,
        input: { status?: string; notes?: string | null; attributedRevenueAmount?: number | null },
      ) => client.patch<LeadDto>(`/v1/businesses/${businessId}/leads/${leadId}`, input),

      venues: (businessId: string) =>
        client.get<{ items: BusinessVenueDto[] }>(`/v1/businesses/${businessId}/venues`),

      updateVenue: (venueId: string, input: Partial<UpdateVenueDto>) =>
        client.patch<BusinessVenueDto>(`/v1/venues/${venueId}`, input),

      withdrawVenue: (venueId: string) =>
        client.post<{ status: 'DRAFT' }>(`/v1/venues/${venueId}/withdraw`, {}),

      offers: (businessId: string) =>
        client.get<{ items: BusinessOfferDto[] }>(`/v1/businesses/${businessId}/offers`),

      updateOffer: (offerId: string, input: Partial<UpdateOfferDto>) =>
        client.patch<BusinessOfferDto>(`/v1/offers/${offerId}`, input),

      withdrawOffer: (offerId: string) =>
        client.post<{ status: 'DRAFT' }>(`/v1/offers/${offerId}/withdraw`, {}),

      slots: (businessId: string, days = 7) =>
        client.get<{ items: BusinessSlotDto[] }>(`/v1/businesses/${businessId}/slots`, {
          query: { days: String(days) },
        }),

      setOfferPaused: (offerId: string, paused: boolean) =>
        client.post<{ ok: true }>(`/v1/offers/${offerId}/pause`, { paused }),

      cancelSlot: (slotId: string, reason: string) =>
        client.post<{ affectedReservations: number }>(`/v1/slots/${slotId}/cancel`, { reason }),

      venueImages: (venueId: string) =>
        client.get<{ items: { id: string; url: string; width: number; height: number }[] }>(
          `/v1/venues/${venueId}/images`,
        ),

      uploadVenueImage: (venueId: string, file: Blob, contentType: string) =>
        client.postBinary<{ id: string; url: string }>(`/v1/venues/${venueId}/images`, file, contentType),

      deleteVenueImage: (venueId: string, imageId: string) =>
        client.delete<void>(`/v1/venues/${venueId}/images/${imageId}`),

      offerImages: (offerId: string) =>
        client.get<{ items: { id: string; url: string; width: number; height: number }[] }>(
          `/v1/offers/${offerId}/images`,
        ),

      uploadOfferImage: (offerId: string, file: Blob, contentType: string) =>
        client.postBinary<{ id: string; url: string }>(`/v1/offers/${offerId}/images`, file, contentType),

      deleteOfferImage: (offerId: string, imageId: string) =>
        client.delete<void>(`/v1/offers/${offerId}/images/${imageId}`),
    },

    admin: {
      payments: (input: AdminPaymentsQuery = {}) =>
        client.get<{ items: AdminPaymentDto[]; nextCursor: string | null; total: number }>(
          '/v1/admin/payments',
          { query: { status: input.status, cursor: input.cursor, limit: input.limit ?? 50 } },
        ),
    },
  };
}

export type TryApi = ReturnType<typeof createEndpoints>;
