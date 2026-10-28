/**
 * F2 / GHSA-qrjm-vqq5-mjmj — billing and entitlements bound to the company id (the F1 root
 * cause, metadata-derived company id, is remediated by PR-1; these are its regression tests).
 *
 * Runs the REAL `/api/billing/state` route handler — `getAuthUser()` →
 * `getCompanySubscription(user.companyId)`, the same lookup checkout and the Customer
 * Portal route perform — and the REAL entitlement gate, as a signed-in fixture user (see
 * support/app-route-mocks.mjs). Tenant A holds a simulated Pro subscription with fake
 * Stripe ids. Before PR-1, the F1 spoof made tenant B's owner inherit A's plan and resolve
 * A's Stripe customer id — the id the portal route would open once billing is enabled.
 *
 * No Stripe call can happen: Stripe configuration and the billing release flag are
 * removed from this process, and the checkout/portal controls assert the 503 hard stop.
 */
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { bindAppEnvToHarness, createTenantFixtures, requireHarnessEnv, spoofCompanyId } from "./support/harness.mjs";
import { actAs, installAppRouteMocks } from "./support/app-route-mocks.mjs";

const env = requireHarnessEnv();
bindAppEnvToHarness(env);
installAppRouteMocks();

const { GET: billingStateGet } = await import("../../src/app/api/billing/state/route.ts");
const { POST: checkoutPost } = await import("../../src/app/api/billing/create-checkout-session/route.ts");
const { POST: portalPost } = await import("../../src/app/api/billing/create-portal-session/route.ts");
const { canUseAdvancedAi } = await import("../../src/lib/feature-gates.ts");

let fx;
let attacker;

before(async () => {
  fx = await createTenantFixtures(env, { label: "f2" });
  attacker = await fx.signIn(fx.users.bOwner);
  actAs(attacker);
});

after(async () => {
  if (fx) await fx.teardown();
});

const billingState = async () => {
  const response = await billingStateGet();
  assert.equal(response.status, 200, `billing state returned ${response.status}`);
  return response.json();
};

test("control: unspoofed tenant B owner sees the Free plan and no Stripe ids", async () => {
  const body = await billingState();
  assert.equal(body.subscription.plan, "free");
  assert.equal(body.subscription.stripeCustomerId, null);
});

test("control: tenant A's owner resolves their own simulated Pro subscription", async () => {
  const owner = await fx.signIn(fx.users.aOwner);
  actAs(owner);
  try {
    const body = await billingState();
    assert.equal(body.subscription.plan, "pro");
    assert.equal(body.subscription.stripeCustomerId, fx.victimStripe.customerId);
  } finally {
    actAs(attacker);
  }
});

test("control: unspoofed tenant B owner is not entitled to advanced AI", async () => {
  const gate = await canUseAdvancedAi(fx.users.bOwner.id);
  assert.equal(gate.ok, false);
});

test("attack setup: attacker rewrites own user_metadata.company_id to tenant A's id", async () => {
  await spoofCompanyId(attacker, fx.users.aOwner.id);
});

test("F1/F2: spoofed caller does not inherit tenant A's Pro plan", async () => {
  const body = await billingState();
  assert.equal(body.subscription.plan, "free", `spoofed caller resolved plan '${body.subscription.plan}'`);
});

test("F1/F2: spoofed caller never receives tenant A's Stripe customer id", async () => {
  const body = await billingState();
  assert.notEqual(body.subscription.stripeCustomerId, fx.victimStripe.customerId, "tenant A's Stripe customer id disclosed");
  assert.notEqual(body.subscription.stripeSubscriptionId, fx.victimStripe.subscriptionId, "tenant A's Stripe subscription id disclosed");
});

test("F1/F2: spoofed caller is not entitled to advanced AI via tenant A's plan", async () => {
  const gate = await canUseAdvancedAi(fx.users.bOwner.id);
  assert.equal(gate.ok, false, "advanced AI granted through tenant A's subscription");
});

const billingRequest = (path) =>
  new Request(`http://127.0.0.1:3000${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: "http://127.0.0.1:3000", "x-pmf-workspace-id": fx.workspaces.B },
    body: JSON.stringify({ plan: "pro" }),
  });

test("control: checkout stays hard-stopped (503) while the billing release flag is off", async () => {
  const response = await checkoutPost(billingRequest("/api/billing/create-checkout-session"));
  assert.equal(response.status, 503);
});

test("control: customer portal stays hard-stopped (503) while the billing release flag is off", async () => {
  const response = await portalPost(billingRequest("/api/billing/create-portal-session"));
  assert.equal(response.status, 503);
});
