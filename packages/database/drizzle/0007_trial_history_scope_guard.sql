-- Filet en base pour la règle d'essai.
--
-- Jusqu'ici, seule la clé de verrouillage applicative
-- (packages/database/src/locking.ts, acquireTrialEligibilityLock) empêchait
-- un utilisateur de consommer deux fois son essai dans la même portée, et
-- cette clé était posée sur (user, venue). Un établissement dont la portée
-- choisie est ONE_TRIAL_PER_BUSINESS a plusieurs lieux : deux réservations
-- envoyées en même temps, une par lieu, produisaient deux clés de verrou
-- différentes, donc n'étaient sérialisées par rien — les deux lectures
-- voyaient un historique vide, les deux écritures passaient. Contrairement à
-- la capacité (CHECK sur slots.reserved_count), trial_history n'avait aucune
-- garde de stockage : une régression applicative sur le verrou (par exemple
-- un futur retour accidentel à une clé par lieu) passerait inaperçue du
-- moteur.
--
-- Cette migration n'est PAS un remplacement du verrou applicatif (voir le
-- correctif dans booking.service.ts, qui verrouille désormais sur
-- (user, business)) : c'est un filet, sur le même principe que le CHECK de
-- capacité — une régression doit se heurter à la base, pas seulement au code.
--
-- trial_rule est un instantané, au même titre que reservations.trial_rule :
-- il fige la portée choisie au moment où l'essai a été consommé, pour que la
-- contrainte reste correcte même si l'offre change de portée plus tard.
--
-- Trois index uniques partiels, un par portée, plutôt qu'un seul index
-- couvrant les trois colonnes : la portée est choisie offre par offre, donc
-- deux essais consommés sous des portées différentes ne doivent jamais
-- entrer en conflit entre eux (un utilisateur peut légitimement avoir
-- consommé un essai ONE_TRIAL_PER_VENUE au lieu A et un essai
-- ONE_TRIAL_PER_OFFER au lieu B du même établissement).
--
-- ATTENTION — non applicable telle quelle sur une base déjà peuplée par une
-- exécution antérieure du seed : le générateur de réservations passées de
-- packages/database/src/scripts/seed.ts (bloc "past bookings for reviews")
-- attribue ONE_TRIAL_PER_VENUE à toutes les offres et peut, par construction,
-- rejouer le même consommateur sur le même lieu plusieurs fois. Vérifié le
-- 2026-08-26 sur try_dev : 31 paires (user, venue) violent déjà
-- trial_history_venue_scope_key avant même cette migration. CREATE UNIQUE
-- INDEX échouera sur une telle base. Le seed TRUNCATE de toute façon les
-- tables concernées à chaque exécution (voir seed.ts) : appliquer cette
-- migration sur une base fraîchement vidée (ou revidée) plutôt que sur une
-- base déjà seedée avec l'ancien seed. Aucune donnée réelle n'est concernée
-- — le produit n'a pas encore été lancé.

ALTER TABLE "trial_history"
  ADD COLUMN "trial_rule" trial_rule;
--> statement-breakpoint
UPDATE "trial_history" th
  SET "trial_rule" = r."trial_rule"
  FROM "reservations" r
  WHERE r."id" = th."reservation_id";
--> statement-breakpoint
ALTER TABLE "trial_history"
  ALTER COLUMN "trial_rule" SET NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX "trial_history_business_scope_key"
  ON "trial_history" USING btree ("user_id", "business_id")
  WHERE trial_rule = 'ONE_TRIAL_PER_BUSINESS'
    AND status IN ('PENDING', 'PAYMENT_PENDING', 'CONFIRMED', 'CHECKED_IN', 'COMPLETED', 'NO_SHOW');
--> statement-breakpoint
CREATE UNIQUE INDEX "trial_history_venue_scope_key"
  ON "trial_history" USING btree ("user_id", "venue_id")
  WHERE trial_rule = 'ONE_TRIAL_PER_VENUE'
    AND status IN ('PENDING', 'PAYMENT_PENDING', 'CONFIRMED', 'CHECKED_IN', 'COMPLETED', 'NO_SHOW');
--> statement-breakpoint
CREATE UNIQUE INDEX "trial_history_offer_scope_key"
  ON "trial_history" USING btree ("user_id", "offer_id")
  WHERE trial_rule = 'ONE_TRIAL_PER_OFFER'
    AND status IN ('PENDING', 'PAYMENT_PENDING', 'CONFIRMED', 'CHECKED_IN', 'COMPLETED', 'NO_SHOW');
