# Audit des parcours — en conditions réelles

**Date :** 16 août 2026
**Contexte :** préparation d'une démo commerciale devant un gérant de salle.
**Environnement :** `~/dev/try-sport`, API + Postgres/PostGIS + les deux dashboards
en local, tunnel Stripe actif (`stripe listen` → `/v1/webhooks/stripe`, secret de
signature identique à celui du `.env`, signatures acceptées).

Ton de l'audit : sévère par consigne. Ce qui marche est mentionné brièvement ;
l'essentiel du document porte sur ce qui gêne une démo.

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

#### Le paiement reste `PROCESSING` après remboursement — **question métier**

Après une annulation remboursée (Stripe confirme, les webhooks `refund.updated`
et `charge.refund.updated` sont acquittés en 200), la réservation passe bien à
`CANCELLED_USER`, mais l'objet paiement reste à `status: PROCESSING`.

Attendu naïvement : `REFUNDED`. Mais c'est un état de paiement, donc hors de
toute correction silencieuse. Deux lectures possibles :

- soit `PROCESSING` reflète fidèlement que Stripe n'a pas encore *réglé* le
  remboursement (il est émis, pas encaissé côté client) — auquel cas c'est juste,
  et c'est l'affichage qui devra le traduire pour un gérant ;
- soit la projection n'est pas mise à jour par le webhook de remboursement.

À trancher avant la démo : un gérant qui voit « en cours » sur un remboursement
qu'il vient d'accorder va poser la question.

#### La commission n'apparaît pas côté Stripe — **question métier**

Le `PaymentIntent` confirmé porte `application_fee_amount: null`. La commission
de 25 % est donc suivie côté base et non prélevée par Stripe Connect.

Ce n'est pas nécessairement un défaut — `CLAUDE.md` dit que le taux est stocké
par salle — mais ça détermine ce qu'on peut promettre en démo : « vous recevez
directement votre part » n'est vrai qu'avec un transfert Connect. À confirmer.

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

#### Le `PATCH` d'un prospect renvoie l'état d'avant — **question, machine à états**

Passer un prospect à `CONVERTED` fonctionne : relu ensuite, il est bien
`CONVERTED`. Mais la réponse du `PATCH` contient encore `status: "NEW"`. Un
client qui fait confiance à la réponse affiche le mauvais statut jusqu'au
rechargement. Le dashboard s'en sort parce qu'il invalide ses requêtes.

Statut de pipeline = machine à états, donc signalé et non corrigé.

---

## Parcours administrateur

Compte : `admin@try.local`.

### Ce qui marche

Vue d'ensemble complète (43 utilisateurs, 23 lieux actifs, 296 réservations, 271
check-ins, 21 conversions). Modération : approbation d'un lieu → `ACTIVE`, rejet
d'une offre avec motif → `REJECTED`, file vidée. Le contrôle d'accès est réel :
un compte non-admin ne charge pas les données, il ne voit pas un écran vide.

### Ce qui gêne

#### La commission affichée est à 15 %, pas 25 % — **question commerciale, priorité démo**

La vue d'ensemble donne `gmv_minor: 1300` et `platform_revenue_minor: 195`, soit
exactement **15 %**.

`CLAUDE.md` le dit déjà dans « À trancher » : le taux par défaut en base est resté
à `1500` alors que la règle commerciale est de 25 %. Ce n'est donc pas une
découverte, mais c'est le pire endroit où le laisser traîner : **un gérant à qui
on présente ce tableau lit le taux qu'on lui prendra.**

#### Nommage incohérent avec le reste de l'API — **niveau 2**

La vue d'ensemble renvoie du `snake_case` (`monthly_active_users`, `gmv_minor`,
`platform_revenue_minor`) là où tout le reste de l'API est en `camelCase`
(`slotStartAt`, `attendeeFirstName`, `remainingCapacity`).

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
