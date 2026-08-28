import type {
  AdminBookingDto,
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
  OfferStatus,
  ReservationStatus,
  SearchOffersQueryDto,
  UpdateOfferDto,
  UpdateVenueDto,
  VenueStatus,
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
 * Réponse de `GET /v1/admin/venues`.
 *
 * Même situation que `AdminPaymentDto` ci-dessus : pas de DTO dans
 * `@try/contracts`, à synchroniser à la main avec le type de retour de
 * `AdminBrowseService.venues()`
 * (`apps/api/src/modules/admin/admin-browse.service.ts`). Signalé à
 * `contracts-guardian` — cette forme n'est pas encore canonisée.
 *
 * Route ajoutée le 2026-08-27 : jusque-là, la console admin n'avait aucun
 * moyen de trouver un lieu autrement qu'en connaissant déjà son UUID.
 */
export interface AdminVenueDto {
  id: string;
  name: string;
  status: string;
  businessId: string;
  businessName: string;
  cityName: string | null;
  createdAt: string;
}

/**
 * Corps de la requête `GET /v1/admin/venues` — voir `venuesQuerySchema` dans
 * `apps/api/src/modules/admin/admin-browse.controller.ts`. `q` cherche dans
 * le nom du lieu ou celui de l'établissement ; `status` est un statut exact
 * de `VenueStatus`.
 */
export interface AdminVenuesQuery {
  q?: string;
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
          /**
           * Stripe-hosted checkout page to open in the phone's browser (e.g.
           * with `expo-web-browser`'s `openAuthSessionAsync`, which is built
           * for exactly this "open browser, wait for a deep-link redirect"
           * shape). Null for a free booking. The webhook — not this response,
           * and not whatever the browser redirects back to — is the source of
           * truth for whether the booking actually confirmed; always re-check
           * via `bookings.detail` rather than trusting a successful redirect.
           */
          checkoutUrl: string | null;
        }>('/v1/bookings', input, { idempotencyKey }),

      list: (scope: 'UPCOMING' | 'PAST' | 'ALL' = 'UPCOMING', cursor?: string) =>
        client.get<BookingPageDto>('/v1/bookings', { query: { scope, cursor } }),

      detail: (bookingId: string) => client.get<BookingDto>(`/v1/bookings/${bookingId}`),

      cancel: (bookingId: string, reason?: string) =>
        client.post<{ refunded: boolean }>(`/v1/bookings/${bookingId}/cancel`, { reason }),

      /**
       * Business staff action — the caller must be a member of the
       * reservation's own business, enforced server-side. Nothing to send but
       * the id: which status it must start from, and the allowed time window,
       * are both resolved by the API (`apps/api/src/modules/bookings/booking.service.ts`,
       * `markNoShow`).
       */
      markNoShow: (bookingId: string) =>
        client.post<{ reservationId: string; status: 'NO_SHOW' }>(
          `/v1/bookings/${bookingId}/no-show`,
          {},
        ),
    },

    notifications: {
      /**
       * `unreadOnly` reste un premier paramètre positionnel, pas un objet : les
       * deux appelants mobile (`apps/mobile/app/notifications.tsx`,
       * `NotificationBell.tsx`) l'appellent déjà `list()` / `list(true)`, et
       * cette signature doit rester valable sans les toucher.
       *
       * `pagination.cursor`/`pagination.limit` reprennent les mêmes noms que
       * `admin.payments()` et `admin.venues()` ci-dessous — même curseur
       * d'ensemble ordonné, pas un numéro de page — pour que la console admin
       * (`apps/admin/app/notifications/page.tsx`, « Charger plus ») consomme
       * cette liste comme elle consomme déjà celles-là.
       *
       * `nextCursor`/`total` dans la réponse suivent le même motif — et
       * suivent la forme exacte de `PaginatedNotificationListDto`
       * (`apps/api/src/modules/notifications/notification.controller.ts`,
       * livrée en parallèle de ce client). Le type reste redéclaré ici plutôt
       * qu'importé : comme `AdminPaymentDto`/`AdminVenueDto` ci-dessus, cette
       * forme n'existe pas encore dans `@try/contracts`
       * (`notificationListSchema` n'a toujours que `items`/`unreadCount`) et
       * se synchronise à la main en attendant.
       */
      list: (unreadOnly = false, pagination?: { cursor?: string; limit?: number }) =>
        client.get<{
          items: NotificationDto[];
          unreadCount: number;
          nextCursor: string | null;
          total: number;
        }>('/v1/notifications', {
          query: {
            unreadOnly: unreadOnly ? 'true' : undefined,
            cursor: pagination?.cursor,
            limit: pagination?.limit,
          },
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

      bookings: (input: { status?: ReservationStatus; limit?: number } = {}) =>
        client.get<{ items: AdminBookingDto[] }>('/v1/admin/bookings', {
          query: { status: input.status, limit: input.limit },
        }),

      venues: (input: AdminVenuesQuery = {}) =>
        client.get<{ items: AdminVenueDto[]; nextCursor: string | null; total: number }>(
          '/v1/admin/venues',
          {
            query: {
              q: input.q,
              status: input.status,
              cursor: input.cursor,
              limit: input.limit ?? 50,
            },
          },
        ),

      /**
       * `decision` couvre `APPROVE`/`REJECT` (déjà utilisés par la file de
       * modération) et `SUSPEND`/`REINSTATE` — un lieu déjà actif que la
       * plateforme retire ou réintègre. `reason` est ignoré par le serveur pour
       * `REINSTATE`, et exigé (≥ `REJECTION_REASON_MIN_LENGTH`) pour `REJECT` et
       * `SUSPEND` — voir `OnboardingService.assertRejectionReason`.
       */
      decideVenue: (
        venueId: string,
        input: { decision: 'APPROVE' | 'REJECT' | 'SUSPEND' | 'REINSTATE'; reason?: string },
      ) => client.post<{ status: VenueStatus }>(`/v1/admin/venues/${venueId}/decision`, input),

      /** Même route que la file de modération ; `PAUSE` retire une offre déjà active de la découverte. */
      decideOffer: (
        offerId: string,
        input: { decision: 'APPROVE' | 'REJECT' | 'PAUSE'; reason?: string },
      ) => client.post<{ status: OfferStatus }>(`/v1/admin/offers/${offerId}/decision`, input),
    },
  };
}

export type TryApi = ReturnType<typeof createEndpoints>;
