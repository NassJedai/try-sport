'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError } from '@try/api-client';
import { apiClient } from '@/lib/api';

interface QueueItem {
  id: string;
  kind: 'venue' | 'offer';
  name: string;
  businessName: string;
  cityName: string | null;
  submittedAt: string;
}

/**
 * File de modération.
 *
 * Tout ce qui atteint un consommateur passe par ici. L'interface n'autorise
 * rien par elle-même : chaque décision est revalidée côté API par la machine à
 * états de modération et le rôle admin, puis auditée dans la même transaction.
 */
export default function ModerationPage() {
  const queryClient = useQueryClient();
  const [feedback, setFeedback] = useState<string | null>(null);

  const queue = useQuery({
    queryKey: ['admin', 'moderation', 'queue'],
    queryFn: () => apiClient.get<{ items: QueueItem[] }>('/v1/admin/moderation/queue'),
  });

  const decide = useMutation({
    mutationFn: (input: {
      item: QueueItem;
      decision: 'APPROVE' | 'REJECT';
      reason?: string;
    }) =>
      apiClient.post<{ status: string }>(
        `/v1/admin/${input.item.kind === 'venue' ? 'venues' : 'offers'}/${input.item.id}/decision`,
        { decision: input.decision, reason: input.reason },
      ),
    onSuccess: (result, variables) => {
      setFeedback(
        `${variables.item.kind === 'venue' ? 'Lieu' : 'Offre'} « ${variables.item.name} » → ${result.status}`,
      );
      void queryClient.invalidateQueries({ queryKey: ['admin', 'moderation'] });
    },
    onError: (error) => {
      setFeedback(error instanceof ApiError ? error.message : 'La décision a échoué.');
    },
  });

  const handleReject = (item: QueueItem) => {
    // Une raison actionnable est exigée par l'API (minimum 10 caractères).
    const reason = window.prompt(
      `Raison du refus de « ${item.name} » ?\nElle sera transmise à l'établissement.`,
    );
    if (!reason) return;
    decide.mutate({ item, decision: 'REJECT', reason });
  };

  const items = queue.data?.items ?? [];

  return (
    <main className="mx-auto max-w-5xl p-6 lg:p-10">
      <a href="/" className="text-sm text-ink-500 underline">
        ← Vue d’ensemble
      </a>
      <h1 className="mt-2 text-3xl font-bold">Modération</h1>
      <p className="mt-1 text-ink-500">
        Lieux et offres soumis par les établissements, du plus ancien au plus récent.
      </p>

      {feedback && (
        <p role="status" className="mt-4 rounded-card bg-accent-subtle p-3 text-sm font-medium">
          {feedback}
        </p>
      )}

      {queue.isLoading ? (
        <div className="mt-6 space-y-2" aria-hidden>
          <div className="h-20 animate-pulse rounded-card bg-surface-muted" />
          <div className="h-20 animate-pulse rounded-card bg-surface-muted" />
        </div>
      ) : queue.isError ? (
        <p role="alert" className="mt-6 rounded-card bg-danger-subtle p-4 text-danger">
          {queue.error instanceof ApiError ? queue.error.message : 'Chargement impossible.'}
        </p>
      ) : items.length === 0 ? (
        <p className="mt-6 rounded-card bg-surface p-6 text-ink-500">
          Rien en attente. Les nouvelles soumissions apparaîtront ici.
        </p>
      ) : (
        <ul className="mt-6 space-y-3">
          {items.map((item) => (
            <li
              key={`${item.kind}-${item.id}`}
              className="flex flex-wrap items-center justify-between gap-4 rounded-card bg-surface p-5 shadow-sm"
            >
              <div>
                <span className="mr-2 rounded-pill bg-surface-muted px-2 py-0.5 text-xs font-semibold uppercase tracking-wide text-ink-500">
                  {item.kind === 'venue' ? 'Lieu' : 'Offre'}
                </span>
                <span className="font-semibold">{item.name}</span>
                <p className="mt-1 text-sm text-ink-500">
                  {item.businessName}
                  {item.cityName ? ` · ${item.cityName}` : ''} · soumis le{' '}
                  {new Date(item.submittedAt).toLocaleDateString('fr-BE')}
                </p>
              </div>

              <div className="flex gap-2">
                <button
                  type="button"
                  disabled={decide.isPending}
                  onClick={() => decide.mutate({ item, decision: 'APPROVE' })}
                  className="min-h-11 rounded-card bg-accent px-4 font-semibold text-white disabled:opacity-50"
                >
                  Approuver
                </button>
                <button
                  type="button"
                  disabled={decide.isPending}
                  onClick={() => handleReject(item)}
                  className="min-h-11 rounded-card border border-border px-4 font-semibold text-danger disabled:opacity-50"
                >
                  Refuser
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
