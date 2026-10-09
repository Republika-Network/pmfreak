import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { isSafeContinuationRoute } from "../src/lib/auth/validate-continuation-route.ts";
import {
  PAID_PLANS,
  PENDING_PLAN_STORAGE_KEY,
  PENDING_PLAN_TTL_MS,
  clearPendingPlan,
  isCheckoutContinuation,
  parsePaidPlanTier,
  readPendingPlan,
  savePendingPlan,
} from "../src/lib/billing-plans.ts";

const memoryStorage = () => {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => void map.set(k, String(v)),
    removeItem: (k) => void map.delete(k),
    map,
  };
};

// ── Continuation: a signed-out plan choice can come back to /billing ────────

test("/billing is a safe post-auth continuation, with or without a plan query", () => {
  assert.equal(isSafeContinuationRoute("/billing"), true);
  assert.equal(isSafeContinuationRoute("/billing?plan=pmo"), true);
});

test("adding /billing does not open look-alike or off-origin continuations", () => {
  for (const route of ["/billingx", "//evil.example/billing", "https://evil.example/billing", "/api/billing/create-checkout-session", "/billing\n/x", "/pricing"]) {
    assert.equal(isSafeContinuationRoute(route), false, route);
  }
});

test("isCheckoutContinuation recognises only the billing purchase flow", () => {
  assert.equal(isCheckoutContinuation("/billing"), true);
  assert.equal(isCheckoutContinuation("/billing?plan=pro"), true);
  for (const next of [undefined, null, "", "/billingx", "/command-center", "/billing/../admin"]) {
    assert.equal(isCheckoutContinuation(next), false, String(next));
  }
});

// ── Plan catalogue ──────────────────────────────────────────────────────────

test("plan amounts are unchanged", () => {
  assert.deepEqual(PAID_PLANS, {
    pro: { name: "Pro", price: "$49", period: "/ month" },
    pmo: { name: "PMO", price: "$199", period: "/ month" },
  });
});

test("parsePaidPlanTier accepts only the two checkout tiers", () => {
  assert.equal(parsePaidPlanTier("pro"), "pro");
  assert.equal(parsePaidPlanTier("pmo"), "pmo");
  for (const value of ["free", "enterprise", "PRO", "", undefined, null, 1, ["pro"]]) {
    assert.equal(parsePaidPlanTier(value), null, String(value));
  }
});

// ── Pending plan storage ────────────────────────────────────────────────────

test("a saved plan round-trips and stores only the tier and a timestamp", () => {
  const storage = memoryStorage();
  savePendingPlan(storage, "pmo", 1_000);
  assert.equal(readPendingPlan(storage, 2_000), "pmo");
  assert.deepEqual(Object.keys(JSON.parse(storage.map.get(PENDING_PLAN_STORAGE_KEY))).sort(), ["savedAt", "tier"]);
});

test("an expired or future-dated plan is discarded", () => {
  const storage = memoryStorage();
  savePendingPlan(storage, "pro", 0);
  assert.equal(readPendingPlan(storage, PENDING_PLAN_TTL_MS), null);
  assert.equal(storage.map.has(PENDING_PLAN_STORAGE_KEY), false);
  savePendingPlan(storage, "pro", 10_000);
  assert.equal(readPendingPlan(storage, 5_000), null);
});

test("a tampered or malformed record is discarded, never trusted", () => {
  const storage = memoryStorage();
  for (const raw of ['{"tier":"enterprise","savedAt":1}', '{"tier":"pro"}', "not json", '{"tier":"pro","savedAt":"1"}']) {
    storage.setItem(PENDING_PLAN_STORAGE_KEY, raw);
    assert.equal(readPendingPlan(storage, 2), null, raw);
  }
});

test("clearPendingPlan removes the record, and unavailable storage never throws", () => {
  const storage = memoryStorage();
  savePendingPlan(storage, "pro", 1);
  clearPendingPlan(storage);
  assert.equal(readPendingPlan(storage, 2), null);
  const broken = { getItem() { throw new Error("denied"); }, setItem() { throw new Error("denied"); }, removeItem() { throw new Error("denied"); } };
  assert.doesNotThrow(() => savePendingPlan(broken, "pro"));
  assert.equal(readPendingPlan(broken), null);
  assert.doesNotThrow(() => clearPendingPlan(broken));
});

// ── Wiring ──────────────────────────────────────────────────────────────────

const pricing = readFileSync("src/app/pricing/page.tsx", "utf8");
const billingClient = readFileSync("src/app/(protected)/billing/billing-client.tsx", "utf8");
const billingPage = readFileSync("src/app/(protected)/billing/page.tsx", "utf8");

test("pricing hands paid plans to /billing instead of calling the checkout API without workspace context", () => {
  assert.doesNotMatch(pricing, /create-checkout-session/);
  assert.match(pricing, /href=\{`\/billing\?plan=\$\{plan\.tier\}`\}/);
  assert.match(pricing, /savePendingPlan\(window\.localStorage, plan\.tier/);
  assert.match(pricing, /mailto:sales@pmfreak\.ai/);
});

test("billing resolves the workspace server-side and sends it to both billing routes", () => {
  assert.match(billingPage, /resolvePreferredWorkspace\(user\.id\)/);
  assert.match(billingPage, /parsePaidPlanTier\(/);
  assert.match(billingClient, /fetch\("\/api\/billing\/create-checkout-session", billingRequestInit\(workspaceId, plan\)\)/);
  assert.match(billingClient, /fetch\("\/api\/billing\/create-portal-session", billingRequestInit\(workspaceId\)\)/);
});

test("billing never starts a second subscription for a company that already pays", () => {
  assert.match(billingClient, /const hasPaidPlan = subscription\.plan !== "free"/);
  assert.match(billingClient, /hasPaidPlan \? \(/);
});
