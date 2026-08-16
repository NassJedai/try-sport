'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, queryKeys } from '@try/api-client';
import { formatTimeInZone } from '@try/utils';
import { api } from '@/lib/api';

/**
 * The front-desk view: who is arriving, and the control to check them in.
 *
 * Check-in is the moment a booked trial becomes an attended one, which is the
 * metric the venue is actually buying — so it is one action, on the same screen,
 * not buried in a sub-page.
 */
export function TodayBookings({ businessId }: { businessId: string }) {
  const queryClient = useQueryClient();
  const [code, setCode] = useState('');
  const [venueId, setVenueId] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<{ tone: 'ok' | 'error'; message: string } | null>(null);
  const setSelectedVenueId = setVenueId;

  const filters = { date: new Date().toISOString().slice(0, 10) };

  const { data, isLoading } = useQuery({
    queryKey: queryKeys.business.bookings(businessId, filters),
    queryFn: () => api.business.bookings({ businessId, ...filters }),
  });

  const checkIn = useMutation({
    mutationFn: (input: { venueId: string; shortCode: string }) =>
      api.checkIns.validate({ venueId: input.venueId, shortCode: input.shortCode }),
    onSuccess: (result) => {
      setFeedback({
        tone: 'ok',
        message: `${result.attendee.firstName} est enregistré·e${
          result.attendee.isFirstVisit ? ' — première visite' : ''
        }.`,
      });
      setCode('');
      void queryClient.invalidateQueries({ queryKey: queryKeys.business.all });
    },
    onError: (error) => {
      // The API distinguishes wrong-venue, outside-window and already-used, and
      // staff need that distinction to act — so the message is passed through.
      setFeedback({
        tone: 'error',
        message: error instanceof ApiError ? error.message : 'Ce code n’a pas pu être validé.',
      });
    },
  });

  const bookings = data?.items ?? [];

  // Distinct venues represented in today's list; a chain may run several.
  const venues = Array.from(
    new Map(bookings.map((booking) => [booking.venueId, { id: booking.venueId, name: booking.venueName }])).values(),
  );
  const selectedVenueId = venueId ?? venues[0]?.id ?? null;

  return (
    <section className="mt-8" aria-label="Réservations du jour">
      <h2 className="mb-4 text-xl font-semibold">Aujourd’hui</h2>

      {feedback && (
        <p
          role="status"
          className={`mb-4 rounded-card p-3 text-sm font-medium ${
            feedback.tone === 'ok'
              ? 'bg-success-subtle text-success'
              : 'bg-danger-subtle text-danger'
          }`}
        >
          {feedback.message}
        </p>
      )}

      {isLoading ? (
        <div className="space-y-2" aria-hidden>
          <div className="h-16 animate-pulse rounded-card bg-surface-muted" />
          <div className="h-16 animate-pulse rounded-card bg-surface-muted" />
        </div>
      ) : bookings.length === 0 ? (
        <p className="rounded-card bg-surface p-6 text-ink-500">
          Aucune séance prévue aujourd’hui.
        </p>
      ) : (
        <div className="overflow-hidden rounded-card bg-surface shadow-sm">
          <table className="w-full text-left text-sm">
            <caption className="sr-only">Réservations du jour avec leur statut de check-in</caption>
            <thead className="bg-surface-muted text-xs uppercase tracking-wide text-ink-400">
              <tr>
                <th scope="col" className="px-4 py-3">Heure</th>
                <th scope="col" className="px-4 py-3">Participant</th>
                <th scope="col" className="px-4 py-3">Offre</th>
                <th scope="col" className="px-4 py-3">Code</th>
                <th scope="col" className="px-4 py-3">Statut</th>
              </tr>
            </thead>
            <tbody>
              {bookings.map((booking) => (
                <tr key={booking.id} className="border-t border-border">
                  <td className="px-4 py-3 font-medium tabular-nums">
                    {formatTimeInZone(new Date(booking.slotStartAt), 'Europe/Brussels')}
                  </td>
                  <td className="px-4 py-3">
                    {booking.attendeeFirstName}
                    {booking.isFirstVisit && (
                      <span className="ml-2 rounded-pill bg-accent-subtle px-2 py-0.5 text-xs font-semibold text-accent">
                        1re visite
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-ink-500">{booking.offerTitle}</td>
                  <td className="px-4 py-3 font-mono text-xs">{booking.shortCode}</td>
                  <td className="px-4 py-3">
                    {booking.checkedInAt ? (
                      <span className="font-semibold text-success">Enregistré</span>
                    ) : (
                      <span className="text-ink-400">En attente</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <form
        className="mt-4 flex flex-wrap gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (!selectedVenueId) {
            setFeedback({ tone: 'error', message: 'Choisis d’abord un lieu.' });
            return;
          }
          checkIn.mutate({ venueId: selectedVenueId, shortCode: code });
        }}
      >
        {/* Check-in is always venue-scoped: the API rejects a code that belongs
            to another location, so the desk must say which door it is. */}
        {venues.length > 1 && (
          <>
            <label htmlFor="checkin-venue" className="sr-only">
              Lieu
            </label>
            <select
              id="checkin-venue"
              value={selectedVenueId ?? ''}
              onChange={(event) => setSelectedVenueId(event.target.value)}
              className="min-h-11 rounded-card border border-border bg-surface px-3"
            >
              {venues.map((venue) => (
                <option key={venue.id} value={venue.id}>
                  {venue.name}
                </option>
              ))}
            </select>
          </>
        )}

        <label htmlFor="checkin-code" className="sr-only">
          Code de check-in
        </label>
        <input
          id="checkin-code"
          value={code}
          onChange={(event) => setCode(event.target.value.toUpperCase())}
          placeholder="K7QP-3XN9"
          autoComplete="off"
          className="min-h-11 flex-1 rounded-card border border-border bg-surface px-4 font-mono uppercase"
        />
        <button
          type="submit"
          disabled={code.length < 8 || checkIn.isPending}
          className="min-h-11 rounded-card bg-accent px-6 font-semibold text-white disabled:opacity-50"
        >
          {checkIn.isPending ? 'Validation…' : 'Valider le code'}
        </button>
      </form>
    </section>
  );
}
