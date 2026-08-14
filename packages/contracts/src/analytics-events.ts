/**
 * The analytics contract. Event names and payloads are typed here so that mobile,
 * web and the API cannot drift apart — a funnel built on free-form strings breaks
 * silently the first time someone renames an event.
 */

export interface AnalyticsEventMap {
  app_opened: { cold_start: boolean };

  onboarding_started: Record<string, never>;
  onboarding_completed: { interest_count: number };

  location_permission_requested: Record<string, never>;
  location_permission_granted: { precise: boolean };
  location_permission_denied: { fallback: 'city' | 'postcode' | 'none' };

  category_selected: { category_slug: string; source: 'onboarding' | 'home' | 'search' };

  search_performed: {
    query_length: number;
    category_count: number;
    has_location: boolean;
    result_count: number;
  };

  offer_impression: { offer_id: string; section: string; position: number };
  offer_viewed: { offer_id: string; venue_id: string; source: string };
  offer_saved: { offer_id: string; saved: boolean };

  booking_started: { offer_id: string; is_free: boolean };
  slot_selected: { offer_id: string; slot_id: string; days_ahead: number };
  payment_started: { offer_id: string; amount_minor: number; currency: string };
  payment_completed: { offer_id: string; amount_minor: number; currency: string };
  booking_completed: { booking_id: string; offer_id: string; is_free: boolean };

  checkin_completed: { booking_id: string; venue_id: string; method: 'qr' | 'code' };

  review_submitted: { booking_id: string; rating: number };
  continuation_answered: { booking_id: string; answer: 'YES' | 'MAYBE' | 'NO' };

  venue_created: { business_id: string; venue_id: string };
  offer_created: { business_id: string; offer_id: string };
  offer_published: { business_id: string; offer_id: string };
  booking_received: { business_id: string; booking_id: string };
  checkin_processed: { business_id: string; booking_id: string };
  lead_contacted: { business_id: string; lead_id: string };
  lead_converted: { business_id: string; lead_id: string; revenue_minor: number };
}

export type AnalyticsEventName = keyof AnalyticsEventMap;

/**
 * The funnel TRY optimises. Ordered, so a drop-off report can be generated
 * mechanically rather than hand-maintained.
 */
export const CORE_FUNNEL: readonly AnalyticsEventName[] = [
  'offer_impression',
  'offer_viewed',
  'booking_started',
  'booking_completed',
  'checkin_completed',
  'review_submitted',
];
