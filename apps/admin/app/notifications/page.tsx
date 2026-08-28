'use client';

import { useState } from 'react';
import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { ApiError, queryKeys } from '@try/api-client';
import type { NotificationDto } from '@try/contracts';
import { api } from '@/lib/api';

/** Une page telle que rendue par `api.notifications.list`. */
type NotificationsPage = Awaited<ReturnType<typeof api.notifications.list>>;

/**
 * Libellés d'affichage pour les `type` déjà en base — purement décoratif,
 * jamais une branche de logique : `notificationSchema.type` reste une chaîne
 * libre côté contrat (voir son commentaire), un type inconnu retombe sur lui-
 * même via `notificationTypeLabel`.
 */
const NOTIFICATION_TYPE_LABELS_FR: Record<string, string> = {
  VENUE_IDENTITY_CHANGED: 'Fiche lieu modifiée',
  BUSINESS_IDENTITY_CHANGED: 'Fiche établissement modifiée',
  OFFER_MODERATED_FIELDS_CHANGED: 'Offre modifiée',
};

function notificationTypeLabel(type: string): string {
  return NOTIFICATION_TYPE_LABELS_FR[type] ?? type;
}

/**
 * Alertes de modération a posteriori.
 *
 * Depuis le desserrage du 28/08 (`OFFER_EDIT_POLICY` en `NOTIFY_ADMIN` sur les
 * champs modérés d'une offre `ACTIVE`/`PAUSED`, et déjà le cas pour l'identité
 * d'un lieu ou d'un établissement), l'écriture passe sans validation
 * préalable et `ModerationLifecycleListener` insère une ligne
 * `notifications` par admin à la place. Cette page est le seul endroit qui la
 * rend visible : sans elle, la détection qui a remplacé la prévention n'est
 * branchée à aucun œil humain.
 *
 * `GET /v1/notifications` est déjà borné à l'utilisateur connecté côté API
 * (`NotificationController.list`, filtré sur `user.id` pris du jeton) — pas
 * de paramètre à fournir, pas de fuite possible vers les alertes d'un autre
 * admin.
 *
 * La liste était plafonnée à 50 lignes sans qu'aucun indice ne le dise — un
 * compteur « non lues » à 61 et une liste à 50 lignes silencieuses. Pagination
 * par curseur, calquée sur `admin.payments()`/`admin.venues()`
 * (`packages/api-client/src/endpoints.ts`, mêmes noms `cursor`/`limit` et
 * `nextCursor`/`total`) : `useInfiniteQuery` accumule les pages chargées, et
 * le bouton « Charger plus » n'apparaît que si le serveur a effectivement
 * rendu un `nextCursor`. Cet écran a été écrit avant que
 * `NotificationController.list` ne porte lui-même `nextCursor`/`total`
 * (chantier API mené en parallèle) : le garde reste volontairement — un
 * serveur qui reviendrait à l'ancienne forme (pas de curseur, pas de total)
 * ne casse toujours rien ici, le bouton disparaît simplement plutôt que de
 * promettre une page suivante qui n'arriverait pas. `unreadCount`, toujours
 * exact côté serveur indépendamment de la pagination, porte l'indication de
 * troncature dans ce cas de repli.
 */
export default function AdminNotificationsPage() {
  const queryClient = useQueryClient();
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);

  const {
    data,
    isLoading,
    isError,
    error,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
  } = useInfiniteQuery({
    queryKey: queryKeys.notifications.list(unreadOnly),
    queryFn: ({ pageParam }) => api.notifications.list(unreadOnly, { cursor: pageParam ?? undefined }),
    initialPageParam: null as string | null,
    // `?? undefined`, pas `?? null` : `getNextPageParam` renvoyant `null`
    // resterait un curseur « défini » aux yeux de TanStack Query (`hasNextPage`
    // deviendrait vrai) et rechargerait indéfiniment la première page.
    // `undefined` est la seule valeur qui signifie « pas de page suivante ».
    getNextPageParam: (lastPage: NotificationsPage) => lastPage.nextCursor ?? undefined,
  });

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.notifications.all });
  };

  const markRead = useMutation({
    mutationFn: (id: string) => api.notifications.markRead(id),
    onSuccess: invalidate,
    onError: (mutationError) => {
      setFeedback(
        mutationError instanceof ApiError ? mutationError.message : 'Le marquage a échoué.',
      );
    },
  });

  const markAllRead = useMutation({
    mutationFn: () => api.notifications.markAllRead(),
    onSuccess: (result) => {
      setFeedback(result.updated > 0 ? `${result.updated} alerte(s) marquée(s) comme lues.` : null);
      invalidate();
    },
    onError: (mutationError) => {
      setFeedback(
        mutationError instanceof ApiError ? mutationError.message : 'Le marquage a échoué.',
      );
    },
  });

  const pages = data?.pages ?? [];
  const items = pages.flatMap((page) => page.items);
  const unreadCount = pages[0]?.unreadCount ?? 0;
  const total = typeof pages[0]?.total === 'number' ? pages[0].total : null;
  // Deux sources, parce que l'API ne rend pas encore `total` : `unreadCount`
  // est déjà exact côté serveur aujourd'hui et suffit à révéler une
  // troncature sur l'onglet « Non lues » (61 non lues, 50 chargées) sans
  // attendre le chantier de pagination côté API.
  const truncated =
    (total !== null && items.length < total) || (unreadOnly && items.length < unreadCount);

  return (
    <main className="mx-auto max-w-5xl p-6 lg:p-10">
      <a href="/" className="text-sm text-text-secondary underline">
        ← Vue d’ensemble
      </a>
      <div className="mt-2 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-3xl font-bold">Alertes</h1>
          <p className="mt-1 text-text-secondary">
            Fiches de lieux et offres déjà en ligne, modifiées sans passer par la modération —
            à vérifier après coup plutôt qu’avant.
          </p>
        </div>
        {unreadCount > 0 && (
          <button
            type="button"
            onClick={() => markAllRead.mutate()}
            disabled={markAllRead.isPending}
            className="min-h-11 rounded-card border border-border px-4 text-sm font-semibold text-text-secondary disabled:opacity-50"
          >
            {markAllRead.isPending ? 'Envoi…' : 'Tout marquer comme lu'}
          </button>
        )}
      </div>

      <div className="mt-4 flex flex-wrap gap-2" role="group" aria-label="Filtrer">
        <button
          type="button"
          onClick={() => setUnreadOnly(false)}
          aria-pressed={!unreadOnly}
          className={`min-h-11 rounded-pill px-4 text-sm font-semibold ${!unreadOnly ? 'bg-accent text-on-accent' : 'bg-surface-muted text-text-secondary'}`}
        >
          Toutes
        </button>
        <button
          type="button"
          onClick={() => setUnreadOnly(true)}
          aria-pressed={unreadOnly}
          className={`min-h-11 rounded-pill px-4 text-sm font-semibold ${unreadOnly ? 'bg-accent text-on-accent' : 'bg-surface-muted text-text-secondary'}`}
        >
          Non lues{unreadCount > 0 ? ` (${unreadCount})` : ''}
        </button>
      </div>

      {feedback && (
        <p role="status" className="mt-4 rounded-card bg-accent-subtle p-3 text-sm font-medium">
          {feedback}
        </p>
      )}

      {isLoading ? (
        <div className="mt-6 space-y-2" aria-hidden>
          <div className="h-24 animate-pulse rounded-card bg-surface-muted" />
          <div className="h-24 animate-pulse rounded-card bg-surface-muted" />
          <div className="h-24 animate-pulse rounded-card bg-surface-muted" />
        </div>
      ) : isError ? (
        <p role="alert" className="mt-6 rounded-card bg-danger-subtle p-4 text-danger">
          {error instanceof ApiError ? error.message : 'Chargement impossible.'}
        </p>
      ) : items.length === 0 ? (
        <p className="mt-6 rounded-card bg-surface p-6 text-text-secondary">
          {unreadOnly
            ? 'Rien de non lu. Les nouvelles alertes apparaîtront ici.'
            : 'Rien pour l’instant. Une modification de fiche ou d’offre en ligne apparaîtra ici.'}
        </p>
      ) : (
        <ul className="mt-6 space-y-3">
          {items.map((item: NotificationDto) => (
            <li
              key={item.id}
              className={`rounded-card p-5 shadow-sm ${item.readAt ? 'bg-surface' : 'bg-accent-subtle'}`}
            >
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="flex items-start gap-2">
                  {!item.readAt && (
                    <span
                      aria-hidden
                      className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-accent"
                    />
                  )}
                  <div>
                    <span className="mr-2 rounded-pill bg-surface-muted px-2 py-0.5 text-xs font-semibold uppercase tracking-wide text-text-secondary">
                      {notificationTypeLabel(item.type)}
                    </span>
                    <h2 className={`mt-1 ${item.readAt ? 'font-semibold' : 'font-bold'}`}>
                      {item.title}
                    </h2>
                  </div>
                </div>
                <time
                  dateTime={item.createdAt}
                  className="whitespace-nowrap text-xs text-text-tertiary"
                >
                  {new Date(item.createdAt).toLocaleString('fr-BE', {
                    dateStyle: 'short',
                    timeStyle: 'short',
                  })}
                </time>
              </div>

              <p className="mt-3 whitespace-pre-line text-sm text-text-secondary">{item.body}</p>

              {!item.readAt && (
                <button
                  type="button"
                  onClick={() => markRead.mutate(item.id)}
                  disabled={markRead.isPending}
                  className="mt-3 min-h-11 rounded-card border border-border px-4 text-xs font-semibold text-text-secondary disabled:opacity-50"
                >
                  Marquer comme lu
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      {!isLoading && !isError && items.length > 0 && (
        <div className="mt-4 flex flex-col items-start gap-2">
          {hasNextPage ? (
            <button
              type="button"
              onClick={() => void fetchNextPage()}
              disabled={isFetchingNextPage}
              className="min-h-11 rounded-card border border-border px-4 text-sm font-semibold text-text-secondary disabled:opacity-50"
            >
              {isFetchingNextPage ? 'Chargement…' : 'Charger plus'}
            </button>
          ) : (
            truncated && (
              <p className="text-xs text-text-tertiary">
                {total !== null
                  ? `${items.length} sur ${total} alerte${total > 1 ? 's' : ''} affichée${items.length > 1 ? 's' : ''}.`
                  : `Au moins ${unreadCount} alerte${unreadCount > 1 ? 's' : ''} non lue${unreadCount > 1 ? 's' : ''} au total, ${items.length} affichée${items.length > 1 ? 's' : ''} — affine sur « Non lues » ou reviens plus tard pour voir la suite.`}
              </p>
            )
          )}
        </div>
      )}
    </main>
  );
}
