// Public plan catalogue and the "plan chosen before signing in" record.
// Client-safe (no server imports): used by /pricing and the /billing client.
// Amounts are display copy only — Stripe price ids stay server-side
// (STRIPE_PRO_PRICE_ID / STRIPE_PMO_PRICE_ID in create-checkout-session).

export type PaidPlanTier = "pro" | "pmo";

export const PAID_PLANS: Record<PaidPlanTier, { name: string; price: string; period: string }> = {
  pro: { name: "Pro", price: "$49", period: "/ month" },
  pmo: { name: "PMO", price: "$199", period: "/ month" },
};

export function parsePaidPlanTier(value: unknown): PaidPlanTier | null {
  return value === "pro" || value === "pmo" ? value : null;
}

// A visitor who picks a plan on /pricing may need to sign in, sign up, confirm
// their email and finish onboarding before /billing is reachable — and the
// proxy's login bounce keeps only the pathname of `next`. So the choice is kept
// in this browser for a bounded time and offered again on /billing. It holds the
// tier only: never prices, identity or workspace data.
export const PENDING_PLAN_STORAGE_KEY = "pmf.pendingCheckoutPlan";
export const PENDING_PLAN_TTL_MS = 7 * 24 * 60 * 60 * 1000;

type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export function savePendingPlan(storage: StorageLike, tier: PaidPlanTier, now = Date.now()): void {
  try {
    storage.setItem(PENDING_PLAN_STORAGE_KEY, JSON.stringify({ tier, savedAt: now }));
  } catch {
    // Storage can be unavailable (private mode, quota); the URL still carries the plan.
  }
}

export function readPendingPlan(storage: StorageLike, now = Date.now()): PaidPlanTier | null {
  try {
    const raw = storage.getItem(PENDING_PLAN_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { tier?: unknown; savedAt?: unknown };
    const tier = parsePaidPlanTier(parsed.tier);
    const fresh = typeof parsed.savedAt === "number" && now - parsed.savedAt >= 0 && now - parsed.savedAt < PENDING_PLAN_TTL_MS;
    if (!tier || !fresh) {
      storage.removeItem(PENDING_PLAN_STORAGE_KEY);
      return null;
    }
    return tier;
  } catch {
    return null;
  }
}

export function clearPendingPlan(storage: StorageLike): void {
  try {
    storage.removeItem(PENDING_PLAN_STORAGE_KEY);
  } catch {
    // Nothing to clear if storage is unavailable.
  }
}

/** Whether an auth `next` value leads back to the purchase flow on /billing. */
export function isCheckoutContinuation(next: string | null | undefined): boolean {
  return next === "/billing" || Boolean(next?.startsWith("/billing?"));
}

/**
 * The exact request /billing sends to the billing routes. Both routes authorize
 * against the membership named by x-pmf-workspace-id (owner/admin only), so the
 * header only names a workspace — it grants nothing by itself.
 */
export function billingRequestInit(workspaceId: string, plan?: PaidPlanTier): RequestInit {
  const headers: Record<string, string> = { "x-pmf-workspace-id": workspaceId };
  if (!plan) return { method: "POST", headers };
  return { method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify({ plan }) };
}
