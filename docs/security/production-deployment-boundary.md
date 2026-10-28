# Production Deployment Boundary — Perilla 10

## 1. What this perilla closes

Perillas 1-9 built and hardened PMFreak's **application** trust boundary:
signup role safety, workspace membership, invite acceptance, workspace role
updates, billing authorization, the Stripe webhook lifecycle, the Supabase
RLS/service-role boundary, route/server-guard consistency, and abuse
protection. Every one of those answers:

> Given a request that reaches the app, is it authorized/rate-limited
> correctly?

This perilla answers a different question, underneath all of them:

> Can the app itself be deployed to production without leaking secrets,
> accepting the wrong origins, exposing debug surfaces, running with an
> insecure env fallback, or behaving differently than intended because of
> broken configuration?

**A production-hardened repo must fail closed when secrets, origins,
deployment mode, or runtime configuration are unsafe.** Perfect
authorization code deployed with a leaked service-role key, a wildcard CORS
policy, or an unauthenticated debug route that dumps request internals is
not secure — the deployment configuration *is* part of the security
boundary.

## 2. Findings and fixes

| # | Issue | File | Risk |
|---|---|---|---|
| 1 | Stripe Checkout `success_url`/`cancel_url` were built directly from the request's `Origin` header with no allowlist check | `src/app/api/billing/create-checkout-session/route.ts` | An attacker could set an arbitrary `Origin` header to redirect a legitimately-authenticated user's post-payment browser flow to an attacker-controlled domain (phishing right after a real Stripe checkout). |
| 2 | `/api/debug-auth` had no production gate | `src/app/api/debug-auth/route.ts` | The paired page (`/debug-session`) is blocked in production by `src/proxy.ts`'s `isInternalDebugRoute` check, but that check only covers page routes — `/api/*` is passed straight through by the proxy regardless of environment, so the API endpoint itself stayed reachable in production, disclosing the caller's own id/email/companyId/role. |
| 3 | No centralized security response headers anywhere in the app | `next.config.ts` | No `X-Frame-Options`, `X-Content-Type-Options`, `Referrer-Policy`, `Permissions-Policy`, `Content-Security-Policy`, or `Strict-Transport-Security` on any response. |
| 4 | `experimental.serverActions.allowedOrigins` unconditionally trusted `localhost:3000`, `127.0.0.1:3000`, and `*.github.dev`/`*.app.github.dev` | `next.config.ts` | These dev/Codespaces-only origins were trusted for Server Action CSRF-origin checks even in a production build. |
| 5 | `NEXT_PUBLIC_APP_URL` had no production validation and no enforced allowlist of what counts as a public env var | new `src/lib/security/environment.ts`, `deployment-boundary-registry.ts` | A missing/invalid/localhost `NEXT_PUBLIC_APP_URL` in production silently degraded early-access invite links (and now redirect/CORS origin resolution) rather than failing a deploy-time check. |
| 6 | No single helper for CORS/origin/redirect decisions | new `src/lib/security/origin-policy.ts` | Any future CORS or redirect code was one hand-rolled `headers.set("Access-Control-Allow-Origin", origin)` away from wildcard-with-credentials or origin reflection. (No such pattern existed yet — this closes the gap before it opens.) |
| 7 | No centralized secret-redaction/safe-error helper | new `src/lib/security/redaction.ts` | Several modules already redact known object *keys* (`telemetry.ts`, `abuse-protection.ts`, the `agent-*-validation.ts` files); nothing redacted secret-*shaped strings* wherever they occur, or turned a caught provider error into a safe, bounded message in one call. |

None of Perillas 1-9's authorization, RLS, webhook, or abuse-limit behavior
was changed by this pass.

## 3. Environment variable inventory

Full machine-readable inventory:
`src/lib/security/deployment-boundary-registry.ts`
(`ENV_VAR_INVENTORY`, `ALLOWED_PUBLIC_ENV_VARS`, `SERVER_ONLY_ENV_VARS`,
`REQUIRED_PRODUCTION_ENV_VARS`).

| Env var | Public/Server-only | Required in prod | Used by | Risk |
|---|---|---|---|---|
| `SUPABASE_SERVICE_ROLE_KEY` | server-only | yes | `src/lib/security/privileged-access.ts`, `src/lib/supabase/env.ts` | Full RLS bypass if leaked. |
| `NEXT_PUBLIC_SUPABASE_URL` | public | yes | `src/lib/supabase/*` | Low — project URL only. |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | public | yes | `src/lib/supabase/*` | Low — RLS is the real boundary (Perilla 7). |
| `STRIPE_SECRET_KEY` | server-only | yes | `src/lib/stripe.ts` | Full Stripe account access if leaked. |
| `STRIPE_WEBHOOK_SECRET` | server-only | yes | `src/app/api/billing/webhook/route.ts` | Forged billing events if leaked (Perilla 6). |
| `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` | public | no | Stripe.js client init | Designed to be public. |
| `STRIPE_PRO_PRICE_ID` / `STRIPE_PMO_PRICE_ID` | server-only | no | checkout route, billing lifecycle | Not secret, but must stay server-sourced. |
| `FOUNDER_OPERATOR_USER_IDS` | server-only | no (but see note) | `src/lib/auth.ts` | Sole source of operator authority (F6): comma-separated user ids. Unset/empty/malformed = no operators (fails closed). **Set it before deploying PR-4** or founders are locked out of every operator surface. Replaces `FOUNDER_EMAIL_ALLOWLIST` (no longer read). |
| `NEXT_PUBLIC_APP_URL` | public | yes | `src/lib/early-access.ts`, `src/lib/security/origin-policy.ts` | Missing/localhost in prod now fails `assertProductionEnvSafety()`. |
| `NEXT_PUBLIC_SITE_URL` | public | no (legacy alias) | `src/app/signup/actions.ts` | Kept for backward compatibility — see residuals. |
| `FEDERATION_WEBHOOK_SECRET` | server-only | no | federation webhook route | Missing = all events rejected (fails closed). |
| `ABUSE_HASH_PEPPER` | server-only | no | `src/lib/security/abuse-protection.ts` | Has a non-secret default. |
| `PMFREAK_TRUST_EVENT_HMAC_SECRET` / `PMFREAK_CAPABILITY_CLAIM_SECRET` / `PMFREAK_AGENT_TOKEN_SECRET` | server-only | no | AOC governance/trust/attestation modules | Each already throws if missing (fails closed). |
| `OPENAI_API_KEY` | server-only | no | AI provider modules | Provider key. |
| `RESEND_API_KEY` | server-only | no | `src/lib/email/provider.ts` | Email provider key. |

## 4. Public (`NEXT_PUBLIC_*`) boundary

`NEXT_PUBLIC_*` is bundled into client JavaScript by Next.js at build time —
it is public by definition, regardless of intent. The only variables this
repo names that way are:

```
NEXT_PUBLIC_SUPABASE_URL
NEXT_PUBLIC_SUPABASE_ANON_KEY
NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY
NEXT_PUBLIC_APP_URL
NEXT_PUBLIC_SITE_URL
NEXT_PUBLIC_BUILD_TIMESTAMP
NEXT_PUBLIC_ENABLE_RUNTIME_VALIDATION
```

This exact list is `ALLOWED_PUBLIC_ENV_VARS` in
`deployment-boundary-registry.ts`. `tests/production-deployment-boundary.test.mjs`
fails if:
- any `NEXT_PUBLIC_*` reference appears in `src/**` that isn't in this list, or
- any currently-set `NEXT_PUBLIC_*` env var name contains `SECRET`,
  `SERVICE_ROLE`, `PRIVATE`, `WEBHOOK`, `TOKEN`, `PASSWORD`, `HMAC`,
  `CREDENTIAL`, or `API_KEY` (case-insensitive).

`src/lib/security/environment.ts`'s `assertServerOnlyEnvBoundary()` runs the
same secret-shaped-name check at runtime against whatever the hosting
platform actually injected — a static scan can't see platform-only env
values, so this is the belt to the source-scan's suspenders.

## 5. Server-only secret boundary

`SERVER_ONLY_ENV_VARS` in the registry lists every secret this repo reads.
None of them are read from a `"use client"` file, a browser helper
(`src/lib/supabase/client.ts` reads only the anon key + URL), or returned in
a JSON response body — enforced by
`tests/production-deployment-boundary.test.mjs`'s scan of every
`"use client"` file.

- `createSupabaseServiceRoleClient`/`createPrivilegedSupabaseClient`
  (`src/lib/security/privileged-access.ts`) throws
  (`getSupabaseServiceRoleEnv`) if `SUPABASE_SERVICE_ROLE_KEY` is missing —
  it never falls back to the anon key.
- `getStripeServerClient` (`src/lib/stripe.ts`) throws if `STRIPE_SECRET_KEY`
  is missing.
- The Stripe webhook route (`src/app/api/billing/webhook/route.ts`) returns
  400 without touching the database if `STRIPE_WEBHOOK_SECRET` is missing or
  the signature doesn't verify (Perilla 6, unchanged by this pass).

## 6. Origin / CORS / redirect policy

`src/lib/security/origin-policy.ts` is the single place origin/CORS/redirect
decisions are made:

- `getAllowedOrigins()` / `isAllowedOrigin(origin)` — the allowlist is built
  from `NEXT_PUBLIC_APP_URL`/`NEXT_PUBLIC_SITE_URL`/`APP_URL`, the static
  production Vercel domain, the current Vercel preview URL (preview env
  only), and — **only outside production** — `localhost:3000`,
  `127.0.0.1:3000`, and the `*.github.dev` Codespaces preview pattern.
  Production always rejects localhost/`.local` origins even if one were
  somehow configured.
- `buildCorsHeaders({ origin, allowCredentials, methods, headers })` never
  emits `Access-Control-Allow-Origin: *`, and never reflects an origin that
  isn't allowlisted — if the origin isn't allowed, the returned headers
  simply omit `Access-Control-Allow-Origin`, so the browser denies the
  cross-origin read by default. No route in this repo currently needs to
  call it (see `CORS_SURFACES` in the registry: the federation webhook is
  server-to-server and the trust `.well-known` route is public read-only
  metadata with no CORS headers set); it exists so the *next* CORS need
  doesn't get hand-rolled.
- `resolveTrustedOrigin(requestOrigin)` — resolves a request's `Origin`
  header against the allowlist, falling back to the canonical app origin
  instead of ever trusting the header directly. Used by the Stripe checkout
  route fix above (finding #1).
- `resolveSafeRedirectUrl({ requestedUrl, fallbackPath, baseUrl })` —
  general-purpose redirect validator: allows a single leading `/` relative
  path, allows an absolute URL only if its origin is allowlisted, and
  blocks everything else (`javascript:`, `data:`, `//evil.com`, unlisted
  external origins) by returning the fallback.
- For PMFreak's own internal post-auth continuation routes specifically,
  `src/lib/auth/validate-continuation-route.ts`'s `isSafeContinuationRoute`
  remains the enforced gate (used by `src/proxy.ts`, `src/app/api/login/route.ts`,
  `src/app/auth/callback/route.ts`, `src/app/signup/actions.ts`) — it already
  implemented exactly this pattern (relative-path-only, blocks `//`, blocks
  control characters, allowlists internal path prefixes) before this perilla
  and needed no change. `resolveSafeRedirectUrl` is the newer, more general
  helper for any redirect target, internal or external.

## 7. Debug / health / build-info routes

Classified in `DEBUG_HEALTH_BUILD_ROUTES` (registry):

| Route | Exposure | Notes |
|---|---|---|
| `/api/health` | public | status, app name, package version, adapter names/count, startup timing. No env dump. |
| `/api/build-info` | public | commit SHA, branch, Vercel env label, build timestamp. No env dump. |
| `/api/route-debug` | public | commit SHA, branch, Vercel env label, hardcoded routing-decision constants. No env dump. |
| `/api/runtime/hardening` | founder-internal | Gated by `requireAuthUser` + `isFounderOrInternalUser` (Perilla 8, unchanged). |
| `/api/debug-auth` | disabled in production | **Fixed this pass** — now returns 404 when `getRuntimeEnvironment() === "production"`. |
| `/debug-session` (page) | disabled in production | Already blocked by `src/proxy.ts`'s `isInternalDebugRoute` check. |

## 8. Security headers

`src/lib/security/security-headers.ts`'s `getSecurityHeaders()` is applied
to every response via `next.config.ts`'s `headers()`:

- `X-Content-Type-Options: nosniff`
- `X-Frame-Options: DENY`
- `Referrer-Policy: strict-origin-when-cross-origin`
- `Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=(self), usb=(), interest-cohort=()`
- `Content-Security-Policy` — `default-src 'self'`, `object-src 'none'`,
  `frame-ancestors 'self'`, `script-src`/`style-src` include
  `'unsafe-inline'` (residual, see §11)
- `Strict-Transport-Security: max-age=63072000; includeSubDomains; preload`
  — production and preview only

## 9. Stripe live/test and Supabase project boundary

- `STRIPE_SECRET_KEY`/`STRIPE_WEBHOOK_SECRET` are read once per process
  (`src/lib/stripe.ts`) — there is exactly one Stripe key pair per
  deployment/env, so live/test mixing is prevented by whichever single key
  the hosting platform injects for that environment, not by app logic
  choosing between two.
- `evaluateProductionEnvSafety()` requires `STRIPE_SECRET_KEY` and
  `STRIPE_WEBHOOK_SECRET` to be present in production; it does not (and
  cannot, from an env var's shape alone) verify a key is a `sk_live_...` key
  rather than `sk_test_...` — that's an operational/platform-config
  concern, documented here as a residual.
- Supabase project boundary: `NEXT_PUBLIC_SUPABASE_URL` +
  `SUPABASE_SERVICE_ROLE_KEY` are read from the same env source, so an
  operator pointing the anon key at project A and the service-role key at
  project B would already break basic app function (not silently — auth and
  DB calls would fail against the wrong project), not something this pass
  adds new validation for.
- `.env.operational-flow.example` already carries an explicit, prominent
  warning to never point its variables at a production Supabase project
  (unchanged by this pass).

## 10. Error/log redaction

`src/lib/security/redaction.ts`:

- `redactSecretLikeValues(input)` — deep-walks any JSON-like value,
  replacing secret-*shaped values* (`sk_live_...`, `sk_test_...`,
  `whsec_...`, JWT-shaped strings, `Bearer <token>`, `service_role...`)
  wherever they appear, and redacting the *value* of any key whose name
  looks sensitive (`secret`, `token`, `password`, `authorization`, `cookie`,
  `webhook`, `hmac`, `apikey`, `privatekey`), regardless of that value's own
  shape.
- `safeErrorMessage(error)` — turns any caught error into a short,
  redacted string with no stack trace. Wired into the Stripe checkout
  route's failure log (finding #1's file) in this pass. Existing
  per-module key redaction (`telemetry.ts`, `abuse-protection.ts`, the
  `agent-*-validation.ts` files, `connector-error-normalizer.ts`) is
  unchanged — this is a new, general-purpose helper for the cases those
  don't cover, not a replacement.
- The Stripe webhook route (`src/app/api/billing/webhook/route.ts`) already
  logs only `error.message` (never the raw error object or the request
  body) on every failure path — unchanged by this pass.

## 11. Known residual risks

- **CSP is not a full nonce/hash-based policy.** `script-src`/`style-src`
  include `'unsafe-inline'` because Next.js's own inline hydration scripts
  require it; a nonce-based CSP is real future work but is explicitly out
  of scope for this pass (see "do not overbuild").
- **No external secret manager integration.** Secrets are sourced from
  platform env vars only, as before.
- **HSTS depends on the platform/proxy.** The app emits the header;
  whether the TLS-terminating edge forwards it unmodified is outside this
  repo's control.
- **`NEXT_PUBLIC_SITE_URL` and `NEXT_PUBLIC_APP_URL` are two names for the
  same concept** (legacy Supabase-redirect usage vs. current
  origin-policy/early-access usage). Unifying them is a broader refactor,
  intentionally out of scope here; both are documented and allowlisted.
- **Preview deployments explicitly allow the current `VERCEL_URL` origin**
  and, in non-production environments generally, `localhost`/`*.github.dev`
  — by design, so local and Codespaces development keep working.
- **`productionBrowserSourceMaps` is pinned to `false` (Next's own
  default)** rather than actively audited on the hosting platform.
- **Stripe live/test key correctness** (as opposed to *presence*) is an
  operational/platform-config concern, not something an env-shape check can
  verify — see §9.
- **Logs outside this repo** (hosting platform log aggregation, any
  external log sink) are not audited by this pass.

## 12. How tests enforce this boundary

`tests/production-deployment-boundary.test.mjs`:

- registry/allowlist existence and shape (public envs, server-only envs,
  required-production envs, debug-route classification, CORS surfaces)
- no `NEXT_PUBLIC_*SECRET*`/`SERVICE_ROLE*`/`PRIVATE*`/`WEBHOOK*`/`TOKEN*`/
  `PASSWORD*`/`HMAC*` names anywhere in `src/**`
- every `NEXT_PUBLIC_*` reference in `src/**` is in `ALLOWED_PUBLIC_ENV_VARS`
- no `SERVER_ONLY_ENV_VARS` name appears in any `"use client"` file
- no `Access-Control-Allow-Origin: *` combined with
  `Access-Control-Allow-Credentials: true` anywhere in `src/**`
- no hand-rolled `headers.set("Access-Control-Allow-Origin", origin)`
  origin-reflection pattern outside `origin-policy.ts` itself
- `isAllowedOrigin`/`buildCorsHeaders`/`resolveSafeRedirectUrl`/
  `resolveTrustedOrigin` unit behavior (localhost rejected in production,
  no wildcard+credentials, malicious redirect targets blocked, safe
  fallbacks preserved)
- `redactSecretLikeValues`/`safeErrorMessage` unit behavior
- `getSecurityHeaders()` includes the minimum header set, HSTS only in
  production/preview
- `next.config.ts` pins `productionBrowserSourceMaps: false` and
  environment-gates dev-only Server Action origins
- `/api/debug-auth` and `/api/health`/`/api/build-info`/`/api/route-debug`
  source files contain no `process.env` dump / `headers()` dump / `cookies()`
  dump patterns beyond their documented allowlisted fields
