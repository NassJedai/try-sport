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
