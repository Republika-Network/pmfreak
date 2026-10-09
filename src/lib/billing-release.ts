/**
 * Billing checkout release control (server-side authoritative).
 *
 * The closed free beta takes no payments (docs/release/pilot-operational-
 * runbook.md §6). Stripe credentials alone must never be enough to start
 * charging: Stripe Checkout and Customer Portal sessions are created only when
 * this deployment switch is explicitly on.
 *
 * Same convention as the Founder Program flags (src/lib/founder-program/
 * config.ts): default OFF, and only the literal string "true" enables. Missing,
 * empty, "TRUE", "1", " true" or any other value keeps checkout disabled.
 *
 * BEFORE ENABLING, both must be done:
 *   1. Verify signed-in owner/admin checkout and the webhook return flow in an
 *      isolated Stripe test-mode environment.
 *   2. Resolve the billed-tenant binding (PR #636 review, P1): checkout
 *      authorizes against a workspace membership but bills the caller's own
 *      `user.companyId`, and workspaces carry no company id. An admin of
 *      another company's workspace would subscribe their own company.
 *
 * Read on the server only (route handlers and server components). It is not a
 * NEXT_PUBLIC_ variable, so client bundles never see it; client UI receives the
 * resolved boolean as a prop.
 */
export const BILLING_CHECKOUT_FLAG = "PMFREAK_BILLING_CHECKOUT_ENABLED";

type EnvLike = Record<string, string | undefined>;

export function isBillingCheckoutEnabled(env: EnvLike = process.env): boolean {
  return env[BILLING_CHECKOUT_FLAG] === "true";
}

/** Body of the 503 the billing routes return while checkout is disabled. */
export const BILLING_CHECKOUT_DISABLED_MESSAGE = "Paid plans aren't available for purchase yet.";
