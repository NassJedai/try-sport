# TRIALYA — nom de code : TRY

**Le produit s'appelle TRIALYA. Le code s'appelle TRY.** Les deux coexistent par
décision, pas par négligence : `@try/contracts`, `be.try.app`, `try://` et le nom
du dépôt sont des identifiants techniques et restent tels quels. Il n'y a aucun
renommage du code à faire, ni dans un sens ni dans l'autre.

Marketplace de découverte sportive — **« Try first. Decide later. »** Trouver une
activité près de chez soi, l'essayer une fois sans engagement, décider ensuite.
Lancement Bruxelles, architecture prévue pour Belgique → Benelux → Europe sans
réécriture.

Voir `PROJECT_PLAN.md` pour l'état d'avancement et les lacunes connues,
`docs/adr/` pour le pourquoi des décisions structurantes.

---

## Marque et nommage

**Tout texte vu par un utilisateur dit TRIALYA ; tout identifiant technique reste
TRY.** Une seule question à se poser : est-ce que cette chaîne peut finir sous
les yeux d'un client ou d'un gérant ?

- **TRIALYA** — interfaces des quatre apps, fiches App Store et Play Store,
  e-mails, notifications, site public, communication, contrats, factures.
- **TRY** — paquets `@try/*`, dépôt et chemins, bundle ids `be.try.app`, schéma
  de liens profonds `try://`, domaines techniques, noms de variables, de tables
  et de colonnes, titres OpenAPI internes.

Le slogan **« Try first. Decide later. »** joue sur le verbe *to try* : c'est
exactement ce qui rend la cohabitation saine plutôt que bancale. TRIALYA est le
nom que le public lit, TRY est le verbe qui a donné son nom au code. Voir un
`@try/contracts` dans TRIALYA est normal — ce n'est pas une incohérence à
corriger.

---

## Invariants — ne jamais violer

Ces cinq règles sont porteuses. Une régression sur l'une d'elles est un
incident, pas un bug.

1. **L'argent est en unités mineures entières.** Jamais de flottant, nulle part.
   La commission est en points de base : 12,5 % s'écrit `1250` et reste exact.
2. **Le client ne décide de rien qui compte.** Il envoie un id de créneau. Prix,
   éligibilité, capacité, commission et statut sont résolus côté serveur.
   Aucune écriture métier ne part du mobile ou du web.
3. **La capacité ne peut pas être survendue.** Un `UPDATE` conditionnel sérialisé
   par le verrouillage de ligne Postgres, plus une contrainte `CHECK` qui refuse
   l'écriture même si le code applicatif régresse. Couvert par
   `apps/api/test/booking-concurrency.integration.test.ts` — ce test ne doit
   jamais être affaibli pour faire passer autre chose.
4. **Les horodatages sont en UTC**, affichés dans le fuseau de la salle. Un cours
   de 19:00 reste à 19:00 au passage à l'heure d'été.
5. **Aucun SDK fournisseur dans le domaine.** Paiements, stockage, e-mail,
   recherche et cartes passent par des interfaces. Les choix d'hébergement
   d'ADR-004 doivent rester réversibles.

---

## Structure

```
apps/
  api/          NestJS + Fastify — seul écrivain des données métier
  mobile/       Expo Router — app grand public
  business/     Next.js — tableau de bord des salles
  admin/        Next.js — console de modération
packages/
  contracts/    Schémas Zod, enums, machines à états, ranking — le vocabulaire partagé
  database/     Schéma Drizzle, migrations, seed
  api-client/   Client typé utilisé par les trois frontends
  utils/        Argent, géo, temps, ids — sans dépendance framework
  design-tokens/ Couleur, espacement, typo, motion — web + mobile
  config/       Validation d'environnement fail-fast
  logger/       Logs structurés, avec masquage et request ids
```

**Monolithe modulaire, pas microservices.** Les frontières entre modules sont
réelles — chaque domaine possède ses services et communique vers l'extérieur par
`DomainEvents` — mais tout se déploie en un seul processus.

`packages/contracts` est le point de contact de tout le reste. Un changement ici
se propage aux quatre applications : à traiter comme un changement d'API
publique, jamais comme un détail d'implémentation.

---

## Commandes

| Commande | Effet |
| --- | --- |
| `pnpm dev` | tout, en parallèle |
| `pnpm api` | API sur :3000 (`/docs` pour l'OpenAPI) |
| `pnpm mobile` | serveur Expo |
| `pnpm business` | tableau de bord sur :3001 |
| `pnpm admin` | console admin sur :3002 |
| `pnpm test` | tests unitaires |
| `pnpm test:integration` | tests adossés à la base (nécessite `TEST_DATABASE_URL`) |
| `pnpm lint` / `pnpm typecheck` / `pnpm build` | vérification |

Node ≥ 22.12 et Postgres 15+ **avec PostGIS** (non optionnel : la découverte est
un `ST_DWithin` sur une colonne geography indexée en GiST).

---

## Conventions de travail

- Vérifier avec `pnpm lint`, `pnpm typecheck` et `pnpm test` avant de considérer
  une tâche terminée. Ne pas annoncer « fait » sur la seule base d'une
  compilation réussie.
- Écosystème Expo / React Native : « dernière version npm » n'est pas « version
  supportée ». C'est `expo install` qui fait foi.
- Ne pas modifier un test pour le faire passer. Si un test échoue, soit le code
  est faux, soit le test décrit une règle qui a changé — dans ce second cas, le
  dire explicitement avant de toucher au test.
- Rédiger les réponses et les résumés en français.

---

## Rôle de la session principale — Chef de projet

La session principale agit comme chef de projet de Nassim, fondateur
non-développeur. Règles :

1. **DÉLÉGUER PAR DÉFAUT** : le travail spécialisé va aux subagents. La
   session principale coordonne, vérifie, arbitre — elle ne code elle-même
   que l'anodin.
2. **UN SEUL INTERLOCUTEUR** : les rapports des agents sont synthétisés,
   jamais transmis bruts.
3. **FRANÇAIS VULGARISÉ** : chaque rapport finit par « ce que ça veut dire
   pour toi » et « ce que j'attends de toi » (rien, ou questions oui/non
   avec recommandation).
4. **PREUVE AVANT PAROLE** : jamais « fait » sur la foi d'un rapport —
   vérifier soi-même. Tout ce qui touche l'argent passe par le relecteur.
5. **DISCIPLINE GIT** : commits par lots cohérents, push après validation,
   rien de prouvé laissé non commité en fin de session.

---

## Contexte métier

### L'essai

C'est **la salle partenaire qui décide**, offre par offre :

- **Gratuit ou payant.** Une séance découverte peut être à 0 € ou à un prix
  réduit. Les deux sont des cas normaux, pas des exceptions à traiter à part.
- **La portée de l'essai.** Le gérant choisit si l'allocation se consomme par
  établissement, par lieu, par offre, ou pas du tout. Par défaut : un essai par
  lieu.

Un utilisateur bénéficie du tarif découverte **une seule fois** dans la portée
choisie, puis bascule sur la tarification normale de la salle. Le gérant choisit
la portée, jamais le nombre : **une seule séance découverte**, c'est une règle de
plateforme et non un paramètre.

C'est cette règle qui fait de TRIALYA une marketplace de découverte et non un
site de bons plans. Une demande visant à offrir plusieurs séances découvertes se
traite par une offre distincte (`DISCOVERY_PACK`) à tarification propre, jamais
en assouplissant l'allocation d'essai.

### Le modèle économique

- **Rejoindre TRIALYA est gratuit pour les salles**, dans un premier temps. Pas
  d'abonnement, pas de frais d'entrée.
- **Sur une séance payante, la plateforme prend 25 %** — soit `2500` points de
  base. Le taux est stocké par salle et peut être négocié au contrat sans
  changement de schéma.
- Une séance gratuite génère donc mécaniquement 0 € de commission. Aucun mode de
  facturation particulier n'est requis pour ce cas.

Le taux est susceptible d'évoluer : ne jamais l'écrire en dur dans le code.
Il se lit toujours depuis `businesses.commission_basis_points`.

### À trancher

<!-- Points ouverts — à compléter par Nassim -->

- Le taux par défaut en base est passé à `2500`, et un test le tient. Reste à
  décider du sort des salles **existantes**, toutes à `1500` par héritage : les
  remonter salle par salle, ou leur laisser ce tarif historique. Rien dans le
  schéma ne distingue un défaut hérité d'un taux négocié.
- La commission est **enregistrée, pas prélevée** : Stripe Connect n'est pas
  branché (`application_fee_amount` toujours nul). La plateforme encaisse tout et
  doit reverser. Voir `TODO.md`.
- Traitement TVA de la commission (assujettissement belge, facturation aux
  partenaires).
- Obligations RGPD et droit belge de la vente à distance : mentions, droit de
  rétractation, conservation des données prospects.
