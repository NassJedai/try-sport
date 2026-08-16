'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ApiError } from '@try/api-client';
import { apiClient } from '@/lib/api';
import { useDebouncedValue } from '@/lib/use-debounced-value';

interface AdminUser {
  id: string;
  email: string;
  firstName: string | null;
  role: string;
  isSuspended: boolean;
  reservationCount: number;
  createdAt: string;
  lastSeenAt: string | null;
}

/**
 * Recherche d'utilisateurs pour le support.
 *
 * Le cas d'usage est « ce client au téléphone dit que… » : la recherche part de
 * l'e-mail ou du prénom, les deux seules choses qu'une personne sait donner.
 */
export default function AdminUsersPage() {
  const [search, setSearch] = useState('');
  const q = useDebouncedValue(search, 300);

  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['admin', 'users', q],
    queryFn: () => apiClient.get<{ items: AdminUser[] }>('/v1/admin/users', { query: { q: q || undefined } }),
  });

  return (
    <main className="mx-auto max-w-5xl p-6 lg:p-10">
      <a href="/" className="text-sm text-ink-500 underline">← Vue d’ensemble</a>
      <h1 className="mt-2 text-3xl font-bold">Utilisateurs</h1>

      <label htmlFor="search" className="sr-only">Rechercher par e-mail ou prénom</label>
      <input
        id="search"
        value={search}
        onChange={(event) => setSearch(event.target.value)}
        placeholder="Rechercher par e-mail ou prénom…"
        className="mt-4 min-h-12 w-full rounded-card border border-border bg-surface px-4"
      />

      {isError ? (
        <p role="alert" className="mt-6 rounded-card bg-danger-subtle p-4 text-danger">
          {error instanceof ApiError ? error.message : 'Chargement impossible.'}
        </p>
      ) : (
        <div className="mt-6 overflow-x-auto rounded-card bg-surface shadow-sm">
          <table className="w-full min-w-[640px] text-left text-sm">
            <caption className="sr-only">Utilisateurs de la plateforme</caption>
            <thead className="bg-surface-muted text-xs uppercase tracking-wide text-ink-400">
              <tr>
                <th scope="col" className="px-4 py-3">E-mail</th>
                <th scope="col" className="px-4 py-3">Prénom</th>
                <th scope="col" className="px-4 py-3">Rôle</th>
                <th scope="col" className="px-4 py-3">Réservations</th>
                <th scope="col" className="px-4 py-3">Inscrit le</th>
              </tr>
            </thead>
            <tbody>
              {isLoading ? (
                <tr><td colSpan={5} className="px-4 py-6 text-ink-400">Chargement…</td></tr>
              ) : (data?.items.length ?? 0) === 0 ? (
                <tr><td colSpan={5} className="px-4 py-6 text-ink-400">Aucun résultat.</td></tr>
              ) : (
                data?.items.map((user) => (
                  <tr key={user.id} className="border-t border-border">
                    <td className="px-4 py-3 font-medium">
                      {user.email}
                      {user.isSuspended && (
                        <span className="ml-2 rounded-pill bg-danger-subtle px-2 py-0.5 text-xs font-semibold text-danger">
                          suspendu
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3">{user.firstName ?? '—'}</td>
                    <td className="px-4 py-3 text-ink-500">{user.role}</td>
                    <td className="px-4 py-3 tabular-nums">{user.reservationCount}</td>
                    <td className="px-4 py-3 tabular-nums text-ink-500">
                      {new Date(user.createdAt).toLocaleDateString('fr-BE')}
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
