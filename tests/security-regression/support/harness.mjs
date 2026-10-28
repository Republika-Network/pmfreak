/**
 * PR-0 security regression harness — shared support.
 *
 * Every test in tests/security-regression/ runs against a DISPOSABLE, LOOPBACK-ONLY
 * Supabase stack (the one release-governance.yml already starts, or a local
 * `supabase start`). This module is the single place that:
 *
 *   1. resolves the stack's URL/keys and REFUSES anything that is not loopback, and
 *      FAILS (never skips) when configuration is missing;
 *   2. builds isolated per-run fixtures (tenants A/B, owner/admin/pm/viewer, operators,
 *      Free and simulated Pro entitlements) and tears them down;
 *   3. provides `knownVulnerability()`, the strict expected-failure wrapper.
 *
 * It never prints keys, tokens or passwords. Fixture identities are random
 * `@example.test` (or deliberately internal-domain) addresses created per run.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

const ENV_SOURCES = {
  url: ["SECURITY_HARNESS_SUPABASE_URL", "OPERATIONAL_FLOW_TEST_SUPABASE_URL"],
  anonKey: ["SECURITY_HARNESS_ANON_KEY", "OPERATIONAL_FLOW_TEST_ANON_KEY"],
  serviceRoleKey: ["SECURITY_HARNESS_SERVICE_ROLE_KEY", "OPERATIONAL_FLOW_TEST_SERVICE_ROLE_KEY"],
};

/**
 * Resolves the disposable stack. Throws — failing the whole test file — when a value is
 * missing or the URL is not loopback. There is deliberately no skip path: a security
 * regression suite that silently skips is indistinguishable from one that passed.
 */
export function requireHarnessEnv() {
  const resolved = {};
  const missing = [];
  for (const [key, names] of Object.entries(ENV_SOURCES)) {
    const name = names.find((candidate) => process.env[candidate]);
    if (name) resolved[key] = process.env[name];
    else missing.push(names.join(" or "));
  }
  if (missing.length) {
    throw new Error(
      `[security-regression] Missing required configuration: ${missing.join("; ")}. ` +
        "Start a disposable local Supabase stack and export its values (see tests/security-regression/README.md). Refusing to skip.",
    );
  }
  let hostname;
  try {
    hostname = new URL(resolved.url).hostname;
  } catch {
    throw new Error("[security-regression] Supabase URL is not a valid URL. Refusing to run.");
  }
  if (!LOOPBACK_HOSTS.has(hostname)) {
    throw new Error(
      `[security-regression] Refusing non-loopback Supabase host '${hostname}'. This suite creates and deletes users and tenant data and may only target a disposable local stack.`,
    );
  }
  return resolved;
}

/**
 * Points the application modules under test at the disposable stack. Must be called
 * BEFORE importing anything from src/, because src/lib/supabase/env.ts reads these at
 * module load. Billing/Stripe configuration is removed so no code path can reach Stripe.
 */
export function bindAppEnvToHarness(env) {
  process.env.NEXT_PUBLIC_SUPABASE_URL = env.url;
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = env.anonKey;
  process.env.SUPABASE_SERVICE_ROLE_KEY = env.serviceRoleKey;
  for (const name of [
    "STRIPE_SECRET_KEY",
    "STRIPE_WEBHOOK_SECRET",
    "STRIPE_PRO_PRICE_ID",
    "STRIPE_PMO_PRICE_ID",
    "NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY",
    "PMFREAK_BILLING_CHECKOUT_ENABLED",
    "OPENAI_API_KEY",
  ]) {
    delete process.env[name];
  }
}

const clientOptions = { auth: { autoRefreshToken: false, persistSession: false } };

export function adminClient(env) {
  return createClient(env.url, env.serviceRoleKey, clientOptions);
}

const REGISTRY = JSON.parse(readFileSync(new URL("../known-vulnerabilities.json", import.meta.url), "utf8"));
const REGISTERED_CASES = new Map(REGISTRY.cases.map((entry) => [entry.id, entry]));

/**
 * Strict expected failure ("xfail") for a vulnerability that is STILL PRESENT.
 *
 * `secureExpectation` asserts the SECURE behaviour, unweakened. Outcomes:
 *   - it throws an AssertionError → the vulnerability reproduced: reported as
 *     EXPECTED FAILURE and the test passes;
 *   - it passes                    → the vulnerability no longer reproduces: the test
 *     FAILS ("UNEXPECTED PASS") so the fix PR must convert this case into a normal
 *     regression test and remove it from known-vulnerabilities.json;
 *   - it throws anything else      → infrastructure/setup error: the test FAILS. An
 *     environment problem can never be laundered into an "expected failure".
 */
export function knownVulnerability(caseId, title, secureExpectation) {
  const entry = REGISTERED_CASES.get(caseId);
  if (!entry) throw new Error(`[security-regression] '${caseId}' is not registered in known-vulnerabilities.json.`);
  test(`[EXPECTED FAILURE ${entry.finding} · ${caseId}] ${title}`, async (t) => {
    let failure = null;
    try {
      await secureExpectation(t);
    } catch (error) {
      failure = error;
    }
    if (failure === null) {
      assert.fail(
        `UNEXPECTED PASS ${caseId} (${entry.finding}): the secure expectation now holds. ` +
          `If ${entry.plannedFix} landed, convert this case to a regular test and remove it from known-vulnerabilities.json.`,
      );
    }
    if (!(failure instanceof assert.AssertionError)) throw failure;
    t.diagnostic(`EXPECTED FAILURE ${caseId} (${entry.finding}, fix: ${entry.plannedFix}): ${String(failure.message).split("\n")[0]}`);
  });
}

const runTag = () => `${Date.now().toString(36)}${randomBytes(3).toString("hex")}`;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Signs a fixture user in through real GoTrue. Retries only on rate limiting — local GoTrue
 * allows 30 sign-ins per 5 minutes per IP and CI's P0-LAUNCH-06 rehearsal signs in just
 * before this suite — with a cumulative backoff (~6 min) longer than one window, then
 * fails explicitly.
 */
export async function signIn(env, email, password) {
  const client = createClient(env.url, env.anonKey, clientOptions);
  for (let attempt = 1; attempt <= 8; attempt += 1) {
    const { data, error } = await client.auth.signInWithPassword({ email, password });
    if (!error && data.session) return client;
    const rateLimited = error && (error.status === 429 || /rate limit/i.test(error.message));
    if (!rateLimited) throw new Error(`[security-regression] sign-in failed for fixture ${email}: ${error?.message ?? "no session"}`);
    await sleep(attempt * 10_000);
  }
  throw new Error(`[security-regression] sign-in for fixture ${email} stayed rate limited; rerun after the GoTrue window resets.`);
}

async function must(promise, what) {
  const { data, error } = await promise;
  if (error) throw new Error(`[security-regression] fixture step failed (${what}): ${error.message}`);
  return data;
}

/**
 * Builds two isolated tenants for one test file:
 *   Tenant A: owner `aOwner` with a simulated Pro subscription (fake Stripe ids) and usage.
 *   Tenant B: `bOwner`, `bAdmin`, `bPm`, `bViewer` on the Free plan (no subscription row).
 * Extra users (operators, internal-domain probes) are created through `createUser`.
 * Every row is tagged with a per-run tag and removed by `teardown()`.
 */
export async function createTenantFixtures(env, { label }) {
  const admin = adminClient(env);
  const tag = `${label}-${runTag()}`;
  const password = randomBytes(18).toString("base64url");
  const createdUsers = [];
  const workspaceIds = [];

  async function createUser(localPart, { domain = "example.test", confirmed = true } = {}) {
    const email = `sec-${localPart}-${tag}@${domain}`.toLowerCase();
    const data = await must(
      admin.auth.admin.createUser({ email, password, email_confirm: confirmed, user_metadata: { full_name: `Harness ${localPart}` } }),
      `create user ${localPart}`,
    );
    const user = { id: data.user.id, email, password };
    createdUsers.push(user);
    return user;
  }

  async function createWorkspace(name, ownerId) {
    const row = await must(admin.from("workspaces").insert({ name, created_by_user_id: ownerId }).select("id").single(), `create workspace ${name}`);
    workspaceIds.push(row.id);
    return row.id;
  }

  async function addMember(workspaceId, userId, role) {
    await must(admin.from("workspace_memberships").insert({ workspace_id: workspaceId, user_id: userId, role }), `membership ${role}`);
  }

  async function createProject(workspaceId, userId, name) {
    const row = await must(admin.from("projects").insert({ workspace_id: workspaceId, user_id: userId, name }).select("id").single(), `project ${name}`);
    return row.id;
  }

  const aOwner = await createUser("a-owner");
  const bOwner = await createUser("b-owner");
  const bAdmin = await createUser("b-admin");
  const bPm = await createUser("b-pm");
  const bViewer = await createUser("b-viewer");

  const workspaceA = await createWorkspace(`Harness Tenant A ${tag}`, aOwner.id);
  const workspaceB = await createWorkspace(`Harness Tenant B ${tag}`, bOwner.id);
  await addMember(workspaceA, aOwner.id, "owner");
  await addMember(workspaceB, bOwner.id, "owner");
  await addMember(workspaceB, bAdmin.id, "admin");
  await addMember(workspaceB, bPm.id, "pm");
  await addMember(workspaceB, bViewer.id, "viewer");

  const projectA = await createProject(workspaceA, aOwner.id, `Harness Project A ${tag}`);
  const projectB = await createProject(workspaceB, bOwner.id, `Harness Project B ${tag}`);

  // Simulated Pro entitlement for tenant A. Fake Stripe ids — no Stripe object exists.
  const victimStripe = { customerId: `cus_secharness_${tag}`, subscriptionId: `sub_secharness_${tag}` };
  await must(
    admin.from("company_subscriptions").insert({
      company_id: aOwner.id,
      plan: "pro",
      subscription_status: "active",
      stripe_customer_id: victimStripe.customerId,
      stripe_subscription_id: victimStripe.subscriptionId,
    }),
    "simulated pro subscription",
  );

  const companyIds = () => createdUsers.map((user) => user.id);

  async function teardown() {
    const errors = [];
    const attempt = async (what, promise) => {
      const { error } = await promise;
      if (error) errors.push(`${what}: ${error.message}`);
    };
    if (workspaceIds.length) {
      // execution_tasks does not cascade from projects/workspaces; remove it first.
      await attempt("execution_tasks", admin.from("execution_tasks").delete().in("workspace_id", workspaceIds));
      await attempt("workspaces", admin.from("workspaces").delete().in("id", workspaceIds));
    }
    const ids = companyIds();
    if (ids.length) {
      for (const table of ["quota_reservations", "company_usage", "company_subscriptions", "operational_memory_records", "governance_audit_events"]) {
        await attempt(table, admin.from(table).delete().in("company_id", ids));
      }
    }
    for (const user of createdUsers) {
      const { error } = await admin.auth.admin.deleteUser(user.id);
      if (error) errors.push(`delete user ${user.email}: ${error.message}`);
    }
    if (errors.length) throw new Error(`[security-regression] teardown incomplete for ${tag}: ${errors.join("; ")}`);
  }

  return {
    tag,
    admin,
    users: { aOwner, bOwner, bAdmin, bPm, bViewer },
    workspaces: { A: workspaceA, B: workspaceB },
    projects: { A: projectA, B: projectB },
    victimStripe,
    createUser,
    createProject,
    signIn: (user) => signIn(env, user.email, user.password),
    teardown,
  };
}

/** Rewrites the caller's own user_metadata.company_id through real GoTrue — the F1 attack. */
export async function spoofCompanyId(client, companyId) {
  const { error } = await client.auth.updateUser({ data: { company_id: companyId } });
  if (error) throw new Error(`[security-regression] could not update own user_metadata: ${error.message}`);
  const refreshed = await client.auth.refreshSession();
  if (refreshed.error) throw new Error(`[security-regression] could not refresh session: ${refreshed.error.message}`);
}
