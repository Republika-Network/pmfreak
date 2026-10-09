// Billing release control: paid checkout is OFF unless PMFREAK_BILLING_CHECKOUT_ENABLED
// is exactly "true" — even when every Stripe credential is configured.
//
// The route handlers run for real. Every dependency is a spy, so the disabled
// cases prove that no auth, membership, abuse-limit or Stripe work happens at all.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { handleCreateCheckoutSession } from "../src/app/api/billing/create-checkout-session/route.ts";
import { handleCreatePortalSession } from "../src/app/api/billing/create-portal-session/route.ts";
import { requireBillingManageMembership } from "../src/lib/workspace-access.ts";
import { BILLING_CHECKOUT_FLAG, isBillingCheckoutEnabled } from "../src/lib/billing-release.ts";
import { billingRequestInit } from "../src/lib/billing-plans.ts";
import { ENV_VAR_INVENTORY } from "../src/lib/security/deployment-boundary-registry.ts";

const STRIPE_TEST_ENV = {
  STRIPE_SECRET_KEY: "sk_test_fake",
  STRIPE_WEBHOOK_SECRET: "whsec_test_fake",
  STRIPE_PRO_PRICE_ID: "price_test_pro",
  STRIPE_PMO_PRICE_ID: "price_test_pmo",
};
const NOT_TRUE = [undefined, "", "TRUE", "True", "1", "yes", "on", " true", "true ", "false", "enabled"];

const setEnv = (flag) => {
  Object.assign(process.env, STRIPE_TEST_ENV);
  if (flag === undefined) delete process.env[BILLING_CHECKOUT_FLAG];
  else process.env[BILLING_CHECKOUT_FLAG] = flag;
};

// Spies for every downstream dependency (owner membership, so only the flag can refuse).
function spyDeps() {
  const calls = [];
  const owner = { id: "user-1", email: "owner@example.com", fullName: "Owner", companyId: "company-1", companyName: "Acme", role: "viewer", onboardingCompleted: true };
  const fakeDb = async () => ({ from: () => { const q = { select: () => q, eq: () => q, maybeSingle: async () => ({ data: { role: "owner" } }) }; return q; } });
  const stripe = {
    customers: { create: async () => { calls.push("stripe.customers.create"); return { id: "cus_new" }; } },
    checkout: { sessions: { create: async () => { calls.push("stripe.checkout.sessions.create"); return { id: "sess", url: "https://stripe.test/checkout" }; } } },
    billingPortal: { sessions: { create: async () => { calls.push("stripe.billingPortal.sessions.create"); return { id: "bps", url: "https://stripe.test/portal" }; } } },
  };
  return {
    calls,
    deps: {
      getAuthUser: async () => { calls.push("getAuthUser"); return owner; },
      requireBillingManageMembership: (input) => { calls.push("requireBillingManageMembership"); return requireBillingManageMembership(input, fakeDb); },
      getCompanySubscription: async () => { calls.push("getCompanySubscription"); return { plan: "free", subscriptionStatus: "inactive", stripeCustomerId: "cus_existing", stripeSubscriptionId: null, currentPeriodEnd: null }; },
      updateCompanySubscription: async (_id, patch) => patch,
      getStripeServerClient: () => { calls.push("getStripeServerClient"); return stripe; },
      enforceAbuseLimit: async () => { calls.push("enforceAbuseLimit"); return { allowed: true, key: "test" }; },
    },
  };
}

const checkout = (deps, plan = "pro") =>
  handleCreateCheckoutSession(new Request("https://app.test/api/billing/create-checkout-session", billingRequestInit("ws-1", plan)), deps);
const portal = (deps) =>
  handleCreatePortalSession(new Request("https://app.test/api/billing/create-portal-session", billingRequestInit("ws-1")), deps);

// ── Resolver ────────────────────────────────────────────────────────────────

test("only the literal string \"true\" enables checkout", () => {
  assert.equal(isBillingCheckoutEnabled({ [BILLING_CHECKOUT_FLAG]: "true" }), true);
  for (const value of NOT_TRUE) {
    assert.equal(isBillingCheckoutEnabled(value === undefined ? {} : { [BILLING_CHECKOUT_FLAG]: value }), false, JSON.stringify(value));
  }
  assert.equal(isBillingCheckoutEnabled({ ...STRIPE_TEST_ENV }), false, "Stripe credentials alone never enable checkout");
});

// ── Disabled: refused before any other work, with Stripe fully configured ──

for (const flag of NOT_TRUE) {
  test(`flag ${JSON.stringify(flag)}: checkout and portal are refused before auth, membership, abuse limits or Stripe`, async () => {
    setEnv(flag);
    const { deps, calls } = spyDeps();
    for (const response of [await checkout(deps, "pro"), await checkout(deps, "pmo"), await portal(deps)]) {
      assert.equal(response.status, 503);
      const body = await response.json();
      assert.equal(body.code, "billing_checkout_disabled");
      assert.equal(body.url, undefined);
    }
    assert.deepEqual(calls, [], "nothing downstream ran");
  });
}

test("the handlers' own default reads the deployment env (no injected flag), so production is OFF by default", async () => {
  setEnv(undefined);
  const { deps, calls } = spyDeps();
  assert.equal("isBillingCheckoutEnabled" in deps, false);
  assert.equal((await checkout(deps)).status, 503);
  assert.equal((await portal(deps)).status, 503);
  assert.deepEqual(calls, []);
});

test("an injected false wins even when the env says true", async () => {
  setEnv("true");
  const { deps, calls } = spyDeps();
  assert.equal((await checkout({ ...deps, isBillingCheckoutEnabled: () => false })).status, 503);
  assert.deepEqual(calls, []);
});

// ── Enabled: the existing checks still run, in order ────────────────────────

test("flag \"true\": an owner reaches (faked) Stripe through auth, membership and abuse checks", async () => {
  setEnv("true");
  const { deps, calls } = spyDeps();
  const response = await checkout(deps, "pmo");
  assert.equal(response.status, 200);
  assert.deepEqual(calls.slice(0, 3), ["getAuthUser", "requireBillingManageMembership", "enforceAbuseLimit"]);
  assert.ok(calls.includes("stripe.checkout.sessions.create"));
});

test("flag \"true\": authentication and workspace context are still required", async () => {
  setEnv("true");
  const signedOut = spyDeps();
  assert.equal((await checkout({ ...signedOut.deps, getAuthUser: async () => null })).status, 401);
  const noWorkspace = spyDeps();
  const request = new Request("https://app.test/api/billing/create-checkout-session", { method: "POST", body: JSON.stringify({ plan: "pro" }) });
  assert.equal((await handleCreateCheckoutSession(request, noWorkspace.deps)).status, 403);
  assert.equal(noWorkspace.calls.some((c) => c.startsWith("stripe")), false);
});

// ── Registration and wiring ─────────────────────────────────────────────────

test("the flag is a documented, server-only, optional deployment switch", () => {
  const entry = ENV_VAR_INVENTORY.find((e) => e.name === BILLING_CHECKOUT_FLAG);
  assert.ok(entry, "registered in deployment-boundary-registry");
  assert.equal(entry.visibility, "server-only");
  assert.equal(entry.requiredInProduction, false);
  assert.match(readFileSync(".env.example", "utf8"), /^PMFREAK_BILLING_CHECKOUT_ENABLED=$/m, ".env.example leaves it empty (OFF)");
  assert.doesNotMatch(BILLING_CHECKOUT_FLAG, /^NEXT_PUBLIC_/);
});

test("both session routes gate on the flag first; the client never reads it", () => {
  for (const file of ["src/app/api/billing/create-checkout-session/route.ts", "src/app/api/billing/create-portal-session/route.ts"]) {
    const src = readFileSync(file, "utf8");
    const body = src.slice(src.indexOf("export async function handle"));
    const gate = body.indexOf("if (!deps.isBillingCheckoutEnabled())");
    assert.ok(gate > 0, `${file} checks the flag`);
    assert.ok(gate < body.indexOf("deps.getAuthUser()"), `${file} checks the flag before auth`);
    assert.match(src, /isBillingCheckoutEnabled: \(\) => isBillingCheckoutEnabled\(\)/, `${file} defaults to the env resolver`);
  }
  for (const file of ["src/app/pricing/pricing-view.tsx", "src/app/(protected)/billing/billing-client.tsx", "src/components/billing/pending-plan-return.tsx"]) {
    const src = readFileSync(file, "utf8");
    assert.match(src, /^"use client";/, file);
    assert.doesNotMatch(src, /from "@\/lib\/billing-release"|PMFREAK_BILLING_CHECKOUT_ENABLED|process\.env/, `${file} receives the boolean, never the flag`);
  }
});

test("UI follows the server's resolved flag on every surface", () => {
  assert.match(readFileSync("src/app/pricing/page.tsx", "utf8"), /<PricingView checkoutEnabled=\{isBillingCheckoutEnabled\(\)\} \/>/);
  const view = readFileSync("src/app/pricing/pricing-view.tsx", "utf8");
  assert.match(view, /plan\.tier && !checkoutEnabled \? \(/);
  assert.match(view, /Not available yet/);
  assert.match(view, /Paid plans aren&rsquo;t available for purchase yet\./);
  assert.ok(view.indexOf("plan.tier && !checkoutEnabled") < view.indexOf("href={`/billing?plan="), "the purchase link is only in the enabled branch");
  assert.match(view, /href="\/signup"/, "free signup stays available");
  assert.match(readFileSync("src/app/(protected)/billing/page.tsx", "utf8"), /checkoutEnabled=\{isBillingCheckoutEnabled\(\)\}/);
  const client = readFileSync("src/app/(protected)/billing/billing-client.tsx", "utf8");
  assert.match(client, /\{checkoutEnabled \? \(\n\s*<div className="mt-5 flex flex-wrap gap-3">/, "upgrade/manage buttons only when released");
  assert.match(client, /!checkoutEnabled \? \(\n\s*<p className="mt-1 text-sm text-slate-700">\n\s*You chose \{PAID_PLANS\[chosenPlan\]\.name\}, but paid checkout isn&rsquo;t open yet/);
  for (const file of ["src/app/login/page.tsx", "src/app/signup/page.tsx"]) {
    assert.match(readFileSync(file, "utf8"), /isCheckoutContinuation\(params\.next\) && isBillingCheckoutEnabled\(\)/, file);
  }
});
