'use client';

import { useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { queryKeys } from '@try/api-client';
import { api } from '@/lib/api';

/**
 * Gestion des photos d'un lieu ou d'une offre.
 *
 * Le fichier part tel quel, en binaire — pas de recadrage ni de compression côté
 * client : le serveur vérifie le format par les octets et refuse au-delà de
 * 8 Mo, et les variantes d'affichage seront le travail d'un CDN d'images.
 */
export function PhotoManager({
  kind,
  entityId,
  title,
}: {
  kind: 'venue' | 'offer';
  entityId: string;
  title: string;
}) {
  const queryClient = useQueryClient();
  const inputRef = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);

  const queryKey = [...queryKeys.business.all, kind, entityId, 'images'];

  const { data, isLoading } = useQuery({
    queryKey,
    queryFn: () =>
      kind === 'venue' ? api.business.venueImages(entityId) : api.business.offerImages(entityId),
  });

  const invalidate = (): void => {
    void queryClient.invalidateQueries({ queryKey });
  };

  const upload = useMutation({
    mutationFn: (file: File) =>
      kind === 'venue'
        ? api.business.uploadVenueImage(entityId, file, file.type)
        : api.business.uploadOfferImage(entityId, file, file.type),
    onSuccess: () => {
      setError(null);
      invalidate();
    },
    onError: (mutationError: Error) => {
      // L'échec doit se voir : un bouton qui ne fait rien en silence est le
      // défaut qu'on a déjà payé une fois aujourd'hui.
      setError(mutationError.message || "L'envoi a échoué. Réessaie.");
    },
  });

  const remove = useMutation({
    mutationFn: (imageId: string) =>
      kind === 'venue'
        ? api.business.deleteVenueImage(entityId, imageId)
        : api.business.deleteOfferImage(entityId, imageId),
    onSettled: invalidate,
  });

  const items = data?.items ?? [];

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-semibold">{title}</h3>
        <label className="cursor-pointer rounded-card border border-ink-200 px-4 py-2 text-sm font-semibold hover:bg-surface-muted">
          {upload.isPending ? 'Envoi…' : 'Ajouter une photo'}
          <input
            ref={inputRef}
            type="file"
            accept="image/jpeg,image/png,image/webp"
            className="sr-only"
            disabled={upload.isPending}
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) upload.mutate(file);
              // Réinitialisé pour permettre de renvoyer le même fichier après
              // une erreur — sans ça, onChange ne se déclenche pas.
              event.target.value = '';
            }}
          />
        </label>
      </div>

      {error && <p className="mt-2 text-sm text-red-700">{error}</p>}

      {isLoading ? (
        <div className="mt-3 h-24 w-40 animate-pulse rounded-card bg-surface-muted" aria-hidden />
      ) : items.length === 0 ? (
        <p className="mt-2 text-sm text-ink-500">
          Aucune photo. Les lieux avec photos convertissent nettement mieux — ajoute au moins ta
          salle principale.
        </p>
      ) : (
        <ul className="mt-3 flex flex-wrap gap-3">
          {items.map((image) => (
            <li key={image.id} className="group relative">
              {/* <img> volontaire : les URLs locales ne passent pas par
                  l'optimiseur de next/image, et une vignette de gestion n'en a
                  pas besoin. */}
              <img
                src={image.url}
                alt=""
                width={160}
                height={120}
                className="h-28 w-40 rounded-card object-cover"
              />
              <button
                type="button"
                onClick={() => remove.mutate(image.id)}
                disabled={remove.isPending}
                aria-label="Supprimer cette photo"
                className="absolute right-1 top-1 rounded-full bg-black/60 px-2 py-0.5 text-xs font-bold text-white opacity-0 transition group-hover:opacity-100 focus:opacity-100"
              >
                ✕
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
