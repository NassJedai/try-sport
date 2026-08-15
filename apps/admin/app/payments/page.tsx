'use client';

import { useQuery } from '@tanstack/react-query';
import { ApiError } from '@try/api-client';
import { formatMoney } from '@try/utils';
import { apiClient } from '@/lib/api';

interface AdminPayment {
  id: string;
  status: string;
  userEmail: string;
  businessName: string;
  amount: { amount: number; currency: 'EUR' };
  platformFee: { amount: number; currency: 'EUR' };
  refunded: { amount: number; currency: 'EUR' };
  providerPaymentIntentId: string | null;
  createdAt: string;
}

export default function AdminPaymentsPage() {
  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['admin', 'payments'],
    queryFn: () => apiClient.get<{ items: AdminPayment[] }>('/v1/admin/payments'),
  });

  return (
    <main className="mx-auto max-w-6xl p-6 lg:p-10">
      <a href="/" className="text-sm text-ink-500 underline">← Vue d’ensemble</a>
      <h1 className="mt-2 text-3xl font-bold">Paiements</h1>
      <p className="mt-1 text-ink-500">
        Montants encaissés, commission TRY et remboursements. L’identifiant Stripe permet de
        retrouver la transaction dans leur dashboard.
      </p>

      {isError ? (
        <p role="alert" className="mt-6 rounded-[--radius-card] bg-danger-subtle p-4 text-danger">
          {error instanceof ApiError ? error.message : 'Chargement impossible.'}
        </p>
      ) : (
        <div className="mt-6 overflow-x-auto rounded-[--radius-card] bg-surface shadow-sm">
          <table className="w-full min-w-[760px] text-left text-sm">
            <caption className="sr-only">Derniers paiements</caption>
            <thead className="bg-surface-muted text-xs uppercase tracking-wide text-ink-400">
              <tr>
                <th scope="col" className="px-4 py-3">Client</th>
                <th scope="col" className="px-4 py-3">Établissement</th>
                <th scope="col" className="px-4 py-3">Montant</th>
                <th scope="col" className="px-4 py-3">Commission</th>
                <th scope="col" className="px-4 py-3">Remboursé</th>
                <th scope="col" className="px-4 py-3">Statut</th>
                <th scope="col" className="px-4 py-3">Stripe</th>
              </tr>
            </thead>
            <tbody>
              {isLoading ? (
                <tr><td colSpan={7} className="px-4 py-6 text-ink-400">Chargement…</td></tr>
              ) : (data?.items.length ?? 0) === 0 ? (
                <tr>
                  <td colSpan={7} className="px-4 py-6 text-ink-400">
                    Aucun paiement pour l’instant — normal tant que Stripe n’est pas branché en
                    mode test.
                  </td>
                </tr>
              ) : (
                data?.items.map((payment) => (
                  <tr key={payment.id} className="border-t border-border">
                    <td className="px-4 py-3">{payment.userEmail}</td>
                    <td className="px-4 py-3">{payment.businessName}</td>
                    <td className="px-4 py-3 tabular-nums font-medium">
                      {formatMoney(payment.amount, { compactWholeAmounts: true })}
                    </td>
                    <td className="px-4 py-3 tabular-nums text-ink-500">
                      {formatMoney(payment.platformFee, { compactWholeAmounts: true })}
                    </td>
                    <td className="px-4 py-3 tabular-nums text-ink-500">
                      {payment.refunded.amount > 0
                        ? formatMoney(payment.refunded, { compactWholeAmounts: true })
                        : '—'}
                    </td>
                    <td className="px-4 py-3 text-xs font-semibold text-ink-500">{payment.status}</td>
                    <td className="px-4 py-3 font-mono text-xs text-ink-400">
                      {payment.providerPaymentIntentId ?? '—'}
                    </td>
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
