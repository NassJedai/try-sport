# Audit des parcours — en conditions réelles

**Date :** 16 août 2026
**Contexte :** préparation d'une démo commerciale devant un gérant de salle.
**Environnement :** `~/dev/try-sport`, API + Postgres/PostGIS + les deux dashboards
en local, tunnel Stripe actif (`stripe listen` → `/v1/webhooks/stripe`, secret de
signature identique à celui du `.env`, signatures acceptées).

Ton de l'audit : sévère par consigne. Ce qui marche est mentionné brièvement ;
l'essentiel du document porte sur ce qui gêne une démo.

> **Révisé le 16 août 2026, après contre-relecture du code.**
>
> La première rédaction de cet audit contenait des affirmations fausses. Elles
> sont corrigées en place, dans des encadrés comme celui-ci, plutôt que
> discrètement réécrites — un audit qui se corrige sans le dire ne vaut pas mieux
> que celui qui se trompe.
>
> Trois natures d'erreur ont été trouvées : un **diagnostic faux** présenté comme
> une question métier (le statut de paiement), une **gravité sous-évaluée** (le
> `PATCH` d'un prospect, requalifié en perte de données), et deux constats
> devenus **périmés** depuis les correctifs.
>
> Ce qui a été vérifié et **tient** : la règle d'essai, l'invariant de capacité,
> la résolution serveur du prix, l'idempotence, le fenêtrage de journée faux, et
> l'absence de prélèvement Stripe.

**Tri appliqué**

| Niveau | Règle | Traitement |
| --- | --- | --- |
| 1 | Objectivement cassé, correction sans choix | Corrigé, marqué `[corrigé]` |
| 2 | Implique un choix produit ou de formulation | Question posée, groupée |
| 3 | Demande un vrai chantier | Listé, trié par impact démo |

Jamais de correction silencieuse sur les règles métier, les montants, les états
de réservation ou la machine à états. Un comportement surprenant à ces endroits
est une question, pas un bug.

---

## Parcours consommateur (via l'API, en attendant l'iPhone)

Compte : `user@try.local` (Camille).

### Ce qui marche

| Étape | Résultat |
| --- | --- |
| Connexion OTP | Code émis, vérifié, jeton délivré |
| Recherche `padel` | 5 résultats pertinents, avec prix, prix de référence, remise calculée, distance, note |
| Détail d'une offre | Complet : galerie, équipements, à apporter, conditions, politique d'annulation, avis, éligibilité |
| Règle d'essai | **Correctement appliquée** — `ALREADY_TRIED_THIS_VENUE` sur un lieu déjà essayé, avec message clair |
| Calendrier de disponibilité | Groupé par jour, fuseau `Europe/Brussels`, capacité restante par créneau |
| Réservation gratuite | `CONFIRMED` immédiatement, sans paiement |
| Réservation payante | `PAYMENT_PENDING` + `clientSecret`, puis `CONFIRMED` après webhook |
| Paiement carte de test | `succeeded`, 5,00 € |
| Webhook Stripe | Trois événements relayés, tous acquittés en 200 |
| Annulation + remboursement | `refunded: true`, statut `CANCELLED_USER`, événements de remboursement acquittés |

L'invariant de capacité, la résolution serveur du prix et l'idempotence sont
tenus : la création de réservation **exige** un en-tête `Idempotency-Key` et le
refuse explicitement s'il manque.

### Ce qui gêne

#### Les images pointent vers une IP de réseau local — **niveau 2**

Toutes les URL d'images sont en `http://192.168.0.8:3000/media/…`. Sur le réseau
où cette adresse est valide, tout s'affiche. Ailleurs — un portable de démo sur
le wifi d'une salle, un partage d'écran depuis un autre lieu — **aucune image ne
se charge** et le catalogue devient une liste de titres sur fond gris.

C'est une valeur de configuration, réglable en une ligne, mais elle décide de
l'allure de toute la démo.

#### Le paiement reste `PROCESSING` après remboursement — **défaut, pas question**

Après une annulation remboursée (Stripe confirme, les webhooks `refund.updated`
et `charge.refund.updated` sont acquittés en 200), la réservation passe bien à
`CANCELLED_USER`, mais l'objet paiement reste à `status: PROCESSING`.

> **Rectifié après relecture.** Ce point était présenté ici comme « une question
> métier à trancher », avec l'hypothèse que `REFUNDED` manquait peut-être au
> vocabulaire. C'était faux, et les deux lectures proposées passaient à côté de la
> cause.

`REFUNDED` et `PARTIALLY_REFUNDED` existent bien dans `PAYMENT_STATUSES`
(`packages/contracts/src/enums.ts:99-107`) et sont correctement calculés selon le
cumul remboursé (`refund-ledger.service.ts:357`). Rien ne manque au vocabulaire.

La cause réelle est un **état absorbant** :
`apps/api/src/modules/payments/refund-ledger.service.ts:19-23` restreint les
remboursements aux paiements déjà en `SUCCEEDED`, `PARTIALLY_REFUNDED` ou
`REFUNDED`. `PROCESSING` en est exclu. Un paiement resté en `PROCESSING` — parce
que le webhook `payment_intent.succeeded` n'a jamais été reçu, cas nominal si
l'endpoint n'est pas abonné (voir `TODO.md`) — ne repassera donc **jamais** à
`REFUNDED`, quand bien même Stripe confirme le remboursement.

Ce n'est pas un affichage à traduire pour le gérant : c'est un statut qui ne
bougera plus jamais.

#### La commission n'apparaît pas côté Stripe — **exact, et plus net qu'écrit ici**

Le `PaymentIntent` confirmé porte `application_fee_amount: null`. La commission
de 25 % est donc suivie côté base et non prélevée par Stripe Connect.

> **Confirmé après relecture**, et la cause est mécanique, pas contextuelle.
> `stripe.provider.ts:49-53` ne pose `application_fee_amount` et `transfer_data`
> que si `connectedAccountId` est renseigné. Or **aucun appelant ne le renseigne
> jamais** : le champ n'existe que dans le type (`payment-provider.ts:16`) et dans
> cette condition. La commission est calculée (`payment.service.ts:61`) puis
> écartée avant l'appel. La colonne `stripeAccountId` existe en base
> (`catalog.ts:89`) et n'est pas utilisée.

Conséquence pour la démo : « vous recevez directement votre part » n'est vrai
qu'avec un transfert Connect, qui n'est pas branché. La commission est un montant
enregistré, pas un montant prélevé.

### Résidu de test dans les données

Le compte `user@try.local`, censé être le consommateur de démonstration, est
devenu **propriétaire de « Studio Vérification TRIALYA »** — un établissement
créé pendant les tests d'inscription du chantier précédent. Camille est donc à
la fois cliente et gérante.

Sans gravité fonctionnelle, mais si la démo passe par ce compte, l'écran de
profil montrera une salle qui n'a rien à y faire. Un `pnpm db:seed` remet à plat.

---

## Parcours salle partenaire

Compte : `business@try.local` (propriétaire d'un établissement, membre d'un second).

### Ce qui marche

Le tableau de bord charge de vraies données et se lit d'un coup d'œil : 53 essais,
52 check-ins, 1 no-show, 5 conversions, 2 400 € de revenus attribués. Le CRM
prospects tient ses 20 fiches réparties sur les six statuts du pipeline. La
conversion d'un prospect s'applique correctement.

Le refus de check-in hors fenêtre renvoie un message juste et en français :
« Le check-in n'est pas encore ouvert pour cette séance. »

### Ce qui casse

#### Une réservation de demain s'affiche sous « Aujourd'hui » — **question, invariant 4**

Au moment du test : **16 août, 15h47 à Bruxelles**. La seule ligne du tableau
« Aujourd'hui » est une séance qui commence le **17 août à 05:00 UTC**, soit
demain 07:00 à Bruxelles. Elle s'affiche « 07:00 », ce qu'un gérant lit comme
« ce matin ».

Pire, la même réservation ressort dans les deux journées :

| Requête | Résultat |
| --- | --- |
| `?date=2026-08-16` | 1 réservation — `2026-08-17T05:00:00Z` |
| `?date=2026-08-17` | 3 réservations — dont la même `2026-08-17T05:00:00Z` |

Une réservation comptée deux jours. **Cause identifiée**, dans
`apps/api/src/modules/business/business.service.ts:208-211` :

```ts
const dayStart = query.date ? new Date(`${query.date}T00:00:00Z`) : …;
const dayEnd = new Date(dayStart.getTime() + 36 * 3_600_000);
```

La fenêtre fait **36 heures**, pas 24. Pour le 16 août elle court jusqu'au 17 à
12:00 UTC, et attrape donc une séance du 17 au matin. Deux journées consécutives
se recouvrent de douze heures — d'où la même réservation dans les deux.

Le commentaire juste au-dessus annonce « une journée calendaire locale au lieu,
résolue dans le fuseau de la salle plutôt que celui du serveur ». Le code ne lit
aucun fuseau : il part de minuit UTC et ajoute 36 heures en dur. **Le commentaire
décrit l'intention, pas ce qui est écrit** — c'est ce qui a permis au défaut de
passer inaperçu.

Invariant 4 — **aucune correction silencieuse**.

**Conséquence directe en démo :** le gérant voit un client attendu à 07:00, tape
son code, et le serveur refuse avec `CHECKIN_OUTSIDE_WINDOW`. L'écran propose une
action que le serveur rejettera toujours. C'est le scénario le plus probable
d'une démonstration, et il échoue.

#### Aucun check-in démontrable aujourd'hui — **niveau 3**

Conséquence du point précédent : il n'existe aucune réservation dont la fenêtre
de check-in soit ouverte maintenant. Le geste central du produit — valider une
arrivée au comptoir — n'est pas montrable en l'état.

#### Le participant s'appelle « Invité » — **corrigé par un re-seed, pas par du code**

La seule ligne du tableau porte « Invité ». Vérification faite, **le seed fournit
déjà 25 prénoms** dans `profiles`. Le prénom affiché vient d'un `leftJoin` sur
`profiles` : il retombe sur « Invité » quand la ligne de profil manque.

Ce n'est donc pas une donnée absente du seed mais un **utilisateur créé par les
tests d'inscription**, sans profil. Ajouter des prénoms au seed n'aurait rien
changé. Le remède est `pnpm db:seed`, qui règle du même coup le résidu de test
signalé plus haut.

#### Le même taux affiché à deux précisions, côte à côte — **niveau 2**

La carte indique **9.6 %**, l'entonnoir juste en dessous **10 %**. Même chiffre,
deux arrondis, à trois centimètres l'un de l'autre.

#### Le `PATCH` d'un prospect peut PERDRE la modification — **critique**

Passer un prospect à `CONVERTED` fonctionne : relu ensuite, il est bien
`CONVERTED`. Mais la réponse du `PATCH` contient encore `status: "NEW"`.

> **Requalifié après relecture.** Ce point était classé « question, machine à
> états », comme un simple affichage périmé. C'est en réalité un chemin de
> **perte de données**, et le symptôme visible en était la partie inoffensive.

`business.service.ts:391-396` relit le prospect via `listLeads`, qui interroge
`this.db` — le **pool, pas la transaction** (`:274`). D'où la réponse qui porte
l'état d'avant : elle ne voit pas l'`UPDATE` non encore commité.

Le vrai danger est le tri : `listLeads` ordonne par `desc(updatedAt)` avec
`limit: 1` (`:294`). Dès qu'un **autre** prospect de la même salle a été modifié
plus récemment, `items.find()` ne trouve rien, un `notFound` est levé **à
l'intérieur de la transaction**, celle-ci part en rollback — et la modification
du gérant est perdue, avec un 404 en réponse alors que le prospect existe. Le
compteur `conversionCount` et l'audit trail partent avec.

Seul l'événement `LeadConverted`, déjà émis (`:373`), survit au rollback : un
événement de conversion pour une conversion qui n'a pas eu lieu.

Dette pré-existante, non introduite par les commits relus.

---

## Parcours administrateur

Compte : `admin@try.local`.

### Ce qui marche

Vue d'ensemble complète (43 utilisateurs, 23 lieux actifs, 296 réservations, 271
check-ins, 21 conversions). Modération : approbation d'un lieu → `ACTIVE`, rejet
d'une offre avec motif → `REJECTED`, file vidée. Le contrôle d'accès est réel :
un compte non-admin ne charge pas les données, il ne voit pas un écran vide.

### Ce qui gêne

#### ~~La commission affichée est à 15 %, pas 25 %~~ — **corrigé depuis**

Constat d'origine : la vue d'ensemble donnait `gmv_minor: 1300` et
`platform_revenue_minor: 195`, soit exactement 15 %.

> **Corrigé** par `3f6a144`. La migration `0005_commission_default.sql` porte le
> défaut de colonne à `2500`, et la valeur codée en dur dans le flux
> d'inscription a été supprimée. Un test d'intégration
> (`onboarding-commission-default.integration.test.ts`) échoue désormais si une
> salle naît à autre chose que 2500 — vérifié dans les deux sens.
>
> Réserve qui subsiste : seules les **futures** salles sont concernées. Une base
> déjà peuplée garde ses salles à 15 % jusqu'à décision commerciale, salle par
> salle. En développement, `pnpm db:seed` les recrée au bon taux.

#### ~~Nommage incohérent avec le reste de l'API~~ — **corrigé depuis**

Constat d'origine : la vue d'ensemble renvoyait du `snake_case`
(`monthly_active_users`, `gmv_minor`, `platform_revenue_minor`) là où le reste de
l'API est en `camelCase`.

> **Corrigé** par `1da4109`. Les alias sont désormais en `camelCase` et quotés,
> ce qui est la bonne réponse au repliement de casse de Postgres.
>
> Réserve : la réponse reste typée `Record<string, number>` des deux côtés
> (`moderation.service.ts:296`, `apps/admin/app/page.tsx:81`). Aucun schéma de
> contrat, aucun test — le prochain renommage passera silencieusement.

---

## Ce que je n'ai pas pu vérifier

- **Les mises en page larges.** Le panneau d'aperçu est bloqué à 800 px ; la
  grille à six colonnes des indicateurs n'a pas été vue à sa taille réelle.
- **Le parcours mobile à l'écran.** Testé par l'API uniquement, en attendant
  l'iPhone. Le nom sous l'icône et les dialogues de permission demandent un build
  natif.
- **La connexion par l'interface web.** La page ne s'hydratait pas dans mon
  panneau (WebSocket HMR en échec en boucle) : les clics ne déclenchaient rien.
  J'ai injecté la session et poursuivi par l'API. **À re-tester à la main** — si
  le défaut existe hors de mon outillage, plus personne ne peut se connecter.
