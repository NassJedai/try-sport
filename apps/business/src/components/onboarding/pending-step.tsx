export function PendingStep({ contactEmail }: { contactEmail: string }) {
  return (
    <div className="mt-10 rounded-card bg-accent-subtle p-8 text-center">
      <p className="text-4xl" aria-hidden>
        ⏳
      </p>
      <h1 className="mt-2 text-2xl font-bold text-accent-text">En cours de vérification</h1>
      <p className="mt-2 text-text-secondary">
        Ton dossier est chez l’équipe TRIALYA. Réponse sous 48h à{' '}
        <strong className="text-text-primary">{contactEmail}</strong>.
      </p>
      <a
        href="/"
        className="mt-6 inline-block min-h-12 rounded-card bg-accent px-5 py-3 font-semibold text-on-accent"
      >
        Voir mon tableau de bord
      </a>
    </div>
  );
}
