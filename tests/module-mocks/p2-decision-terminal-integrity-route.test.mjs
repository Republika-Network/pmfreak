/**
 * P2 Recommendation -> Decision terminal-integrity repair — route contract.
 *
 * Executes the real, unmodified POST handler of `src/app/api/operational-flow/route.ts`
 * (`record_decision`) with only the transport faked: `next/headers` cookies and the
 * `@supabase/ssr` client. The fake client answers auth, the project/membership scope reads and
 * the `record_operational_decision` RPC exactly as PostgREST does — `{ data, error: { message } }`.
 *
 * Before the repair, a second terminal Decision reached the API as the raw unique-index
 * violation and the route answered 500 "Operational flow failed. Please retry." After it, the
 * RPC raises `operational_decision_already_terminal` and the route answers 409 in the canonical
 * conflict envelope, with nothing from the database in the body. The raw index violation (a
 * database still missing the migration) must also answer 409, never 500.
 *
 * Own `node --test` file for the same process-isolation reason as every file in this folder.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { makeCookieJar, mockModuleOptions, resolveMockTarget } from "./release-gate-01-fake-supabase.mjs";

process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon-key";
delete process.env.SUPABASE_SERVICE_ROLE_KEY;

const USER_ID = "user-owner-1";
const WORKSPACE_ID = "ws-1";
const PROJECT_ID = "pr-1";
const RECOMMENDATION_ID = "rec-1";

/** What the fake PostgREST answers for the next `record_operational_decision` call. */
let nextDecisionRpc = { data: null, error: { message: "unset" } };
const rpcCalls = [];

function createServerClient() {
  const scopeRow = (table) => {
    if (table === "projects") return { workspace_id: WORKSPACE_ID };
    if (table === "workspace_memberships") return { role: "owner" };
    return null;
  };
  return {
    auth: {
      getUser: async () => ({ data: { user: { id: USER_ID, email: "owner@example.test", user_metadata: {} } }, error: null }),
    },
    from: (table) => {
      const chain = {
        select: () => chain,
        eq: () => chain,
        maybeSingle: async () => ({ data: scopeRow(table), error: null }),
      };
      return chain;
    },
    rpc: async (name, args) => {
      rpcCalls.push({ name, args });
      if (name !== "record_operational_decision") return { data: null, error: { message: `unexpected rpc ${name}` } };
      return nextDecisionRpc;
    },
  };
}

async function recordDecision(t, decisionStatus) {
  t.mock.module(resolveMockTarget("next/headers"), mockModuleOptions({ cookies: async () => makeCookieJar({ writesSucceed: true }), headers: async () => ({ get: () => null }) }));
  t.mock.module(resolveMockTarget("@supabase/ssr"), mockModuleOptions({ createServerClient }));
  const { POST } = await import("../../src/app/api/operational-flow/route.ts");
  const response = await POST(new Request("http://localhost:3000/api/operational-flow", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      operation: "record_decision", workspaceId: WORKSPACE_ID, projectId: PROJECT_ID,
      recommendationId: RECOMMENDATION_ID, decisionStatus,
      decision: `Recommendation ${decisionStatus}`, rationale: "P2 terminal-integrity route regression",
    }),
  }));
  const raw = await response.text();
  return { status: response.status, raw, body: JSON.parse(raw) };
}

function assertCanonicalConflict(result) {
  assert.equal(result.status, 409, `expected 409 domain conflict, got ${result.status}: ${result.raw}`);
  assert.equal(result.body.disposition, "conflict");
  assert.equal(result.body.code, "recommendation_already_decided");
  assert.equal(result.body.recovery, "reload_recorded_decision");
  assert.match(result.body.referenceId, /^[0-9a-f-]{36}$/);
  assert.match(result.body.error, /already has a final Decision/);
  for (const leak of [/record_operational_decision/, /operational_decision_/, /uidx/, /duplicate key/i, /constraint/i, /unique/i, /Operational flow failed/, /stack/i]) {
    assert.doesNotMatch(result.raw, leak, `response body must not contain ${leak}`);
  }
}

test("Case 1: a valid terminal Decision on an open Recommendation is still 201", async (t) => {
  nextDecisionRpc = { data: { decision: { id: "dec-1", decision_status: "accepted" }, evidenceLinked: 1 }, error: null };
  const result = await recordDecision(t, "accepted");
  assert.equal(result.status, 201);
  assert.equal(result.body.decision.decision_status, "accepted");
  const call = rpcCalls.at(-1);
  assert.equal(call.args.p_recommendation_id, RECOMMENDATION_ID);
  assert.equal(call.args.p_decision_status, "accepted");
});

for (const decisionStatus of ["accepted", "rejected", "modified", "escalated", "needs_more_evidence"]) {
  test(`Defect A/B: ${decisionStatus} after a terminal Decision answers the canonical 409, not 500`, async (t) => {
    nextDecisionRpc = { data: null, error: { message: "operational_decision_already_terminal" } };
    assertCanonicalConflict(await recordDecision(t, decisionStatus));
  });
}

test("Defect A: the raw unique-index violation (database without the migration) answers 409, not 500", async (t) => {
  nextDecisionRpc = {
    data: null,
    error: { message: 'duplicate key value violates unique constraint "operational_decision_terminal_recommendation_uidx"' },
  };
  assertCanonicalConflict(await recordDecision(t, "rejected"));
});

// Unrelated decision failures keep their existing statuses — the new mapping is not a catch-all.
test("unchanged: an authority denial is still 403", async (t) => {
  nextDecisionRpc = { data: null, error: { message: "operational_decision_authority_denied:authority_requirement_not_satisfied" } };
  assert.equal((await recordDecision(t, "accepted")).status, 403);
});

test("unchanged: a missing governed Recommendation is still 400", async (t) => {
  nextDecisionRpc = { data: null, error: { message: "governed_recommendation_not_found" } };
  assert.equal((await recordDecision(t, "accepted")).status, 400);
});

test("unchanged: a genuine fault is still a non-leaking 500", async (t) => {
  nextDecisionRpc = { data: null, error: { message: "connection reset by peer" } };
  const fault = await recordDecision(t, "accepted");
  assert.equal(fault.status, 500);
  assert.doesNotMatch(fault.raw, /connection reset/);
});
