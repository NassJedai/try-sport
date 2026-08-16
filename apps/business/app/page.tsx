'use client';

import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { queryKeys } from '@try/api-client';
import { formatMoney } from '@try/utils';
import { api } from '@/lib/api';
import { useBusinessId } from '@/lib/use-business';
import { MetricCard } from '@/components/metric-card';
import { TodayBookings } from '@/components/today-bookings';

/**
 * The business dashboard.
 *
 * It answers one question: are the trials TRY sends turning into customers?
 * Booking volume alone is vanity — attendance and conversion are what the venue
 * is paying for, so they lead.
 */
export default function DashboardPage() {
  const businessId = useBusinessId();
  const [days, setDays] = useState(30);

  // Distingue « connecté sans établissement » de « pas connecté du tout ».
  const viewer = useQuery({ queryKey: queryKeys.viewer, queryFn: () => api.auth.me(), retry: false });

  const range = useMemo(() => {
    const to = new Date();
    const from = new Date(to.getTime() - days * 86_400_000);
    return { from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) };
  }, [days]);

  const { data, isLoading, isError } = useQuery({
    queryKey: queryKeys.business.metrics(businessId ?? '', range),
    queryFn: () => api.business.metrics({ businessId: businessId as string, ...range }),
    enabled: Boolean(businessId),
  });

  if (!businessId) {
    // Deux situations distinctes : pas connecté, ou connecté sans établissement.
    // Confondre les deux enverrait un compte fraîchement créé vers la page de
    // connexion au lieu de l'inscription — un cul-de-sac au pire moment.
    const isSignedIn = viewer.isSuccess;

    return (
      <main className="mx-auto max-w-2xl p-8">
        <h1 className="text-2xl font-bold">
          {isSignedIn ? 'Bienvenue sur TRIALYA Business' : 'Connecte-toi'}
        </h1>
        <p className="mt-2 text-text-secondary">
          {isSignedIn
            ? 'Inscris ton établissement : cinq minutes, et tes premières offres partent en vérification.'
            : 'Accède à ton espace professionnel pour suivre tes essais et tes conversions.'}
        </p>
        <a
          href={isSignedIn ? '/onboarding' : '/sign-in'}
          className="mt-6 inline-block rounded-card bg-accent px-5 py-3 font-semibold text-on-accent"
        >
          {isSignedIn ? 'Inscrire mon établissement' : 'Se connecter'}
        </a>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-6xl p-6 lg:p-10">
      <header className="mb-8 flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold">Tableau de bord</h1>
          <p className="mt-1 text-text-secondary">Tes essais et ce qu’ils rapportent.</p>
          <nav className="mt-3 flex gap-4 text-sm font-semibold" aria-label="Sections">
            <a href="/leads" className="text-accent-text hover:underline">
              Prospects
            </a>
            <a href="/offers" className="text-accent-text hover:underline">
              Offres & planning
            </a>
          </nav>
        </div>

        <div className="flex gap-2" role="group" aria-label="Période">
          {[7, 30, 90].map((value) => (
            <button
              key={value}
              type="button"
              onClick={() => setDays(value)}
              aria-pressed={days === value}
              className={`min-h-11 rounded-pill px-4 text-sm font-semibold transition ${
                days === value
                  ? 'bg-accent text-on-accent'
                  : 'bg-surface-muted text-text-secondary hover:bg-ink-200'
              }`}
            >
              {value} jours
            </button>
          ))}
        </div>
      </header>

      {isError ? (
        <p role="alert" className="rounded-card bg-danger-subtle p-4 text-danger">
          Impossible de charger tes statistiques. Réessaie dans quelques instants.
        </p>
      ) : (
        <>
          <section
            aria-label="Indicateurs"
            className="grid grid-cols-2 gap-4 lg:grid-cols-3 xl:grid-cols-6"
          >
            <MetricCard label="Essais" value={data?.trials} loading={isLoading} />
            <MetricCard label="Check-ins" value={data?.checkIns} loading={isLoading} />
            <MetricCard label="No-shows" value={data?.noShows} loading={isLoading} tone="warning" />
            <MetricCard label="Conversions" value={data?.conversions} loading={isLoading} tone="success" />
            <MetricCard
              label="Taux de conversion"
              value={data ? `${(data.conversionRate * 100).toFixed(1)}%` : undefined}
              loading={isLoading}
              tone="success"
              hint="Conversions ÷ check-ins"
            />
            <MetricCard
              label="Revenus attribués"
              value={data ? formatMoney(data.attributedRevenue, { compactWholeAmounts: true }) : undefined}
              loading={isLoading}
            />
          </section>

          <section className="mt-6 rounded-card bg-surface p-5 shadow-sm">
            <h2 className="text-lg font-semibold">Ton entonnoir</h2>
            <p className="mt-1 text-sm text-text-secondary">
              {data?.trials ?? 0} essais réservés → {data?.checkIns ?? 0} venus (
              {data ? (data.attendanceRate * 100).toFixed(0) : 0}%) → {data?.conversions ?? 0}{' '}
              clients ({data ? (data.conversionRate * 100).toFixed(0) : 0}%)
            </p>
            {/*
              Quatre comparaisons, pas trois : chaque segment contre la piste,
              les deux segments entre eux, et la piste contre la carte.

              C'est la dernière qui manquait — la piste était à 1,15:1 du blanc,
              donc invisible, donc la longueur totale de la barre aussi : les
              proportions que les segments encodent n'étaient lisibles par
              personne, quelle que soit leur couleur. D'où le contour.

              Le lime, lui, disparaissait sur la piste (1,03:1). Il est remplacé
              par l'encre, non parce que deux couleurs sombres ne peuvent pas se
              distinguer — encre et vert donnent 3,77:1 — mais parce que deux
              couleurs de luminance *voisine* ne le peuvent pas, quelle que soit
              leur teinte : le ratio WCAG ne mesure que la luminance.
            */}
            <div
              className="mt-4 flex h-3 overflow-hidden rounded-pill bg-surface-muted ring-1 ring-border-strong"
              role="img"
              aria-label={`Taux de présence ${data ? (data.attendanceRate * 100).toFixed(0) : 0}%, conversion ${data ? (data.conversionRate * 100).toFixed(0) : 0}%`}
            >
              <div
                className="bg-text-primary"
                style={{ width: `${(data?.attendanceRate ?? 0) * 100}%` }}
              />
              <div
                className="bg-success"
                style={{ width: `${(data?.conversionRate ?? 0) * 30}%` }}
              />
            </div>
          </section>

          <TodayBookings businessId={businessId} />
        </>
      )}
    </main>
  );
}
