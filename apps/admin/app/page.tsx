'use client';

import { useQuery } from '@tanstack/react-query';
import { queryKeys } from '@try/api-client';
import { api, apiClient } from '@/lib/api';

/**
 * Admin overview.
 *
 * Every number here is read-only and every moderation action is audited on the
 * server. Nothing on this page is authorised by the page itself: the API checks
 * the ADMIN role on each request, because a client-side role check is decoration,
 * not security.
 */
export default function AdminOverviewPage() {
  const { data, isLoading, isError } = useQuery({
    queryKey: queryKeys.viewer,
    queryFn: () => api.auth.me(),
    retry: false,
  });

  const isAdmin = data?.roles.includes('ADMIN') || data?.roles.includes('SUPER_ADMIN');

  if (isLoading) {
    return (
      <main className="mx-auto max-w-5xl p-10">
        <div className="h-10 w-64 animate-pulse rounded bg-surface-muted" aria-hidden />
      </main>
    );
  }

  if (isError || !isAdmin) {
    return (
      <main className="mx-auto max-w-md p-10 text-center">
        <h1 className="text-2xl font-bold">Accès restreint</h1>
        <p className="mt-2 text-text-secondary">
          Cette console est réservée à l’équipe TRY. Connecte-toi avec un compte administrateur.
        </p>
        <a
          href="/sign-in"
          className="mt-6 inline-block rounded-card bg-accent px-5 py-3 font-semibold text-on-accent"
        >
          Se connecter
        </a>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-6xl p-6 lg:p-10">
      <h1 className="text-3xl font-bold">Vue d’ensemble</h1>
      <p className="mt-1 text-text-secondary">Santé de la marketplace, modération et métriques.</p>

      <OverviewMetrics />

      <nav className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-4" aria-label="Sections">
        {[
          { href: '/moderation', title: 'Modération', body: 'Valider les lieux et les offres soumis.' },
          { href: '/users', title: 'Utilisateurs', body: 'Recherche par e-mail pour le support.' },
          { href: '/bookings', title: 'Réservations', body: 'Dernières réservations, par statut.' },
          { href: '/payments', title: 'Paiements', body: 'Encaissements, commission, remboursements.' },
        ].map((section) => (
          <a
            key={section.href}
            href={section.href}
            className="rounded-card bg-surface p-5 shadow-sm transition hover:shadow-md"
          >
            <h2 className="text-lg font-semibold">{section.title}</h2>
            <p className="mt-1 text-sm text-text-secondary">{section.body}</p>
          </a>
        ))}
      </nav>
    </main>
  );
}

/** Les chiffres de santé de la marketplace, calculés en direct par l'API. */
function OverviewMetrics() {
  const { data, isLoading } = useQuery({
    queryKey: ['admin', 'overview'],
    queryFn: () => apiClient.get<Record<string, number>>('/v1/admin/overview'),
  });

  const tiles: { label: string; value: string | undefined }[] = [
    { label: 'Utilisateurs', value: data?.users?.toString() },
    { label: 'Actifs 30 j', value: data?.monthly_active_users?.toString() },
    { label: 'Lieux actifs', value: data?.active_venues?.toString() },
    { label: 'Offres actives', value: data?.active_offers?.toString() },
    {
      label: 'En modération',
      value: data ? String((data.venues_pending ?? 0) + (data.offers_pending ?? 0)) : undefined,
    },
    { label: 'Réservations', value: data?.bookings?.toString() },
    { label: 'Essais complétés', value: data?.completed_trials?.toString() },
    { label: 'Conversions', value: data?.conversions?.toString() },
  ];

  return (
    <section aria-label="Métriques" className="mt-8 grid grid-cols-2 gap-4 sm:grid-cols-4">
      {tiles.map((tile) => (
        <div key={tile.label} className="rounded-card bg-surface p-4 shadow-sm">
          <p className="text-xs font-semibold uppercase tracking-wide text-text-tertiary">{tile.label}</p>
          {isLoading ? (
            <div className="mt-2 h-8 w-16 animate-pulse rounded bg-surface-muted" aria-hidden />
          ) : (
            <p className="mt-1 text-3xl font-bold tabular-nums">{tile.value ?? '—'}</p>
          )}
        </div>
      ))}
    </section>
  );
}
