'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ApiError } from '@try/api-client';
import { RESERVATION_STATUSES, type ReservationStatus } from '@try/contracts';
import { formatDateInZone, formatMoney } from '@try/utils';
import { api } from '@/lib/api';

export default function AdminBookingsPage() {
  const [status, setStatus] = useState<ReservationStatus | undefined>(undefined);

  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['admin', 'bookings', status],
    queryFn: () => api.admin.bookings({ status }),
  });

  return (
    <main className="mx-auto max-w-6xl p-6 lg:p-10">
      <a href="/" className="text-sm text-text-secondary underline">← Vue d’ensemble</a>
      <h1 className="mt-2 text-3xl font-bold">Réservations</h1>

      <div className="mt-4 flex flex-wrap gap-2" role="group" aria-label="Filtrer par statut">
        <button
          type="button"
          onClick={() => setStatus(undefined)}
          aria-pressed={status === undefined}
          className={`min-h-11 rounded-pill px-4 text-sm font-semibold ${status === undefined ? 'bg-accent text-on-accent' : 'bg-surface-muted text-text-secondary'}`}
        >
          Toutes
        </button>
        {RESERVATION_STATUSES.map((value) => (
          <button
            key={value}
            type="button"
            onClick={() => setStatus(value)}
            aria-pressed={status === value}
            className={`min-h-11 rounded-pill px-3 text-xs font-semibold ${status === value ? 'bg-accent text-on-accent' : 'bg-surface-muted text-text-secondary'}`}
          >
            {value}
          </button>
        ))}
      </div>

      {isError ? (
        <p role="alert" className="mt-6 rounded-card bg-danger-subtle p-4 text-danger">
          {error instanceof ApiError ? error.message : 'Chargement impossible.'}
        </p>
      ) : (
        <div className="mt-6 overflow-x-auto rounded-card bg-surface shadow-sm">
          <table className="w-full min-w-[760px] text-left text-sm">
            <caption className="sr-only">Dernières réservations</caption>
            <thead className="bg-surface-muted text-xs uppercase tracking-wide text-text-tertiary">
              <tr>
                <th scope="col" className="px-4 py-3">Client</th>
                <th scope="col" className="px-4 py-3">Offre</th>
                <th scope="col" className="px-4 py-3">Lieu</th>
                <th scope="col" className="px-4 py-3">Séance</th>
                <th scope="col" className="px-4 py-3">Prix</th>
                <th scope="col" className="px-4 py-3">Statut</th>
              </tr>
            </thead>
            <tbody>
              {isLoading ? (
                <tr><td colSpan={6} className="px-4 py-6 text-text-tertiary">Chargement…</td></tr>
              ) : (data?.items.length ?? 0) === 0 ? (
                <tr><td colSpan={6} className="px-4 py-6 text-text-tertiary">Aucune réservation.</td></tr>
              ) : (
                data?.items.map((booking) => (
                  <tr key={booking.id} className="border-t border-border">
                    <td className="px-4 py-3">{booking.userEmail}</td>
                    <td className="px-4 py-3">{booking.offerTitle}</td>
                    <td className="px-4 py-3 text-text-secondary">{booking.venueName}</td>
                    <td className="px-4 py-3 tabular-nums text-text-secondary">
                      {formatDateInZone(new Date(booking.slotStartAt), booking.venueTimeZone, 'fr-BE', {
                        dateStyle: 'short',
                        timeStyle: 'short',
                      })}
                    </td>
                    <td className="px-4 py-3 tabular-nums">
                      {formatMoney(booking.price, { freeLabel: 'Gratuit', compactWholeAmounts: true })}
                    </td>
                    <td className="px-4 py-3 text-xs font-semibold text-text-secondary">{booking.status}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      )}
    </main>
  );
}
