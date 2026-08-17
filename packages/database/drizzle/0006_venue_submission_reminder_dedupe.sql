-- Rend idempotente la relance de complétion de dossier (J+1 / J+3), sur le
-- même principe que 0003_notification_dedupe.sql pour les rappels de séance.
--
-- reservation_id ne convient pas : ces relances portent sur un LIEU dont le
-- dossier d'inscription reste incomplet, pas sur une réservation. venue_id
-- suit exactement le même schéma — nul pour tout le reste, unique avec
-- `type` quand présent — pour que le job puisse réserver le droit d'envoyer
-- avant d'envoyer (INSERT ... ON CONFLICT DO NOTHING), au lieu de risquer un
-- doublon si deux instances de l'API tournent ou si le job est rejoué après
-- un redémarrage.

ALTER TABLE "notifications"
  ADD COLUMN "venue_id" uuid;
--> statement-breakpoint
ALTER TABLE "notifications"
  ADD CONSTRAINT "notifications_venue_id_venues_id_fk"
  FOREIGN KEY ("venue_id") REFERENCES "public"."venues"("id") ON DELETE cascade;
--> statement-breakpoint
CREATE UNIQUE INDEX "notifications_venue_type_key"
  ON "notifications" USING btree ("venue_id", "type")
  WHERE venue_id IS NOT NULL;
