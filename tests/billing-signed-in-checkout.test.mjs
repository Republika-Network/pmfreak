// Signed-in purchase flow: /billing → billing routes, end to end on the server side.
//
// Every request is built by billingRequestInit — the exact function the /billing
// client uses — and runs through the REAL route handlers and the REAL
// requireBillingManageMembership / canManageBilling logic. Only the edges are
// faked: auth user, the workspace_memberships row, the subscription store and the
// Stripe client (no network, test-mode env values). Nothing here can reach Stripe.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { handleCreateCheckoutSession } from "../src/app/api/billing/create-checkout-session/route.ts";
import { handleCreatePortalSession } from "../src/app/api/billing/create-portal-session/route.ts";
import { requireBillingManageMembership } from "../src/lib/workspace-access.ts";
import { billingRequestInit } from "../src/lib/billing-plans.ts";
import { isEligibleForPlanReturn } from "../src/lib/billing-plan-return.ts";

const WORKSPACE = "ws-owned";
const state = { user: null, memberships: {}, subscription: null, stripeCalls: [] };

// workspace_memberships lookup keyed by the workspace the request names.
function fakeSupabaseClient() {
  const filters = {};
  return {
    from(table) {
      assert.equal(table, "workspace_memberships");
      const q = {
        select: () => q,
        eq: (column, value) => { filters[column] = value; return q; },
        maybeSingle: async () => ({ data: filters.user_id === state.user?.id ? state.memberships[filters.workspace_id] : undefined }),
      };
      return q;
    },
  };
}

function fakeStripe() {
  return {
    customers: { create: async (args) => { state.stripeCalls.push({ fn: "customers.create", args }); return { id: "cus_new" }; } },
    checkout: { sessions: { create: async (args, options) => { state.stripeCalls.push({ fn: "checkout.sessions.create", args, options }); return { id: "sess_1", url: "https://stripe.test/checkout/sess_1" }; } } },
    billingPortal: { sessions: { create: async (args) => { state.stripeCalls.push({ fn: "billingPortal.sessions.create", args }); return { id: "bps_1", url: "https://stripe.test/portal/bps_1" }; } } },
  };
}

const deps = {
  getAuthUser: async () => state.user,
  requireBillingManageMembership: (input) => requireBillingManageMembership(input, async () => fakeSupabaseClient()),
  getCompanySubscription: async () => state.subscription,
  updateCompanySubscription: async (_companyId, patch) => (state.subscription = { ...state.subscription, ...patch }),
  getStripeServerClient: fakeStripe,
  enforceAbuseLimit: async () => ({ allowed: true, key: "test" }),
};

const checkout = (workspaceId, plan) =>
  handleCreateCheckoutSession(new Request("https://app.test/api/billing/create-checkout-session", billingRequestInit(workspaceId, plan)), deps);
const portal = (workspaceId) =>
  handleCreatePortalSession(new Request("https://app.test/api/billing/create-portal-session", billingRequestInit(workspaceId)), deps);
const stripeCheckoutCalls = () => state.stripeCalls.filter((c) => c.fn === "checkout.sessions.create");

test.beforeEach(() => {
  state.user = { id: "user-1", email: "owner@example.com", fullName: "Owner", companyId: "company-1", companyName: "Acme", role: "viewer", onboardingCompleted: true };
  state.memberships = { [WORKSPACE]: { role: "owner" } };
  state.subscription = { plan: "free", subscriptionStatus: "inactive", stripeCustomerId: null, stripeSubscriptionId: null, currentPeriodEnd: null };
  state.stripeCalls = [];
  process.env.STRIPE_SECRET_KEY = "sk_test_fake";
  process.env.STRIPE_WEBHOOK_SECRET = "whsec_test_fake";
  process.env.STRIPE_PRO_PRICE_ID = "price_test_pro";
  process.env.STRIPE_PMO_PRICE_ID = "price_test_pmo";
});

// ── The request /billing builds ─────────────────────────────────────────────

test("billingRequestInit names the workspace and carries only the plan", () => {
  const init = billingRequestInit(WORKSPACE, "pmo");
  assert.equal(init.method, "POST");
  assert.equal(init.headers["x-pmf-workspace-id"], WORKSPACE);
  assert.deepEqual(JSON.parse(init.body), { plan: "pmo" });
  const portalInit = billingRequestInit(WORKSPACE);
  assert.equal(portalInit.body, undefined);
  assert.equal(portalInit.headers["x-pmf-workspace-id"], WORKSPACE);
});

// ── Authorized owners/admins reach Stripe with the chosen plan ──────────────

for (const role of ["owner", "admin"]) {
  for (const [plan, priceId] of [["pro", "price_test_pro"], ["pmo", "price_test_pmo"]]) {
    test(`${role} on /billing checks out ${plan} with the server-side price id`, async () => {
      state.memberships[WORKSPACE] = { role };
      const response = await checkout(WORKSPACE, plan);
      assert.equal(response.status, 200);
      assert.equal((await response.json()).url, "https://stripe.test/checkout/sess_1");
      const [call] = stripeCheckoutCalls();
      assert.equal(call.args.line_items[0].price, priceId);
      assert.deepEqual(call.args.metadata, { companyId: "company-1", plan });
      assert.match(call.args.success_url, /\/billing\?success=true$/);
      assert.match(call.args.cancel_url, /\/billing\?canceled=true$/);
      assert.equal(call.options.idempotencyKey, `checkout:company-1:${plan}`);
    });
  }
}

// ── Everyone else is refused before Stripe ──────────────────────────────────

for (const role of ["pm", "viewer"]) {
  test(`${role} is refused checkout and the portal, and Stripe is never called`, async () => {
    state.memberships[WORKSPACE] = { role };
    assert.equal((await checkout(WORKSPACE, "pro")).status, 403);
    assert.equal((await portal(WORKSPACE)).status, 403);
    assert.equal(state.stripeCalls.length, 0);
  });
}

test("naming a workspace the user does not belong to is refused (the header grants nothing)", async () => {
  const response = await checkout("ws-someone-else", "pmo");
  assert.equal(response.status, 403);
  assert.equal(state.stripeCalls.length, 0);
});

test("signed-out requests are refused with 401 before any lookup", async () => {
  state.user = null;
  assert.equal((await checkout(WORKSPACE, "pro")).status, 401);
  assert.equal(state.stripeCalls.length, 0);
});

test("a tampered plan in the body is rejected before Stripe", async () => {
  for (const plan of ["enterprise", "free", "PMO"]) {
    const request = new Request("https://app.test/api/billing/create-checkout-session", {
      method: "POST",
      headers: { "x-pmf-workspace-id": WORKSPACE, "Content-Type": "application/json" },
      body: JSON.stringify({ plan }),
    });
    assert.equal((await handleCreateCheckoutSession(request, deps)).status, 400, plan);
  }
  assert.equal(stripeCheckoutCalls().length, 0);
});

test("without Stripe configured, checkout fails closed and never calls Stripe", async () => {
  delete process.env.STRIPE_SECRET_KEY;
  assert.equal((await checkout(WORKSPACE, "pro")).status, 503);
  assert.equal(state.stripeCalls.length, 0);
});

test("an owner opens the billing portal with the same workspace context", async () => {
  state.subscription.stripeCustomerId = "cus_existing";
  const response = await portal(WORKSPACE);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).url, "https://stripe.test/portal/bps_1");
});

// ── Post-onboarding return offer ────────────────────────────────────────────

test("the return-to-Billing offer needs complete onboarding, a billing role, and not being on /billing", () => {
  const ok = { onboardingState: "active", role: "owner", pathname: "/command-center" };
  assert.equal(isEligibleForPlanReturn(ok), true);
  assert.equal(isEligibleForPlanReturn({ ...ok, role: "admin" }), true);
  for (const onboardingState of ["no_workspace", "needs_project", "needs_task", "execution_started", "trial_blocked"]) {
    assert.equal(isEligibleForPlanReturn({ ...ok, onboardingState }), false, onboardingState);
  }
  for (const role of ["pm", "viewer", null]) {
    assert.equal(isEligibleForPlanReturn({ ...ok, role }), false, String(role));
  }
  for (const pathname of ["/billing", "/billing/anything"]) {
    assert.equal(isEligibleForPlanReturn({ ...ok, pathname }), false, pathname);
  }
  assert.equal(isEligibleForPlanReturn({ ...ok, pathname: null }), true);
});

test("the layout only adds the offer: no redirect or gate depends on it", () => {
  const layout = readFileSync("src/app/(protected)/layout.tsx", "utf8");
  assert.match(layout, /const offerPlanReturn = isEligibleForPlanReturn\(\{ onboardingState, role: resolvedWorkspace\.role, pathname: routedHeaders\.get\("x-pathname"\) \}\);/);
  assert.match(layout, /\{offerPlanReturn \? <PendingPlanReturn \/> : null\}\{children\}/);
  assert.equal((layout.match(/offerPlanReturn/g) ?? []).length, 2, "used once, for rendering only");
  const component = readFileSync("src/components/billing/pending-plan-return.tsx", "utf8");
  assert.doesNotMatch(component, /fetch\(|create-checkout-session|window\.location/, "the offer never starts checkout");
  assert.match(component, /href=\{`\/billing\?plan=\$\{plan\}`\}/);
});

test("/billing uses the shell's validated workspace and spends a choice it cannot act on", () => {
  const page = readFileSync("src/app/(protected)/billing/page.tsx", "utf8");
  assert.match(page, /resolvePreferredWorkspace\(user\.id\)/);
  assert.doesNotMatch(page, /resolveCanonicalWorkspace/);
  assert.match(page, /canManageBilling\(role\)/);
  const client = readFileSync("src/app/(protected)/billing/billing-client.tsx", "utf8");
  assert.match(client, /if \(hasPaidPlan \|\| !canManageBilling\) clearPendingPlan\(window\.localStorage\)/);
  assert.equal((client.match(/billingRequestInit\(workspaceId/g) ?? []).length, 2);
  assert.doesNotMatch(client, /useEffect\([^)]*createCheckoutSession/, "checkout is never started automatically");
});
