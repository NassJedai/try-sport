/** Le message d'erreur d'un champ, affiché juste sous lui — jamais en haut de l'écran. */
export function FieldErrorText({ message }: { message: string | null | undefined }) {
  if (!message) return null;
  return (
    <p role="alert" className="mt-1 text-sm text-danger">
      {message}
    </p>
  );
}
