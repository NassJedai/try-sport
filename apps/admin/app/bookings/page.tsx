'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ApiError } from '@try/api-client';
import { formatMoney } from '@try/utils';
import { apiClient } from '@/lib/api';

interface AdminBooking {
  id: string;
  status: string;
  userEmail: string;
  offerTitle: string;
  venueName: string;
  slotStartAt: string;
  price: { amount: number; currency: 'EUR' };
  createdAt: string;
}

const STATUSES = [
  'CONFIRMED', 'CHECKED_IN', 'COMPLETED', 'PAYMENT_PENDING',
  'CANCELLED_USER', 'CANCELLED_BUSINESS', 'NO_SHOW', 'EXPIRED', 'REFUNDED',
] as const;

export default function AdminBookingsPage() {
  const [status, setStatus] = useState<string | undefined>(undefined);

  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['admin', 'bookings', status],
    queryFn: () =>
      apiClient.get<{ items: AdminBooking[] }>('/v1/admin/bookings', { query: { status } }),
  });

  return (
    <main className="mx-auto max-w-6xl p-6 lg:p-10">
      <a href="/" className="text-sm text-ink-500 underline">← Vue d’ensemble</a>
      <h1 className="mt-2 text-3xl font-bold">Réservations</h1>

      <div className="mt-4 flex flex-wrap gap-2" role="group" aria-label="Filtrer par statut">
        <button
          type="button"
          onClick={() => setStatus(undefined)}
          aria-pressed={status === undefined}
          className={`min-h-11 rounded-pill px-4 text-sm font-semibold ${status === undefined ? 'bg-accent text-white' : 'bg-surface-muted text-ink-500'}`}
        >
          Toutes
        </button>
        {STATUSES.map((value) => (
          <button
            key={value}
            type="button"
            onClick={() => setStatus(value)}
            aria-pressed={status === value}
            className={`min-h-11 rounded-pill px-3 text-xs font-semibold ${status === value ? 'bg-accent text-white' : 'bg-surface-muted text-ink-500'}`}
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
            <thead className="bg-surface-muted text-xs uppercase tracking-wide text-ink-400">
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
                <tr><td colSpan={6} className="px-4 py-6 text-ink-400">Chargement…</td></tr>
              ) : (data?.items.length ?? 0) === 0 ? (
                <tr><td colSpan={6} className="px-4 py-6 text-ink-400">Aucune réservation.</td></tr>
              ) : (
                data?.items.map((booking) => (
                  <tr key={booking.id} className="border-t border-border">
                    <td className="px-4 py-3">{booking.userEmail}</td>
                    <td className="px-4 py-3">{booking.offerTitle}</td>
                    <td className="px-4 py-3 text-ink-500">{booking.venueName}</td>
                    <td className="px-4 py-3 tabular-nums text-ink-500">
                      {new Date(booking.slotStartAt).toLocaleString('fr-BE', { dateStyle: 'short', timeStyle: 'short' })}
                    </td>
                    <td className="px-4 py-3 tabular-nums">
                      {formatMoney(booking.price, { freeLabel: 'Gratuit', compactWholeAmounts: true })}
                    </td>
                    <td className="px-4 py-3 text-xs font-semibold text-ink-500">{booking.status}</td>
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
