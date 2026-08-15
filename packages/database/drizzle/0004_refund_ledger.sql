-- Fait de « refunds » un registre de mouvements, et de « payments » sa projection.
--
-- Jusqu'ici un remboursement n'existait qu'en agregat (payments.refunded_amount)
-- et la commission n'etait jamais renversee : la plateforme gardait sa part d'un
-- argent rendu. Le remboursement partiel etait carrement irrepresentable, parce
-- que la seule facon d'ajuster la ventilation aurait ete de toucher
-- platform_fee_amount / merchant_amount — ce que payments_split_reconciles
-- refuse, et a juste titre : ces colonnes disent ce qui a ete FACTURE.
--
-- On ajoute donc la dimension manquante, ce qui a ete RENDU : ligne a ligne dans
-- refunds, en cumul dans payments. Le net se lit par soustraction, jamais par
-- ecrasement. La ventilation d'encaissement reste intacte et auditable, et la
-- contrainte de reconciliation existante n'est jamais mise en danger.
--
-- provider_refund_id devient obligatoire et unique par fournisseur : c'est la
-- SEULE cle qui distingue deux remboursements partiels de meme montant sur le
-- meme paiement d'une redelivrance du meme remboursement. L'unicite partielle
-- precedente laissait cohabiter N lignes NULL et n'offrait donc aucune garantie.
--
-- status est un varchar + CHECK, pas un pgEnum : les enums Postgres du projet
-- sont generes depuis packages/contracts, et un statut technique de mouvement
-- d'argent n'a rien a faire dans le vocabulaire des quatre applications.

ALTER TABLE "refunds"
  ADD COLUMN "provider" varchar(20) DEFAULT 'STRIPE' NOT NULL,
  ADD COLUMN "status" varchar(20) DEFAULT 'SUCCEEDED' NOT NULL,
  ADD COLUMN "platform_fee_amount" integer DEFAULT 0 NOT NULL,
  ADD COLUMN "merchant_amount" integer DEFAULT 0 NOT NULL,
  ADD COLUMN "failure_reason" varchar(120),
  ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;
--> statement-breakpoint

-- Ventilation des lignes existantes, avec la meme arithmetique que le service :
-- arrondi demi-superieur du prorata evalue sur le CUMUL, pris en difference.
-- La fenetre reproduit l'ordre chronologique d'arrivee, seul ordre qui rende la
-- somme des lignes egale a la projection. bigint parce que 2 * frais * cumul
-- deborde int4 sur les gros montants. brut = 0 -> aucune part a renverser.
WITH "ordonne" AS (
  SELECT r."id",
         r."amount" AS "ligne",
         p."amount" AS "brut",
         p."platform_fee_amount" AS "frais",
         COALESCE(SUM(r."amount") OVER (
           PARTITION BY r."payment_id"
           ORDER BY r."created_at", r."id"
           ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
         ), 0) AS "avant"
  FROM "refunds" r
  JOIN "payments" p ON p."id" = r."payment_id"
), "calcul" AS (
  SELECT "id",
         "ligne",
         CASE WHEN "brut" > 0 THEN
           ((2::bigint * "frais" * ("avant" + "ligne") + "brut") / (2::bigint * "brut"))::integer
           - ((2::bigint * "frais" * "avant" + "brut") / (2::bigint * "brut"))::integer
         ELSE 0 END AS "part_frais"
  FROM "ordonne"
)
UPDATE "refunds" r
SET "platform_fee_amount" = c."part_frais",
    "merchant_amount" = c."ligne" - c."part_frais"
FROM "calcul" c
WHERE r."id" = c."id";
--> statement-breakpoint

-- Sans identifiant fournisseur, l'idempotence n'a pas de cle. Cette instruction
-- doit echouer bruyamment si une ligne heritee en est depourvue.
ALTER TABLE "refunds" ALTER COLUMN "provider_refund_id" SET NOT NULL;
--> statement-breakpoint

-- La reconciliation de ligne est CONDITIONNELLE au statut : un remboursement qui
-- n'a pas abouti ne renverse rien, et sa ventilation doit rester a zero pour
-- qu'une somme naive sur la table ne le compte jamais.
ALTER TABLE "refunds"
  ADD CONSTRAINT "refunds_status_known"
    CHECK ("status" IN ('PENDING', 'SUCCEEDED', 'FAILED', 'CANCELED')),
  ADD CONSTRAINT "refunds_split_non_negative"
    CHECK ("platform_fee_amount" >= 0 AND "merchant_amount" >= 0),
  ADD CONSTRAINT "refunds_split_reconciles"
    CHECK (
      ("status" = 'SUCCEEDED'
        AND "platform_fee_amount" + "merchant_amount" = "amount")
      OR ("status" <> 'SUCCEEDED'
        AND "platform_fee_amount" = 0 AND "merchant_amount" = 0)
    );
--> statement-breakpoint

-- L'unicite devient TOTALE et composite : c'est le verrou d'idempotence du
-- registre, et un second fournisseur ne doit pas entrer en collision avec Stripe
-- sur un identifiant homonyme.
DROP INDEX "refunds_provider_key";
--> statement-breakpoint
CREATE UNIQUE INDEX "refunds_provider_key"
  ON "refunds" USING btree ("provider", "provider_refund_id");
--> statement-breakpoint

-- La projection se recalcule par SUM filtre sur le statut, a chaque application.
CREATE INDEX "refunds_payment_status_idx"
  ON "refunds" USING btree ("payment_id", "status");
--> statement-breakpoint

ALTER TABLE "payments"
  ADD COLUMN "refunded_platform_fee_amount" integer DEFAULT 0 NOT NULL,
  ADD COLUMN "refunded_merchant_amount" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint

UPDATE "payments" p
SET "refunded_platform_fee_amount" = c."frais_rendus",
    "refunded_merchant_amount" = p."refunded_amount" - c."frais_rendus"
FROM (
  SELECT "id",
         ((2::bigint * "platform_fee_amount" * "refunded_amount" + "amount")
          / (2::bigint * "amount"))::integer AS "frais_rendus"
  FROM "payments"
  WHERE "amount" > 0 AND "refunded_amount" > 0
) c
WHERE p."id" = c."id";
--> statement-breakpoint

-- Miroir exact de payments_split_reconciles, cote rembourse, plus le plafond :
-- on ne peut pas rendre plus qu'on n'a preleve, de chaque cote. Les trois
-- proprietes de refundedFeeAt garantissent que ces contraintes ne peuvent pas
-- etre atteintes par le calcul applicatif ; elles sont le dernier rempart.
ALTER TABLE "payments"
  ADD CONSTRAINT "payments_refund_split_reconciles"
    CHECK ("refunded_platform_fee_amount" + "refunded_merchant_amount"
           = "refunded_amount"),
  ADD CONSTRAINT "payments_refund_split_within_capture"
    CHECK ("refunded_platform_fee_amount" >= 0
       AND "refunded_platform_fee_amount" <= "platform_fee_amount"
       AND "refunded_merchant_amount" >= 0
       AND "refunded_merchant_amount" <= "merchant_amount");
