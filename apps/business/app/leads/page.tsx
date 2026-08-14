'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { queryKeys } from '@try/api-client';
import type { LeadStatus } from '@try/contracts';
import { formatMoney } from '@try/utils';
import { api } from '@/lib/api';
import { useBusinessId } from '@/lib/use-business';

const PIPELINE: { status: LeadStatus; label: string }[] = [
  { status: 'NEW', label: 'Nouveaux' },
  { status: 'ATTENDED', label: 'Venus' },
  { status: 'INTERESTED', label: 'Intéressés' },
  { status: 'CONTACTED', label: 'Contactés' },
  { status: 'CONVERTED', label: 'Convertis' },
  { status: 'LOST', label: 'Perdus' },
];

/**
 * CRM-lite.
 *
 * The pipeline the venue works through after someone has tried them. Deliberately
 * minimal: this is not trying to be a CRM, it is trying to make sure a trial that
 * went well is followed up before the person forgets the session.
 */
export default function LeadsPage() {
  const businessId = useBusinessId();
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<LeadStatus | undefined>(undefined);

  const filters = { status };

  const { data, isLoading } = useQuery({
    queryKey: queryKeys.business.leads(businessId ?? '', filters),
    queryFn: () => api.business.leads({ businessId: businessId as string, status }),
    enabled: Boolean(businessId),
  });

  const update = useMutation({
    mutationFn: (input: { leadId: string; status: LeadStatus; revenue?: number }) =>
      api.business.updateLead(businessId as string, input.leadId, {
        status: input.status,
        attributedRevenueAmount: input.revenue,
      }),
    // Refetch rather than patch: marking CONVERTED also moves the offer's
    // conversion counter server-side, so the client's view is not the whole truth.
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.business.all }),
  });

  if (!businessId) return null;

  const leads = data?.items ?? [];

  return (
    <main className="mx-auto max-w-6xl p-6 lg:p-10">
      <h1 className="text-3xl font-bold">Prospects</h1>
      <p className="mt-1 text-ink-500">
        Les personnes qui ont testé chez toi. Suis-les jusqu’à l’abonnement.
      </p>

      <div className="mt-6 flex flex-wrap gap-2" role="group" aria-label="Filtrer par statut">
        <button
          type="button"
          onClick={() => setStatus(undefined)}
          aria-pressed={status === undefined}
          className={`min-h-11 rounded-[--radius-pill] px-4 text-sm font-semibold ${
            status === undefined ? 'bg-accent text-white' : 'bg-surface-muted text-ink-500'
          }`}
        >
          Tous
        </button>
        {PIPELINE.map((stage) => (
          <button
            key={stage.status}
            type="button"
            onClick={() => setStatus(stage.status)}
            aria-pressed={status === stage.status}
            className={`min-h-11 rounded-[--radius-pill] px-4 text-sm font-semibold ${
              status === stage.status ? 'bg-accent text-white' : 'bg-surface-muted text-ink-500'
            }`}
          >
            {stage.label}
          </button>
        ))}
      </div>

      {isLoading ? (
        <div className="mt-6 space-y-2" aria-hidden>
          <div className="h-20 animate-pulse rounded-[--radius-card] bg-surface-muted" />
          <div className="h-20 animate-pulse rounded-[--radius-card] bg-surface-muted" />
        </div>
      ) : leads.length === 0 ? (
        <p className="mt-6 rounded-[--radius-card] bg-surface p-6 text-ink-500">
          Aucun prospect pour ce filtre. Ils apparaissent ici dès qu’une personne vient à sa séance
          d’essai.
        </p>
      ) : (
        <div className="mt-6 overflow-x-auto rounded-[--radius-card] bg-surface shadow-sm">
          <table className="w-full min-w-[720px] text-left text-sm">
            <caption className="sr-only">Prospects et leur statut dans le pipeline</caption>
            <thead className="bg-surface-muted text-xs uppercase tracking-wide text-ink-400">
              <tr>
                <th scope="col" className="px-4 py-3">Prénom</th>
                <th scope="col" className="px-4 py-3">Activité</th>
                <th scope="col" className="px-4 py-3">Venu le</th>
                <th scope="col" className="px-4 py-3">Intérêt</th>
                <th scope="col" className="px-4 py-3">Revenus</th>
                <th scope="col" className="px-4 py-3">Statut</th>
              </tr>
            </thead>
            <tbody>
              {leads.map((lead) => (
                <tr key={lead.id} className="border-t border-border">
                  <td className="px-4 py-3 font-medium">{lead.firstName}</td>
                  <td className="px-4 py-3 text-ink-500">{lead.offerTitle}</td>
                  <td className="px-4 py-3 tabular-nums text-ink-500">
                    {lead.visitedAt
                      ? new Date(lead.visitedAt).toLocaleDateString('fr-BE')
                      : '—'}
                  </td>
                  <td className="px-4 py-3">
                    {lead.continuation === 'YES' ? (
                      <span className="font-semibold text-success">Oui</span>
                    ) : lead.continuation === 'MAYBE' ? (
                      <span className="text-warning">Peut-être</span>
                    ) : lead.continuation === 'NO' ? (
                      <span className="text-ink-400">Non</span>
                    ) : (
                      <span className="text-ink-400">—</span>
                    )}
                  </td>
                  <td className="px-4 py-3 tabular-nums">
                    {lead.attributedRevenue
                      ? formatMoney(lead.attributedRevenue, { compactWholeAmounts: true })
                      : '—'}
                  </td>
                  <td className="px-4 py-3">
                    <label className="sr-only" htmlFor={`status-${lead.id}`}>
                      Statut de {lead.firstName}
                    </label>
                    <select
                      id={`status-${lead.id}`}
                      value={lead.status}
                      disabled={update.isPending}
                      onChange={(event) =>
                        update.mutate({
                          leadId: lead.id,
                          status: event.target.value as LeadStatus,
                        })
                      }
                      className="min-h-11 rounded-[--radius-card] border border-border bg-surface px-3"
                    >
                      {PIPELINE.map((stage) => (
                        <option key={stage.status} value={stage.status}>
                          {stage.label}
                        </option>
                      ))}
                    </select>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </main>
  );
}
