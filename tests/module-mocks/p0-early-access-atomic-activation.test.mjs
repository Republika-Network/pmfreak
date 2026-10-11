/**
 * Security hotfix after PR #640 — early-access activation must be atomic.
 *
 * acceptEarlyAccessInvite used to create the workspace and the owner
 * membership with separate writes BEFORE linking the trial license, and never
 * rolled them back. If linking failed, the invitee kept a membership with no
 * linked license, which the entitlement resolver reads as a self-serve Free
 * account. Activation now happens in one transaction
 * (accept_early_access_invite, migration 20261011000000).
 *
 * This drives the real acceptEarlyAccessInvite with only the service-role
 * PostgREST client mocked, and asserts that the application:
 *   - performs its precondition checks before any mutation,
 *   - never writes workspaces / workspace_memberships / trial_licenses /
 *     workspace_activations / invite acceptance itself — only the RPC does,
 *   - passes the invite id, token hash and the authenticated email to the RPC,
 *   - surfaces the function's own code::message errors and hides anything else.
 *
 * The transactional behaviour of the function itself (rollback at every step,
 * concurrency, email binding, tenant isolation) is verified against real
 * Postgres in scripts/check-entitlement-hardening-live-db.mjs.
 */

import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { mockModuleOptions, resolveMockTarget } from "./release-gate-01-fake-supabase.mjs";

process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon-key";
process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-key";

const TOKEN = "invite-token-abc";
const TOKEN_HASH = createHash("sha256").update(TOKEN).digest("hex");
const DAY = 24 * 60 * 60 * 1000;

const world = { invite: null, rpcResult: null, writes: [], rpcCalls: [] };

const MUTATING_TABLES = new Set(["workspaces", "workspace_memberships", "trial_licenses", "workspace_activations", "early_access_invites"]);

function fakeClient() {
  return {
    from(table) {
      const ops = [];
      const resolve = () => {
        const write = ops.find((o) => ["insert", "update", "upsert", "delete"].includes(o.name));
        if (write) {
          world.writes.push({ table, op: write.name, values: write.args[0] });
          return { data: null, error: null };
        }
        if (table === "early_access_invites") return { data: world.invite, error: null };
        return { data: null, error: null };
      };
      const builder = new Proxy(
        {},
        {
          get(_t, prop) {
            if (prop === "then") return (ok, err) => Promise.resolve(resolve()).then(ok, err);
            if (prop === "maybeSingle" || prop === "single") return async () => resolve();
            return (...args) => {
              ops.push({ name: prop, args });
              return builder;
            };
          },
        },
      );
      return builder;
    },
    rpc: async (name, args) => {
      world.rpcCalls.push({ name, args });
      return world.rpcResult;
    },
  };
}

const serviceRoleMock = mockModuleOptions({ createClient: () => fakeClient() });
const supabaseJsEsm = resolveMockTarget("@supabase/supabase-js");
const supabaseJsCjs = pathToFileURL(createRequire(import.meta.url).resolve("@supabase/supabase-js")).href;
mock.module(supabaseJsEsm, serviceRoleMock);
if (supabaseJsCjs !== supabaseJsEsm) mock.module(supabaseJsCjs, serviceRoleMock);

const { acceptEarlyAccessInvite } = await import("../../src/lib/early-access.ts");

function reset(inviteOverrides = {}, rpcResult = { data: { workspace_id: "ws-new", trial_license_id: "trial-1", trial_end_at: "2027-01-09T00:00:00+00:00" }, error: null }) {
  world.invite = {
    id: "invite-1",
    invite_email: "Invitee@Customer.example",
    expires_at: new Date(Date.now() + 7 * DAY).toISOString(),
    accepted_at: null,
    revoked_at: null,
    requires_approval: false,
    approved_at: null,
    ...inviteOverrides,
  };
  world.rpcResult = rpcResult;
  world.writes = [];
  world.rpcCalls = [];
}

const input = (overrides = {}) => ({ inviteToken: TOKEN, userId: "user-1", userEmail: "invitee@customer.example", ...overrides });
const messageMatches = (pattern) => (error) => pattern.test(error.message);
const mutations = () => world.writes.filter((w) => MUTATING_TABLES.has(w.table));

test("successful activation goes through the RPC only, with invite id, token hash and the authenticated email", async () => {
  reset();
  const result = await acceptEarlyAccessInvite(input({ workspaceName: "Acme" }));
  assert.deepEqual(result, { workspaceId: "ws-new", trialEndsAt: "2027-01-09T00:00:00.000Z" });
  assert.equal(world.rpcCalls.length, 1);
  assert.equal(world.rpcCalls[0].name, "accept_early_access_invite");
  assert.deepEqual(world.rpcCalls[0].args, {
    p_invite_id: "invite-1",
    p_invite_token_hash: TOKEN_HASH,
    p_user_id: "user-1",
    p_user_email: "invitee@customer.example",
    p_workspace_name: "Acme",
    p_trial_days: 90,
  });
  assert.deepEqual(mutations(), [], "the application must not write workspace, membership, license, invite or activation rows itself");
});

for (const [step, message] of [
  ["workspace creation", "injected failure at WORKSPACE"],
  ["membership creation", "injected failure at MEMBERSHIP"],
  ["trial license linking", "injected failure at TRIAL_LINK"],
  ["activation record", "duplicate key value violates unique constraint"],
]) {
  test(`failure during ${step}: generic error, no application-side writes left behind`, async () => {
    reset({}, { data: null, error: { message, code: "P0001" } });
    await assert.rejects(acceptEarlyAccessInvite(input()), (error) => {
      assert.ok(!error.message.includes("::"), "non-domain failures must not be user-facing");
      return true;
    });
    assert.deepEqual(mutations(), []);
    assert.ok(world.writes.some((w) => w.table === "early_access_events" && w.values.event_type === "invite_activation_failed"));
  });
}

test("RPC not deployed yet (function missing): fails closed with a generic error", async () => {
  reset({}, { data: null, error: { message: "Could not find the function public.accept_early_access_invite", code: "PGRST202" } });
  await assert.rejects(acceptEarlyAccessInvite(input()), (error) => !error.message.includes("::"));
  assert.deepEqual(mutations(), []);
});

test("RPC returns a malformed result: fails closed", async () => {
  reset({}, { data: { workspace_id: "ws-new" }, error: null });
  await assert.rejects(acceptEarlyAccessInvite(input()), /Unable to activate invite/);
});

for (const code of ["reused_token", "revoked_token", "expired_token", "pending_approval", "email_mismatch", "invalid_token", "activation_unavailable"]) {
  test(`domain error from the RPC (${code}) is surfaced as code::message`, async () => {
    reset({}, { data: null, error: { message: `${code}::Human readable.`, code: "P0001" } });
    await assert.rejects(acceptEarlyAccessInvite(input()), messageMatches(new RegExp(`^${code}::`)));
    assert.deepEqual(mutations(), []);
  });
}

test("concurrent acceptance: the losers' RPC errors (reused_token) surface unchanged", async () => {
  reset({}, { data: null, error: { message: "reused_token::Invite has already been used.", code: "P0001" } });
  const outcomes = await Promise.allSettled(Array.from({ length: 5 }, () => acceptEarlyAccessInvite(input())));
  assert.ok(outcomes.every((o) => o.status === "rejected" && /^reused_token::/.test(o.reason.message)));
  assert.deepEqual(mutations(), []);
});

for (const [name, overrides, code] of [
  ["revoked invite", { revoked_at: new Date().toISOString() }, "revoked_token"],
  ["already accepted invite", { accepted_at: new Date().toISOString() }, "reused_token"],
  ["expired invite", { expires_at: new Date(Date.now() - DAY).toISOString() }, "expired_token"],
  ["unapproved invite", { requires_approval: true }, "pending_approval"],
]) {
  test(`precheck: ${name} is rejected before the RPC and before any write`, async () => {
    reset(overrides);
    await assert.rejects(acceptEarlyAccessInvite(input()), messageMatches(new RegExp(`^${code}::`)));
    assert.equal(world.rpcCalls.length, 0);
    assert.deepEqual(mutations(), []);
  });
}

test("cross-tenant: a different authenticated email is rejected before the RPC", async () => {
  reset();
  await assert.rejects(acceptEarlyAccessInvite(input({ userEmail: "attacker@other.example" })), messageMatches(/^email_mismatch::/));
  assert.equal(world.rpcCalls.length, 0);
  assert.deepEqual(mutations(), []);
});

test("unknown token is rejected before the RPC", async () => {
  reset();
  world.invite = null;
  await assert.rejects(acceptEarlyAccessInvite(input()), messageMatches(/^invalid_token::/));
  assert.equal(world.rpcCalls.length, 0);
});
