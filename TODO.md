# TODO

Dette connue et assumée, par ordre de ce qui bloque une mise en ligne.
Chaque point a été constaté lors de la relecture du lot « remboursements
Stripe » : aucun n'est un soupçon, tous sont vérifiés dans le code.

---

## Avant mise en ligne

Deux étapes d'exploitation, hors code. Sans elles, le traitement des
remboursements est **correct mais inerte**, ou la migration échoue.

### 1. Abonner l'endpoint Stripe aux événements de remboursement

En local, `stripe listen` transmet tout par défaut, ce qui masque le problème.
En staging et en production, l'endpoint webhook doit être explicitement abonné,
depuis le tableau de bord Stripe, aux types suivants :

```
payment_intent.succeeded
payment_intent.payment_failed
payment_intent.canceled
refund.created
refund.updated
refund.failed
charge.refund.updated
charge.refunded
```

Les quatre derniers sont les nouveaux. Sans eux, un remboursement fait depuis le
tableau de bord Stripe ne sera **jamais** répercuté en base : ni le montant, ni
l'ajustement de commission. Le symptôme est silencieux — aucune erreur, juste des
données qui divergent de la réalité Stripe.

`charge.refunded` est volontairement conservé **en plus** de la famille
`refund.*` : il sert de filet de rattrapage (relecture autoritative chez le
fournisseur) et couvre les versions d'API Stripe où `refund.created` n'existe
pas. Il n'y a pas de double comptage — la clé d'idempotence est
`provider_refund_id`, pas le montant.

### 2. Contrôler le pré-requis de la migration `0004`

Avant d'appliquer `packages/database/drizzle/0004_refund_ledger.sql` sur une base
existante :

```sql
SELECT count(*) FROM refunds WHERE provider_refund_id IS NULL;
```

Le résultat doit être **0**. La migration passe cette colonne en `NOT NULL` et
échouerait en bloc sinon. Si le compte est non nul, ne pas appliquer et remonter
le cas : inventer un identifiant fournisseur serait pire que d'échouer, puisque
c'est la seule clé qui distingue une redélivrance d'un vrai second remboursement.

---

## Les sept points de robustesse relevés en relecture

Aucun ne perd d'argent ni ne viole un invariant. Ils sont classés du plus
visible au moins urgent.

### 1. La console admin affiche encore la commission brute

`apps/api/src/modules/admin/admin-browse.service.ts:191` expose désormais
`netPlatformFee` (commission nette des remboursements), et l'agrégat de
`moderation.service.ts:311` affiche le net. Mais `apps/admin/app/payments/page.tsx`
n'a pas été mis à jour : sa colonne « Commission » affiche toujours le brut.

Les deux surfaces se contredisent donc, et le champ neuf est du code mort côté
API. **C'est l'ajustement de commission qui reste invisible dans l'outil** —
le point le plus utile de cette liste. Relève de `apps/admin`, donc de l'agent
`web-dashboards`.

### 2. L'événement `PaymentRefunded` est inexact sur trois points

`apps/api/src/modules/payments/refund-ledger.service.ts:122-135` ne l'émet que
pour les remboursements **insérés**. Conséquences :

- un remboursement livré d'abord en `PENDING` émet l'événement avec un cumul qui
  ne l'inclut pas et `isFullRefund: false`, puis **n'émet plus rien** au passage
  à `SUCCEEDED` (une mise à jour n'est pas une insertion) ;
- `applyWithin`, le chemin d'annulation, n'émet jamais — le plan prévoyait que
  l'appelant s'en charge, mais `refundReservation` ne le fait pas.

Sans abonné aujourd'hui, donc sans effet visible. Mais `DomainEvents` est la
frontière entre modules : un contrat faux se paiera au premier auditeur branché.

### 3. Un `NOOP` marque l'événement traité définitivement

`refund-ledger.service.ts:172-180` : si le paiement n'est pas dans un statut
attendu, le service journalise et rend `NOOP` sans lever. Le contrôleur appelle
alors `markWebhookProcessed`, et l'événement ne sera **jamais** rejoué.

Un `refund.*` livré hors séquence — avant `payment_intent.succeeded` — est donc
perdu, sauf si `charge.refunded` est également abonné (voir la section « avant
mise en ligne », qui devient de ce fait doublement importante).

### 4. Le budget de réessai est consommé deux fois plus vite qu'annoncé

`apps/api/src/modules/payments/payment.service.ts:288-300` incrémente
`attempt_count` à chaque réception, et `:316-325` (`markWebhookFailed`)
l'incrémente **encore** en cas d'échec. Un événement empoisonné consomme donc
2 unités par tentative : `MAX_WEBHOOK_ATTEMPTS = 10` en vaut 5 en pratique.

Au-delà, `shouldProcess` devient faux et le contrôleur journalise « duplicate
webhook ignored » en niveau `info`. Un remboursement définitivement abandonné
produit donc une ligne d'information, pas une alerte.

### 5. Le verrou de ligne est tenu pendant l'appel réseau à Stripe

`payment.service.ts:229-233` pose un `SELECT ... FOR UPDATE` sur `payments`, et
la même transaction appelle Stripe quelques lignes plus bas (`:241`, délai de
10 s, 2 réessais). Une livraison de webhook concurrente sur le même paiement
bloque pendant toute cette fenêtre en tenant une connexion, alors que le pool est
à `max: 10` (`packages/database/src/client.ts`).

L'appel réseau en transaction était assumé par la conception ; le verrou élargit
le rayon d'action. La scission de la transaction est repoussée à un lot suivant.

### 6. Les tests d'annulation n'exercent pas la transaction

`apps/api/test/cancel-already-refunded.integration.test.ts` : quatre des cinq
appels (`:186`, `:259`, `:283`, `:320`) passent `db` directement, alors que
l'appelant réel (`apps/api/src/modules/bookings/booking.service.ts:297`) passe
`tx`. Seul `:369` utilise une vraie transaction.

Hors transaction, `SELECT ... FOR UPDATE` relâche son verrou à la fin de
l'instruction et chaque écriture s'auto-commite. Le test « fournisseur en panne
→ aucune écriture partielle » passe donc mécaniquement : il n'y a rien à annuler.
L'atomicité du chemin d'annulation n'est réellement exercée que par un seul test.

### 7. Tests prévus par le plan et non écrits

- Livraison hors séquence de `payment_intent.succeeded` **après** un
  remboursement : la garde existe (`payment.service.ts:96`) mais n'est pas testée.
- Retraitement d'un événement en échec (comptage des tentatives) — non écrit
  parce que la valeur attendue par le plan semblait fausse, à trancher avec le
  point 4 ci-dessus.
- Rejeu dans un ordre aléatoire (test de convergence de la projection).
- `replayFailedWebhooks` et `checkRefundLedgerDrift` n'ont **aucun** test.
- Le chemin de rattrapage de la migration `0004` (base arrêtée à `0003`
  contenant déjà des remboursements) n'est pas couvert : la migration n'a été
  éprouvée que sur la base de développement existante.

---

## V1.1 — Connexion sociale : Apple + Google (Facebook reporté)

Chantier planifié le 17 août 2026, non commencé. Périmètre arbitré par Nassim :
**e-mail (OTP existant) + Google + Apple**. Facebook écarté du lancement.

**Apple n'est pas une option.** Dès qu'un fournisseur social tiers apparaît dans
une app iOS, Apple impose *Sign in with Apple* comme option équivalente. Le
périmètre n'est donc pas « deux fournisseurs au choix » mais **« Google implique
Apple »**.

### Trois faits vérifiés qui changent la forme du chantier

1. **La table d'identités existe déjà, et elle est vide.** `auth_identities`
   (`packages/database/src/schema/identity.ts:102-121`, migrée en
   `0000_init.sql:56-62`) porte le bon index unique sur
   `(provider, provider_account_id)` et le bon commentaire — « the provider's
   stable subject claim, never the email ». **Aucun code ne la lit ni ne
   l'écrit** : la seule occurrence est un `TRUNCATE` dans le seed. Vérifié en
   base : 0 ligne, 5 colonnes. `ADR-003:36-38` annonçait déjà cette voie. Il
   reste à l'exécuter, pas à la décider.
2. **Le coût caché n'est pas le serveur, c'est le premier build natif.**
   `apps/mobile` n'a pas de `eas.json`, aucun plugin natif d'authentification, et
   son client de dev est câblé pour Expo Go — où les SDK Apple et Google **ne
   fonctionnent pas**. Il faut un build de développement EAS, ce que le projet
   n'a jamais fait. C'est le lot dont l'estimation est la moins fiable.
3. **Un blocage App Store indépendant du sujet, sur le même chemin critique.**
   `users.anonymized_at` (`identity.ts:31`) n'est écrit par **aucun** code —
   vérifié : la colonne n'apparaît que dans sa déclaration. Il n'existe aucun
   endpoint de suppression de compte (les seuls `@Delete` sont favoris et
   images). Apple l'exige (règle 5.1.1(v)) dès qu'une app permet de créer un
   compte. **Publier sans ce lot expose à un rejet.** 2 à 3 jours.

### Rattachement, pas fusion

Distinction à tenir : **rattacher** une nouvelle porte d'entrée à un compte
existant (une ligne dans `auth_identities`, réversible) n'est pas **fusionner**
deux comptes déjà peuplés (réécrire `user_id` sur réservations, paiements,
essais, prospects, adhésions — et arbitrer les conflits).

**La V1.1 fait du rattachement.** La fusion est un chantier à part, à outiller
quand un cas réel se présente. Ce qu'on peut faire dès maintenant, c'est éviter
de fabriquer les doublons — très différent de savoir les réparer.

### Les quatre gardes contre la prise de contrôle de compte

Sans elles, un fournisseur qui affirme une adresse non vérifiée permet de
s'emparer d'un compte — et si la victime est gérante, l'attaquant hérite de ses
adhésions dans le JWT, donc du **fichier prospects du partenaire**.

1. Pas de vérification du fournisseur, pas de rattachement. L'e-mail affirmé est
   stocké mais ne sert **jamais** de clé de recherche.
2. **Un compte avec un rôle non-`USER` ou une adhésion `business_members` ne se
   rattache jamais automatiquement** — code par e-mail exigé.
3. Nonce à usage unique émis par le serveur, stocké haché, brûlé à la
   consommation — le mécanisme d'`otp_codes`, déjà éprouvé.
4. Chaque création, rattachement et refus passe par `AuditService.record`.

Le contrat `oauthLoginSchema` (`packages/contracts/src/schemas/auth.ts:37-44`)
existe déjà et n'est consommé par aucun endpoint. Bon squelette — il porte déjà
`provider: ['GOOGLE','APPLE']` et le piège du nom Apple — mais **il manque le
nonce** (lacune la plus sérieuse : sans lui un jeton capté est rejouable),
l'`attribution` et la `locale`.

### Deux cas à assumer, pas à résoudre

- **Relais Apple.** « Masquer mon adresse » donne une adresse
  `privaterelay.appleid.com` routable. Le compte fonctionne — mais le domaine
  d'envoi doit être déclaré chez Apple, SPF compris. **Symptôme d'oubli : le
  client ne reçoit pas son code de check-in, sans aucune erreur côté API.**
- **Doublon inévitable.** Une personne inscrite en OTP qui revient par Apple en
  masquant son adresse crée un second compte. Rien ne permet de les relier.
  Remède : le proposer à l'écran (« tu as déjà un compte ? »), pas le découvrir
  au support.

Décision tranchée : **`users.email` reste `NOT NULL`**, et un compte social sans
e-mail utilisable est refusé. Cinq chemins lisent cette colonne sans envisager le
nul, et `viewerSchema.email` est obligatoire — le rendre nullable serait un
changement de contrat public sur les quatre apps.

### Estimation

Minimum viable **12 à 15 jours** de développement : socle serveur agnostique
(3–4 j, testable avec un adaptateur factice **avant** toute réponse d'Apple),
premier build natif (2–3 j, estimation la moins fiable), Google mobile (1,5–2 j),
Apple mobile (1,5–2 j), écran de connexion (1,5–2 j), durcissement et tests
(2 j). Puis le web (1,5–2 j) — excellent rapport qualité-prix, il réutilise le
même endpoint. Plus la suppression de compte (2–3 j), obligatoire pour publier.

**Il n'y a pas de plus petit lot** : Google seul sur iOS est interdit, Apple seul
n'apporte presque rien sur un marché belge majoritairement Android, et sans les
gardes ci-dessus on ouvre une voie de prise de contrôle.

**Chemin critique administratif :** compte Apple Developer, ~99 €/an. En
**individuel** : actif en 24–48 h. En **société** : exige un numéro D-U-N-S,
5 jours ouvrés à 2 semaines, pendant lesquels rien n'avance — ni Apple, ni le
build iOS, ni Google Android (qui attend l'empreinte SHA-1 du build).

### Pourquoi Facebook est reporté — et ce que ça coûte plus tard

Raison technique autant que budgétaire : Google et Apple émettent un **jeton
d'identité signé**, vérifiable hors ligne contre un JWKS en cache — leur panne ne
nous touche pas. Facebook émet un **jeton d'accès opaque**, à échanger contre
l'API de Meta **à chaque connexion** : un incident chez eux devient un incident
chez nous.

Vérifié : concevoir pour deux plutôt que trois **ne ferme aucune porte**. La
table, les règles de rattachement et le port sont génériques ; Facebook entrerait
comme fournisseur « non fiable pour l'e-mail », donc automatiquement dans la
branche « code par e-mail obligatoire ». **Une seule précaution, gratuite, à
prendre maintenant** : nommer le champ du contrat de façon neutre (`credential`
plutôt que `idToken`), ou en union discriminée sur `provider`. Avec elle, ajouter
Facebook coûte 3–4 j ; sans elle, 0,5–1 j de plus **et** un changement de contrat
public propagé aux quatre apps.

### Décisions en attente de Nassim

1. Compte Apple en **individuel** plutôt qu'en société, pour démarrer en 48 h ? →
   recommandé **oui** (le D-U-N-S bloque tout le reste ; transfert possible après)
2. Rattachement automatique sur e-mail vérifié par le fournisseur ? → recommandé
   **oui pour un client ordinaire, non pour un gérant ou un admin**
3. Compte social sans e-mail utilisable refusé ? → recommandé **oui**
4. Assumer le doublon du relais Apple ? → recommandé **oui**, en le proposant à
   l'écran
5. V1.1 limitée au rattachement, sans outil de fusion d'historiques ? → recommandé
   **oui**
6. Google sur les tableaux de bord web dans le même chantier ? → recommandé
   **oui** (1,5 j, même endpoint, Apple non obligatoire sur le web)

### Note d'architecture

Le port `IdentityProvider` doit rendre une **identité vérifiée** dans notre
vocabulaire (sujet opaque, e-mail affirmé, vérifié oui/non, relais oui/non, nom),
jamais un jeton — modèle exact de `payment-provider.ts`. Les SDK natifs mobiles
sont inévitables mais `apps/mobile` **n'est pas le domaine** : l'invariant 5
protège `apps/api` et `packages/*`. Formulation retenue : **le SDK natif produit
une preuve, jamais une décision.**

Exception assumée à la logique de `token.service.ts:35-42` (qui explique pourquoi
le projet écrit son propre HS256) : ici on vérifie les jetons **de quelqu'un
d'autre**, avec RS256 imposé, rotation de clés et sélection par `kid`. La
bibliothèque `jose` est recommandée, confinée aux deux adaptateurs. L'invariant 5
interdit les SDK **fournisseur** dans le domaine, pas la cryptographie générique.

---

## Découvert le 17 août 2026, pendant le chantier « inscription autonome »

### 1. `drizzle-kit generate` produit une migration destructrice

La chaîne de snapshots est cassée **depuis `0001`** : `generate` ne produit pas
un delta, il rejoue **tout l'historique depuis `0000`**. Personne ne l'avait
remarqué parce que toutes les migrations depuis ont été écrites à la main.

Le piège est silencieux et sérieux : quelqu'un finira par lancer `generate`,
obtenir un fichier plausible, et l'appliquer. **Continuer à écrire les migrations
à la main** en attendant, comme le reste du dépôt le fait déjà. Réparer la chaîne
demande de régénérer les snapshots depuis un état connu — chantier à part.

### 2. `BusinessDetailDto` vit en double sans garantie croisée

`apps/api/src/modules/business/business-dto.mapper.ts` et
`packages/api-client/src/endpoints.ts` décrivent la même forme, **chacun de son
côté**. Aucune compilation ne les compare : le jour où l'un change, l'autre ment
en silence.

C'est la même famille que le trigger SQL retiré ce jour-là — une seconde source
de vérité non protégée par le typage. `updateBusinessSchema` est dans le même
cas, construit côté API à partir des briques de `contracts` plutôt que canonisé.

À trancher par `contracts-guardian` : faut-il faire monter `updateBusinessSchema`
et `businessDetailSchema` dans `packages/contracts` ? Mon avis : oui pour le
second, qui traverse la frontière client-serveur ; le premier est discutable
puisqu'il ne sert qu'à l'API.

---

## Découvert le 16 août 2026, en corrigeant le registre de remboursements

Quatre dettes mises au jour par trois passages de relecture successifs sur
`928cbd7`. Aucune n'est introduite par ce lot ; toutes préexistaient.

### 1. `markSucceeded` verrouille encore dans le mauvais ordre

`apps/api/src/modules/payments/payment.service.ts:110-151` verrouille `payments`
puis `reservations`, l'inverse du chemin d'annulation. Interblocage `40P01`
reproduit. Déclencheur réel et fréquent : l'utilisateur annule une réservation
`PAYMENT_PENDING` au moment où `payment_intent.succeeded` arrive.

Le registre de remboursements a été aligné (`reservations` d'abord, en
`FOR KEY SHARE`) ; ce chemin-ci ne l'est pas. Correction : faire précéder
l'`UPDATE payments` du même `FOR KEY SHARE`. Lot dédié — le fusionner au lot
remboursements aurait rouvert le périmètre qui a fait échouer deux tentatives.

**À savoir avant d'y toucher :** `refunds.reservation_id` porte une clé étrangère
(`0000_init.sql:601`), donc **Postgres verrouille lui-même** la ligne
`reservations` en `FOR KEY SHARE` à chaque `INSERT INTO refunds`, sans que le
code le demande. C'est invisible à la lecture et c'est ce qui a trompé trois
relectures. Et dans `confirmReservationOnCapture`, l'écriture doit rester un
`UPDATE` nu : il prend `FOR NO KEY UPDATE`, compatible avec `FOR KEY SHARE`.
Le « durcir » en `SELECT ... FOR UPDATE` fait repartir deux remboursements
concurrents en interblocage — vérifié.

### 2. `netPlatformFee` ne filtre pas par statut

`apps/api/src/modules/admin/admin-browse.service.ts:191` calcule
`platformFeeAmount - refundedPlatformFeeAmount` sans clause de statut, là où
l'agrégat de `moderation.service.ts:318-320` porte bien
`WHERE status IN ('SUCCEEDED','PARTIALLY_REFUNDED','REFUNDED')`.

Portée réelle vérifiée : champ **par ligne**, dans aucune somme, et aucun
consommateur dans `apps/admin`. Un test de caractérisation existe et tombera le
jour du correctif. Sans urgence, mais à ne pas oublier.

### 3. Un worktree fantôme fausse les chiffres de test

`.claude/worktrees/sad-merkle-1005af` (branche `claude/sad-merkle-1005af`) vit
dans l'arborescence, et `vitest.integration.config.mts` n'exclut que
`node_modules` et `dist`. **Chaque fichier d'intégration tourne donc deux fois**,
la seconde contre le code d'une autre branche.

Effet mesuré : la suite annonce 132 tests là où cette branche en compte **72**,
et `booking-concurrency.integration.test.ts` paraît en compter 14 alors qu'il en
a **7**. Les chiffres de preuve de plusieurs rapports de cette session étaient
gonflés pour cette raison.

Correction : ajouter `.claude/**` aux exclusions des deux configurations vitest.
**Ne pas supprimer le worktree sans regarder** : il porte du travail non commité
sur l'émission d'événements après commit, dont un test
`domain-events-after-commit.integration.test.ts` qui n'existe pas sur `main`.

### 4. `PaymentSucceeded` émis sur un remboursement total

`refund-ledger.service.ts:637` — `capturedPayment` reste non nul même quand la
réservation n'est délibérément pas confirmée. Inerte aujourd'hui (aucun abonné à
`PaymentSucceeded`), mais c'est un piège posé pour le premier qui en ajoutera un.

---

## Le message du commit `3f6a144` est inexact — à savoir avant de s'y fier

Le commit qui aligne la commission sur 25 % se termine par :

> « Vérifié de bout en bout après migration et re-seed, sur un paiement Stripe
> réel : 1,75 € prélevés sur 7,00 € encaissés. »

**« Prélevés » est faux au sens Stripe.** Les 1,75 € sont enregistrés en base
(`platform_fee_amount`), pas prélevés par Stripe. Le `PaymentIntent` porte
`application_fee_amount: null`.

Cause mécanique, vérifiée : `stripe.provider.ts:49-53` ne pose
`application_fee_amount` et `transfer_data` que si `connectedAccountId` est
renseigné. **Aucun appelant ne le renseigne jamais** — le champ n'existe que dans
le type (`payment-provider.ts:16`) et dans cette condition. `payment.service.ts:61`
calcule bien la commission, puis elle est écartée avant l'appel. La colonne
`stripeAccountId` existe en base (`catalog.ts:89`) et n'est pas utilisée.

Le code est correct pour un suivi en base ; c'est la phrase qui promet plus. Rien
à corriger dans `3f6a144` — un message de commit est immuable — mais **ne pas s'en
servir comme preuve qu'un flux Connect fonctionne**. Brancher réellement Stripe
Connect (transfert vers le compte de la salle) est un chantier à part entière,
non planifié à ce jour.

Conséquence commerciale directe : en démo, « vous recevez directement votre part »
est faux tant que Connect n'est pas branché. Aujourd'hui, la plateforme encaisse
la totalité et doit reverser elle-même.

---

## À arbitrer

Deux décisions qui débordent du périmètre technique.

### `REFUND_FAILED` est mappé sur HTTP 500

`packages/contracts/src/errors.ts:108`. Quand l'échec vient de Stripe et non de
nous, ce classement est trompeur pour l'appelant. Le corriger touche les quatre
applications à la fois — c'est un changement de contrat public, pas un détail
d'implémentation.

### ~~Le taux de commission par défaut est encore à 1500~~ — fait, sauf l'arbitrage

Les quatre endroits sont traités (`3f6a144`) : défaut de colonne, valeur codée en
dur du flux d'inscription (supprimée), seed, et la migration
`0005_commission_default.sql`. Un test d'intégration
(`apps/api/test/onboarding-commission-default.integration.test.ts`) échoue
désormais si une salle naît à autre chose que 2500 — vérifié dans les deux sens,
défaut ramené à 1500 puis restauré.

**Ce qui reste à arbitrer, et qui est une vraie décision commerciale :** un
changement de défaut ne touche que les futures lignes. Les salles existantes sont
toutes à 1500 par héritage, **aucune ne l'a négocié** — mais rien dans le schéma
ne distingue une salle laissée au défaut d'une salle à qui l'on aurait consenti
15 %. Un `UPDATE` global romprait donc des accords qu'on ne sait pas relire.

À trancher : les remonter à 2500 salle par salle, ou les laisser à 15 % comme
tarif historique. Ce n'est pas une tâche de code.
