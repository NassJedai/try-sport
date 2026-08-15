-- Rend l'envoi d'une notification idempotent.
--
-- Le rappel de séance est produit par un cron, et un cron rejoue : redémarrage
-- pendant la boucle, deuxième instance d'API, fenêtre de recherche qui chevauche
-- le tour précédent. Sans garde-fou, l'utilisateur reçoit le même rappel deux
-- fois — le genre de défaut qui fait désinstaller une app.
--
-- La garde est en base, pas en mémoire : c'est le seul endroit que deux process
-- partagent. Le job insère d'abord la ligne (ON CONFLICT DO NOTHING) et n'envoie
-- l'e-mail que si l'insertion a réellement créé une ligne. Deux instances en
-- course : une seule gagne l'insert, une seule envoie.
--
-- L'index est PARTIEL : les notifications non liées à une réservation (annonces,
-- messages produit) n'ont pas de reservation_id et ne doivent pas se contraindre
-- entre elles.

ALTER TABLE "notifications"
  ADD COLUMN "reservation_id" uuid REFERENCES "reservations"("id") ON DELETE CASCADE;
--> statement-breakpoint
CREATE UNIQUE INDEX "notifications_reservation_type_key"
  ON "notifications" ("reservation_id", "type")
  WHERE "reservation_id" IS NOT NULL;
--> statement-breakpoint
-- Le centre de notifications se lit dans l'ordre antichronologique, par
-- utilisateur : sans DESC, Postgres trie à chaque ouverture de l'écran.
CREATE INDEX "notifications_user_recent_idx"
  ON "notifications" ("user_id", "created_at" DESC);
