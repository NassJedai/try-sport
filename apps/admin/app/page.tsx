'use client';

import { useQuery } from '@tanstack/react-query';
import { queryKeys } from '@try/api-client';
import { api } from '@/lib/api';

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
        <p className="mt-2 text-ink-500">
          Cette console est réservée à l’équipe TRY. Connecte-toi avec un compte administrateur.
        </p>
        <a
          href="/sign-in"
          className="mt-6 inline-block rounded-[--radius-card] bg-accent px-5 py-3 font-semibold text-white"
        >
          Se connecter
        </a>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-6xl p-6 lg:p-10">
      <h1 className="text-3xl font-bold">Vue d’ensemble</h1>
      <p className="mt-1 text-ink-500">Santé de la marketplace, modération et métriques.</p>

      <nav className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-3" aria-label="Sections">
        {[
          { href: '/moderation', title: 'Modération', body: 'Valider les lieux et les offres soumis.' },
          { href: '/businesses', title: 'Établissements', body: 'Comptes, venues et statuts.' },
          { href: '/bookings', title: 'Réservations', body: 'Suivi des essais et des paiements.' },
          { href: '/audit', title: 'Journal d’audit', body: 'Chaque action privilégiée, horodatée.' },
        ].map((section) => (
          <a
            key={section.href}
            href={section.href}
            className="rounded-[--radius-card] bg-surface p-5 shadow-sm transition hover:shadow-md"
          >
            <h2 className="text-lg font-semibold">{section.title}</h2>
            <p className="mt-1 text-sm text-ink-500">{section.body}</p>
          </a>
        ))}
      </nav>

      <p className="mt-10 rounded-[--radius-card] bg-warning-subtle p-4 text-sm text-warning">
        Les métriques agrégées (MAU, GMV, taux de conversion plateforme) sont exposées par
        l’endpoint admin dédié, qui n’est pas encore implémenté — voir PROJECT_PLAN.md §11.
      </p>
    </main>
  );
}
