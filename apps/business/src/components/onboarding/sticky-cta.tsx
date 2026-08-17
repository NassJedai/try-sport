/**
 * Le bouton principal reste collé en bas de l'écran, au-dessus de la zone sûre
 * de l'iPhone — un gérant qui remplit ça entre deux cours ne doit pas remonter
 * jusqu'en haut du clavier pour valider.
 *
 * `fixed`, pas `sticky` : un formulaire plus court que l'écran (ex. l'étape
 * « heure de début ») ne remplit pas la hauteur disponible, et un élément
 * `sticky` ne colle qu'en résistant au défilement — il ne se plaque jamais au
 * bas d'un viewport qu'il n'a pas besoin de faire défiler. `<main>` réserve
 * l'espace correspondant en bas (`pb-28`) pour que le contenu ne passe jamais
 * dessous.
 */
export function StickyCta({ children }: { children: React.ReactNode }) {
  return (
    <div className="fixed inset-x-0 bottom-0 z-10 border-t border-border bg-surface/95 px-6 pb-[max(1rem,env(safe-area-inset-bottom))] pt-4 backdrop-blur lg:static lg:mt-8 lg:border-0 lg:bg-transparent lg:p-0 lg:backdrop-blur-none">
      <div className="mx-auto max-w-xl">{children}</div>
    </div>
  );
}
