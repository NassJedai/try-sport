# TRY

Marketplace de découverte sportive. Trouver une activité près de chez soi,
l'essayer une fois sans engagement, décider ensuite. Lancement Bruxelles,
architecture prévue pour Belgique → Benelux → Europe sans réécriture.

Voir `PROJECT_PLAN.md` pour l'état d'avancement et les lacunes connues,
`docs/adr/` pour le pourquoi des décisions structurantes.

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

C'est cette règle qui fait de TRY une marketplace de découverte et non un site de
bons plans. Une demande visant à offrir plusieurs séances découvertes se traite
par une offre distincte (`DISCOVERY_PACK`) à tarification propre, jamais en
assouplissant l'allocation d'essai.

### Le modèle économique

- **Rejoindre TRY est gratuit pour les salles**, dans un premier temps. Pas
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

- Le taux par défaut en base est encore à `1500` (15 %) alors que la règle
  commerciale est de 25 %. À corriger.
- Traitement TVA de la commission (assujettissement belge, facturation aux
  partenaires).
- Obligations RGPD et droit belge de la vente à distance : mentions, droit de
  rétractation, conservation des données prospects.
