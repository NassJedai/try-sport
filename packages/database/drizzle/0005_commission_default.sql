-- Aligne le taux de commission par defaut sur la regle commerciale : 25 %.
--
-- La colonne naissait a 1500 points de base, soit 15 %, alors que la regle est
-- de 2500 depuis le depart. L'ecart ne se voyait nulle part dans le code — le
-- taux se lit toujours depuis businesses.commission_basis_points, jamais en
-- dur — mais il se voyait dans les chiffres : la console d'administration
-- affichait 195 EUR de revenu plateforme sur 1300 EUR de volume. Un gerant a
-- qui l'on presente ce tableau y lit le taux qu'on lui prendra.
--
-- Seul le DEFAUT change. Les lignes existantes ne sont pas reecrites, et c'est
-- deliberé : cette colonne existe precisement pour etre negociee au contrat.
-- Rien dans le schema ne distingue une salle laissee au defaut d'une salle a qui
-- l'on a consenti 15 %, donc un UPDATE global romprait des accords qu'on ne sait
-- pas relire. Les remonter releve d'une decision commerciale, salle par salle,
-- pas d'une migration.
--
-- Consequence a connaitre : une base deja peuplee garde ses salles a 15 %
-- jusqu'a intervention explicite. En developpement, `pnpm db:seed` les recree au
-- nouveau taux.
--
-- La contrainte businesses_commission_range (0 a 10000) couvre deja cette
-- valeur ; rien a y changer.

ALTER TABLE "businesses"
  ALTER COLUMN "commission_basis_points" SET DEFAULT 2500;
