/**
 * Deployment boundary registry — Perilla 10 (Production Secrets / Env /
 * CORS / Deployment Boundary Hardening).
 *
 * A classification inventory for PMFreak's environment variables, debug/
 * health/build-info routes, and CORS/webhook surfaces — the deployment-time
 * counterpart to `route-guard-registry.ts` (Perilla 8) and
 * `abuse-protection-registry.ts` (Perilla 9). Enforced by
 * tests/production-deployment-boundary.test.mjs.
 *
 * See docs/security/production-deployment-boundary.md for the full policy
 * this registry documents.
 */

export type EnvVisibility = "public" | "server-only";

export type EnvVarEntry = {
  readonly name: string;
  readonly visibility: EnvVisibility;
  readonly requiredInProduction: boolean;
  readonly usedBy: string;
  readonly risk: string;
};

/**
 * Every `NEXT_PUBLIC_*` variable this repo actually reads. This is the
 * allowlist tests/production-deployment-boundary.test.mjs checks every
 * `NEXT_PUBLIC_` reference in `src/**` against — an unlisted one fails the
 * test, forcing a conscious decision (add here + confirm it's genuinely
 * public, or stop naming it NEXT_PUBLIC_).
 */
export const ALLOWED_PUBLIC_ENV_VARS: readonly string[] = [
  "NEXT_PUBLIC_SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_ANON_KEY",
  "NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY",
  "NEXT_PUBLIC_APP_URL",
  "NEXT_PUBLIC_SITE_URL",
  "NEXT_PUBLIC_BUILD_TIMESTAMP",
  "NEXT_PUBLIC_ENABLE_RUNTIME_VALIDATION",
] as const;

/**
 * Server-only secret env vars. Must never appear in a `"use client"` file,
 * in a JSON response body, or logged unredacted.
 */
export const SERVER_ONLY_ENV_VARS: readonly string[] = [
  "SUPABASE_SERVICE_ROLE_KEY",
  "STRIPE_SECRET_KEY",
  "STRIPE_WEBHOOK_SECRET",
  "FOUNDER_EMAIL_ALLOWLIST",
  "FEDERATION_WEBHOOK_SECRET",
  "PMFREAK_TRUST_EVENT_HMAC_SECRET",
  "PMFREAK_CAPABILITY_CLAIM_SECRET",
  "PMFREAK_AGENT_TOKEN_SECRET",
  "ABUSE_HASH_PEPPER",
  "RESEND_API_KEY",
  "OPENAI_API_KEY",
] as const;

/** Env vars required to be present (and, where applicable, valid) in production — see environment.ts `evaluateProductionEnvSafety`. */
export const REQUIRED_PRODUCTION_ENV_VARS: readonly string[] = [
  "SUPABASE_SERVICE_ROLE_KEY",
  "STRIPE_SECRET_KEY",
  "STRIPE_WEBHOOK_SECRET",
  "NEXT_PUBLIC_SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_ANON_KEY",
  "NEXT_PUBLIC_APP_URL",
] as const;

export const ENV_VAR_INVENTORY: readonly EnvVarEntry[] = [
  { name: "SUPABASE_SERVICE_ROLE_KEY", visibility: "server-only", requiredInProduction: true, usedBy: "src/lib/security/privileged-access.ts, src/lib/supabase/env.ts", risk: "Full-database-bypass key. Client exposure = total RLS bypass for any user." },
  { name: "NEXT_PUBLIC_SUPABASE_URL", visibility: "public", requiredInProduction: true, usedBy: "src/lib/supabase/*, src/lib/db/supabase-server.ts", risk: "Project URL, not sensitive on its own." },
  { name: "NEXT_PUBLIC_SUPABASE_ANON_KEY", visibility: "public", requiredInProduction: true, usedBy: "src/lib/supabase/*", risk: "Anon key is designed to be public; RLS is the actual boundary (Perilla 7)." },
  { name: "STRIPE_SECRET_KEY", visibility: "server-only", requiredInProduction: true, usedBy: "src/lib/stripe.ts", risk: "Full Stripe account access if leaked to a client." },
  { name: "STRIPE_WEBHOOK_SECRET", visibility: "server-only", requiredInProduction: true, usedBy: "src/app/api/billing/webhook/route.ts", risk: "Leak lets an attacker forge Stripe webhook events (Perilla 6)." },
  { name: "NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY", visibility: "public", requiredInProduction: false, usedBy: "Stripe.js client init (not yet wired client-side)", risk: "Designed to be public." },
  { name: "STRIPE_PRO_PRICE_ID", visibility: "server-only", requiredInProduction: false, usedBy: "src/app/api/billing/create-checkout-session/route.ts, src/lib/billing-webhook-lifecycle.ts", risk: "Not a secret, but must be server-sourced — a client-suppliable price id would let a user choose their own plan price." },
  { name: "STRIPE_PMO_PRICE_ID", visibility: "server-only", requiredInProduction: false, usedBy: "same as STRIPE_PRO_PRICE_ID", risk: "Same as STRIPE_PRO_PRICE_ID." },
  { name: "FOUNDER_EMAIL_ALLOWLIST", visibility: "server-only", requiredInProduction: false, usedBy: "src/lib/auth.ts", risk: "Grants founder/internal access; combined with hardcoded @pmfreak.ai/@onchainfest.xyz domain allowlist (Perilla 5) — an empty value is safe-by-default (no extra grants), not a fail-open condition." },
  { name: "NEXT_PUBLIC_APP_URL", visibility: "public", requiredInProduction: true, usedBy: "src/lib/early-access.ts, src/lib/security/origin-policy.ts", risk: "Used to build absolute links (invite emails) and as an allowlisted redirect/CORS origin; missing or localhost in production degrades to broken/insecure links." },
  { name: "NEXT_PUBLIC_SITE_URL", visibility: "public", requiredInProduction: false, usedBy: "src/app/signup/actions.ts (Supabase emailRedirectTo)", risk: "Legacy alias for the same app base URL as NEXT_PUBLIC_APP_URL — kept for backward compatibility, see residual risks in docs." },
  { name: "FEDERATION_WEBHOOK_SECRET", visibility: "server-only", requiredInProduction: false, usedBy: "src/app/api/federation/webhooks/[connectorId]/route.ts", risk: "Shared secret authorizing federation event ingestion; feature is opt-in per workspace." },
  { name: "ABUSE_HASH_PEPPER", visibility: "server-only", requiredInProduction: false, usedBy: "src/lib/security/abuse-protection.ts", risk: "Pepper for abuse-key hashing; has a non-secret default, rotate via env for stronger guarantees." },
  { name: "PMFREAK_TRUST_EVENT_HMAC_SECRET", visibility: "server-only", requiredInProduction: false, usedBy: "src/lib/security/trust-coordination.ts", risk: "Signs/verifies trust events for the AOC governance surface." },
  { name: "PMFREAK_CAPABILITY_CLAIM_SECRET", visibility: "server-only", requiredInProduction: false, usedBy: "src/lib/security/governance-capability.ts, src/lib/aoc/adapters/trust-domain.ts", risk: "Signs capability claims. Required at readiness when PMFREAK_GOVERNANCE_CAPABILITY_ENABLED=true; otherwise flows degrade with an explicit governance_capability_disabled error (fails closed, M-03)." },
  { name: "PMFREAK_GOVERNANCE_CAPABILITY_ENABLED", visibility: "server-only", requiredInProduction: false, usedBy: "src/lib/security/governance-capability.ts, src/app/api/ready/route.ts", risk: "Deployment switch for governance claim signing. Not a secret; when true, /api/ready fails unless PMFREAK_CAPABILITY_CLAIM_SECRET is set." },
  { name: "PMFREAK_AGENT_TOKEN_SECRET", visibility: "server-only", requiredInProduction: false, usedBy: "src/lib/security/agent-attestation.ts", risk: "Verifies agent attestation tokens; throws if missing (fails closed)." },
  { name: "PMFREAK_FOUNDER_PROGRAM_ENABLED", visibility: "server-only", requiredInProduction: false, usedBy: "src/lib/founder-program/config.ts (and the OPERATOR_UI/INVITATIONS/APPLICATIONS/ACTIVATION/FEEDBACK/ANALYTICS sibling flags, same resolver)", risk: "Deployment switch family for the closed Founder Circle program. Not secrets; every flag defaults OFF and only the literal string \"true\" enables — an unknown environment runs with the whole program disabled (fail-closed), and the DB settings row must additionally enable it." },
  { name: "PMFREAK_BILLING_CHECKOUT_ENABLED", visibility: "server-only", requiredInProduction: false, usedBy: "src/lib/billing-release.ts (create-checkout-session and create-portal-session routes; /pricing, /billing, login/signup and the protected layout read the resolved boolean)", risk: "Release switch for paid checkout. Not a secret; defaults OFF and only the literal string \"true\" enables, so Stripe credentials alone can never start charging. Turn on only after signed-in checkout and the webhook return flow are verified in Stripe test mode." },
];

export type RouteExposure = "public" | "founder-internal" | "disabled-in-production";

export type DebugRouteEntry = {
  readonly path: string;
  readonly exposure: RouteExposure;
  readonly exposes: string;
};

/**
 * Every debug/health/build-info-shaped route in the repo. Enforced by
 * tests/production-deployment-boundary.test.mjs, which source-scans each
 * file for env dumps / header dumps / cookie dumps.
 */
export const DEBUG_HEALTH_BUILD_ROUTES: readonly DebugRouteEntry[] = [
  { path: "src/app/api/health/route.ts", exposure: "public", exposes: "status, app name, package version, adapter names/count, startup timing — no env values, no secrets." },
  { path: "src/app/api/build-info/route.ts", exposure: "public", exposes: "commit SHA, branch, Vercel env label, build timestamp — no env dump, no secrets." },
  { path: "src/app/api/route-debug/route.ts", exposure: "public", exposes: "commit SHA, branch, Vercel env label, hardcoded routing-decision constants — no env dump, no secrets." },
  { path: "src/app/api/runtime/hardening/route.ts", exposure: "founder-internal", exposes: "internal runtime health/degraded-mode/invariant detail — gated by requireAuthUser + isFounderOrInternalUser (Perilla 8)." },
  { path: "src/app/api/debug-auth/route.ts", exposure: "disabled-in-production", exposes: "the caller's own id/email/companyId/role, used only by /debug-session for local dev; returns 404 when getRuntimeEnvironment() === 'production'." },
  { path: "src/app/debug-session/page.tsx", exposure: "disabled-in-production", exposes: "client session, cookies, and /api/debug-auth response for the current browser session; blocked by src/proxy.ts's isInternalDebugRoute check in production." },
];

export type CorsSurfaceEntry = {
  readonly path: string;
  readonly public: boolean;
  readonly credentials: boolean;
  readonly notes: string;
};

/** Every route that currently sets (or, for federation, could plausibly need) CORS response headers. */
export const CORS_SURFACES: readonly CorsSurfaceEntry[] = [
  {
    path: "src/app/api/federation/webhooks/[connectorId]/route.ts",
    public: false,
    credentials: false,
    notes: "Server-to-server webhook ingestion authenticated by FEDERATION_WEBHOOK_SECRET (requireSystemOrWebhookSecret), not a browser origin — no CORS headers are set because no browser client calls it cross-origin.",
  },
  {
    path: "src/app/api/governance/trust/.well-known/capability-issuer/route.ts",
    public: true,
    credentials: false,
    notes: "Read-only trust-domain discovery metadata (no secrets, no user data, no mutation) intended for external verifier consumption. Does not set explicit CORS headers today; if browser-based external verifiers are added, must use buildCorsHeaders() with allowCredentials: false rather than a hand-rolled wildcard.",
  },
];

export const WEBHOOK_SURFACES: readonly string[] = [
  "src/app/api/billing/webhook/route.ts", // STRIPE_WEBHOOK_SECRET, fails closed (Perilla 6)
  "src/app/api/federation/webhooks/[connectorId]/route.ts", // FEDERATION_WEBHOOK_SECRET, fails closed
];

/** Residual risks intentionally left open by this pass — see docs/security/production-deployment-boundary.md §11. */
export const KNOWN_PRODUCTION_RESIDUALS: readonly string[] = [
  "Content-Security-Policy allows 'unsafe-inline' for script-src/style-src (Next.js inline hydration scripts) — a full nonce/hash-based CSP is out of scope for this pass.",
  "No external secret manager integration — secrets are sourced from platform env vars only.",
  "HSTS is emitted by the app layer but ultimately depends on the TLS-terminating platform/proxy actually forwarding it unmodified.",
  "NEXT_PUBLIC_SITE_URL and NEXT_PUBLIC_APP_URL are two names for the same concept (legacy vs current); unifying them is a broader refactor out of scope here.",
  "productionBrowserSourceMaps is left at Next's default (false/unset) rather than explicitly pinned in next.config.ts.",
];
