export function DoneStep({
  venueName,
  offerTitle,
  slotsCreated,
  contactEmail,
}: {
  venueName: string;
  offerTitle: string;
  slotsCreated: number;
  contactEmail: string;
}) {
  return (
    <div className="mt-10 rounded-card bg-success-subtle p-8 text-center">
      <p className="text-4xl" aria-hidden>
        ✓
      </p>
      <h1 className="mt-2 text-2xl font-bold text-success">C’est envoyé</h1>
      <p className="mt-2 text-text-secondary">
        <strong className="text-text-primary">{venueName}</strong> et l’offre «{' '}
        <strong className="text-text-primary">{offerTitle}</strong> » sont en cours de vérification par
        l’équipe TRIALYA, avec {slotsCreated} séance{slotsCreated > 1 ? 's' : ''} déjà programmée
        {slotsCreated > 1 ? 's' : ''} sur les 30 prochains jours.
      </p>
      <p className="mt-2 text-text-secondary">
        Réponse sous 48h à <strong className="text-text-primary">{contactEmail}</strong>.
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
