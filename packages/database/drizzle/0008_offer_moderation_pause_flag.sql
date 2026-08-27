-- Traçabilité de la cascade de suspension, pour permettre une réactivation
-- symétrique.
--
-- Suspendre un lieu met en pause en cascade toutes ses offres ACTIVE
-- (moderation.service.ts, decideVenue) — voulu et correct. Mais REINSTATE
-- n'avait aucune logique symétrique : le lieu redevenait ACTIVE, ses offres
-- restaient PAUSED, silencieusement. Un admin qui suspend une salle par
-- précaution puis la réactive croyait avoir tout remis en ordre.
--
-- Réveiller aveuglément toute offre PAUSED du lieu serait pire : une offre
-- que le gérant a lui-même mise en pause avant la suspension — ou pendant,
-- via une décision distincte — lui appartient, et un admin qui réactive le
-- lieu n'a pas à lever cette décision-là.
--
-- Cette colonne distingue les deux cas. Elle est renseignée uniquement par
-- la cascade de suspension (acteur SYSTEM de
-- packages/contracts/src/moderation-state-machine.ts) et explicitement
-- effacée par toute pause décidée ailleurs (`setOfferPaused` côté gérant,
-- `decideOffer` côté admin sur une offre précise) : la réactivation
-- symétrique ne réveille donc que les offres dont la pause la plus récente
-- est bien celle de la cascade.
--
-- Nullable, sans DEFAULT : les lignes existantes valent NULL, ce qui est
-- correct pour tout ce qui a été mis en pause avant ce lot (traité comme une
-- pause "du gérant" — le comportement le plus prudent en l'absence
-- d'historique).

ALTER TABLE "offers"
  ADD COLUMN "paused_by_moderation_at" timestamptz;
