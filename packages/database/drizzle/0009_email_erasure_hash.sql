-- Suppression de compte (RGPD, règle App Store 5.1.1(v)) : la colonne qui
-- empêche « supprimer puis recréer son compte » de redonner une séance
-- découverte gratuite.
--
-- `users` n'est jamais supprimée : `AccountService.deleteAccount` anonymise
-- la ligne en place (adresse remplacée par un identifiant synthétique,
-- `profiles` effacée) plutôt que de la détruire, précisément pour que
-- `reservations`/`payments`/`trial_history` continuent de référencer un
-- utilisateur qui existe toujours. Mais ça laisse une question ouverte : une
-- fois l'adresse réelle effacée, comment reconnaître qu'une nouvelle
-- inscription à cette même adresse est un retour, et pas un compte vierge
-- avec un `trial_history` vide ?
--
-- `email_hash` est la réponse : un HMAC de l'adresse (clé serveur
-- EMAIL_ERASURE_PEPPER, voir packages/config), écrit uniquement au moment de
-- l'anonymisation. `AuthService.findOrCreateUser` calcule le même HMAC à
-- chaque inscription et, s'il trouve une ligne anonymisée qui le porte,
-- réactive CETTE ligne (même id) plutôt que d'en créer une nouvelle — ce qui
-- rattache automatiquement la réinscription au `trial_history` déjà consommé,
-- sans jamais avoir reconservé l'adresse en clair.
--
-- NULL pour tout compte vivant : ce n'est calculé qu'à la suppression, jamais
-- à l'inscription — rien à faire ici pour les comptes existants.
--
-- Additive et sans risque sur une base déjà peuplée : nouvelle colonne
-- nullable sans DEFAULT, nouvel index partiel qui ne porte que sur les lignes
-- déjà anonymisées (aucune aujourd'hui, tant que cette fonctionnalité n'a pas
-- tourné). Rien d'existant ne change de forme ; rien à réécrire.

ALTER TABLE "users"
  ADD COLUMN "email_hash" varchar(64);
--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_hash_erased_key"
  ON "users" USING btree ("email_hash")
  WHERE anonymized_at IS NOT NULL;
