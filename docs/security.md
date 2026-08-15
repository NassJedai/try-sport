# Security

The operating rule: **never trust the client**. Price, commission, role, payment
status, booking status and payout are all resolved server-side from ids. A
permission check in a React component is a UI affordance, never a control.

## Authentication

- **Consumers** sign in with an emailed one-time code. Codes are stored hashed
  (SHA-256), single-use, expire in 10 minutes and are attempt-capped at 5 —
  independently of IP rate limits, so a distributed attack on one code still fails.
- **Access tokens** are HS256, 15 minutes, carrying role and business memberships.
  The verifier pins the algorithm, so "alg: none" and RS256/HS256 confusion have
  no surface. Covered by `token.service.test.ts`.
- **Refresh tokens** are opaque, high-entropy, stored hashed and rotated on every
  use. Presenting an already-rotated token means it was stolen, so the entire
  token family is revoked — attacker and user both get logged out, which is the
  safe outcome.
- `POST /v1/auth/otp/request` always reports success. A different response for
  unknown addresses would make it an account-enumeration oracle.
- **Le transport e-mail est choisi d'après la configuration**, pas codé en dur :
  dès que `RESEND_API_KEY` est présente, l'envoi réel remplace la console. La
  validation de configuration exigeait déjà cette clé hors du développement
  local, mais le conteneur fournissait la console en dur — la clé était donc
  réclamée puis ignorée, et la production aurait écrit les codes de connexion
  dans ses journaux avec un démarrage parfaitement vert. Verrouillé par deux
  tests dans `app.module.test.ts`, un par branche.

## Authorisation

Roles: `USER`, `BUSINESS_MEMBER`, `ADMIN`, `SUPER_ADMIN`. Business roles:
`OWNER > MANAGER > STAFF`.

The auth guard is registered globally, so an endpoint is protected unless it
explicitly opts out — a forgotten decorator fails closed, not open.

Business scoping goes through `assertMember`, which reads the caller's verified
claims. A `businessId` in a URL is a lookup key, never a grant. Exercised by
`permissions.test.ts`, including that an OWNER of business A has no rights at B.

Deliberate split: front-desk **STAFF** can list today's bookings and check people
in, but cannot open the CRM — leads carry personal data. Overriding a check-in
window requires **MANAGER** and writes an audit record.

## Booking and payment integrity

- **Idempotency-Key is mandatory** on booking creation. The unique index on
  (user, endpoint, key) means concurrent duplicates collide rather than both
  proceeding. A *failed* attempt releases its key, so a transient error does not
  permanently poison the user's retry.
- **Capacity** is claimed with one conditional UPDATE and backed by a CHECK
  constraint.
- **Trial eligibility** is serialised with a transaction-scoped advisory lock on
  (user, venue); a read-then-write check is racy under READ COMMITTED.
- **Stripe webhooks** are verified against the raw body before parsing, then
  recorded under a unique constraint on the provider event id, so at-least-once
  redelivery cannot confirm a booking or charge twice.
- **Commission** is computed from the business's contract server-side, and
  `platform_fee + merchant = amount` is a database constraint.

## Check-in

The QR payload is `reservationId.code.HMAC`, signed with a secret distinct from
the session key. A reservation UUID alone is not a credential. Validation checks,
in order: signature, correct venue, time window, not already used — four distinct
errors, because staff need to tell a wrong-venue booking from a forgery.

## Rate limiting

Per user when authenticated, per IP otherwise — limiting purely by IP would
throttle everyone behind one mobile carrier gateway together.

| Endpoint | Limit |
| --- | --- |
| OTP request | 5 / 15 min |
| OTP verify | 10 / 15 min |
| Booking, payment | 20 / 5 min |
| Search | 120 / min |
| Review | 10 / hour |

## Transport and headers

Helmet on the API, HSTS in production. Explicit CORS allowlist — configuration
*refuses to boot* with `*` in production. The web apps set CSP, `X-Frame-Options:
DENY`, `nosniff` and `strict-origin-when-cross-origin`.

## Data protection

- **Logs are redacted at the sink** for passwords, tokens, client secrets, OTPs,
  QR tokens, cookies and authorization headers — centrally, not per call site.
  Tested in `logger.test.ts`.
- **`users` / `profiles` are separate tables** so a GDPR erasure drops personal
  data while leaving reservations and payment reconciliation intact.
- **Venues see a first name only**, plus an email if and only if the user
  consented at review time.
- **No card data ever touches TRY.** Only Stripe ids are stored.
- **Audit records are written in the same transaction** as the change they
  describe, so an approval cannot exist without its log entry.

## Known gaps

1. **Web tokens are in `localStorage`.** Defensible only alongside the strict CSP
   that blocks third-party scripts. The intended fix is httpOnly cookies issued
   by the API, which requires CSRF protection on every mutation.
2. **Admin MFA is not implemented.** The role check is enforced server-side, but
   a stolen admin password is currently sufficient. This is the highest-priority
   item here.
3. **Nothing has run against a real database yet** (see PROJECT_PLAN.md §11), so
   these guarantees are proven by construction and unit tests, not yet by the
   integration suite on real hardware.
