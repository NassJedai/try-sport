'use client';

import { useQuery } from '@tanstack/react-query';
import { ApiError, type AdminPaymentDto } from '@try/api-client';
import { formatMoney, type CurrencyCode } from '@try/utils';
import { api } from '@/lib/api';

/**
 * `AdminPaymentDto` porte `currency` en `string` brut (pas encore un DTO
 * `@try/contracts`, voir le commentaire sur l'interface). `formatMoney` exige
 * un `CurrencyCode` littéral : ce cast borné à l'affichage rejoint les mêmes
 * casts déjà faits côté API (`row.currency as CurrencyCode`), il ne décide de
 * rien — la devise vient telle quelle de la base.
 */
function toMoney(value: { amount: number; currency: string }) {
  return { amount: value.amount, currency: value.currency as CurrencyCode };
}

export default function AdminPaymentsPage() {
  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['admin', 'payments'],
    queryFn: () => api.admin.payments(),
  });

  return (
    <main className="mx-auto max-w-6xl p-6 lg:p-10">
      <a href="/" className="text-sm text-text-secondary underline">← Vue d’ensemble</a>
      <h1 className="mt-2 text-3xl font-bold">Paiements</h1>
      <p className="mt-1 text-text-secondary">
        Montants encaissés, commission TRIALYA nette des remboursements, et remboursements.
        L’identifiant Stripe permet de retrouver la transaction dans leur dashboard.
      </p>

      {isError ? (
        <p role="alert" className="mt-6 rounded-card bg-danger-subtle p-4 text-danger">
          {error instanceof ApiError ? error.message : 'Chargement impossible.'}
        </p>
      ) : (
        <div className="mt-6 overflow-x-auto rounded-card bg-surface shadow-sm">
          <table className="w-full min-w-[760px] text-left text-sm">
            <caption className="sr-only">Derniers paiements</caption>
            <thead className="bg-surface-muted text-xs uppercase tracking-wide text-text-tertiary">
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
                <tr><td colSpan={7} className="px-4 py-6 text-text-tertiary">Chargement…</td></tr>
              ) : (data?.items.length ?? 0) === 0 ? (
                <tr>
                  <td colSpan={7} className="px-4 py-6 text-text-tertiary">
                    Aucun paiement enregistré pour l’instant.
                  </td>
                </tr>
              ) : (
                data?.items.map((payment: AdminPaymentDto) => (
                  <tr key={payment.id} className="border-t border-border">
                    <td className="px-4 py-3">{payment.userEmail}</td>
                    <td className="px-4 py-3">{payment.businessName}</td>
                    <td className="px-4 py-3 tabular-nums font-medium">
                      {formatMoney(toMoney(payment.amount), { compactWholeAmounts: true })}
                    </td>
                    <td className="px-4 py-3 tabular-nums">
                      <div className="font-medium">
                        {payment.netPlatformFee === null
                          ? '—'
                          : formatMoney(toMoney(payment.netPlatformFee), { compactWholeAmounts: true })}
                      </div>
                      <div
                        className={`text-xs text-text-tertiary ${
                          payment.netPlatformFee === null ? 'line-through' : ''
                        }`}
                      >
                        brut : {formatMoney(toMoney(payment.platformFee), { compactWholeAmounts: true })}
                      </div>
                    </td>
                    <td className="px-4 py-3 tabular-nums text-text-secondary">
                      {payment.refunded.amount > 0
                        ? formatMoney(toMoney(payment.refunded), { compactWholeAmounts: true })
                        : '—'}
                    </td>
                    <td className="px-4 py-3 text-xs font-semibold text-text-secondary">{payment.status}</td>
                    <td className="px-4 py-3 font-mono text-xs text-text-tertiary">
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
