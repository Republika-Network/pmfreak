/**
 * Security hotfix after PR #640 — entitlement must be decided against EVERY
 * membership, in one consistent read.
 *
 * PR #640's resolver read at most 20 memberships, unordered, and then treated
 * "no trial license among those workspaces" as a self-serve Free account. The
 * first hardening pass paginated the memberships client-side; review then
 * showed two residual gaps in any client-side approach: separate page requests
 * do not share a snapshot (a concurrent membership change can shift offsets
 * and skip a workspace without changing the count), and comparing
 * `created_at` in JavaScript truncates Postgres' microseconds.
 *
 * The resolver now asks Postgres one question in one statement: the most
 * recent trial license on any workspace this user is a member of
 * (trial_licenses ⋈ workspaces ⋈ workspace_memberships, ordered and limited
 * server-side). These tests pin that query shape and its fail-closed handling
 * with a fake that evaluates the join; the same scenarios — including
 * microsecond ordering and more memberships than PostgREST's max-rows — run
 * against real PostgREST/Postgres in scripts/check-entitlement-hardening-live-db.mjs.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { resolveTrialEntitlement, resolveOnboardingState } from "../src/lib/auth/resolve-onboarding-state.ts";

const USER = "user-1";
const DAY = 24 * 60 * 60 * 1000;
const iso = (offsetMs) => new Date(Date.now() + offsetMs).toISOString();
const wsId = (i) => `ws-${String(i).padStart(5, "0")}`;
const MEMBERSHIP_FILTER = "workspaces.workspace_memberships.user_id";

/**
 * world:
 *   memberships: [{ user_id, workspace_id }]
 *   trials: [{ id, workspace_id, trial_status, trial_end_at, created_at }]
 *     created_at uses fixed 6-digit microseconds so string order = time order.
 *   faults: { membershipError, trialError, trialNotArray, trialMalformedId }
 */
function postgres(world) {
  const queries = [];
  const trials = (world.trials ?? []).map((t) => ({ ...t }));
  return {
    queries,
    from(table) {
      const ops = [];
      queries.push({ table, ops });
      const run = (single) => {
        const op = (name) => ops.find((o) => o.name === name);
        const f = world.faults ?? {};
        if (table === "workspace_memberships") {
          if (f.membershipError) return { data: null, error: { message: "timeout" } };
          const user = ops.find((o) => o.name === "eq" && o.args[0] === "user_id").args[1];
          const rows = world.memberships.filter((m) => m.user_id === user);
          return { data: rows.slice(0, op("limit")?.args[0] ?? rows.length), error: null };
        }
        if (table === "trial_licenses") {
          if (op("update")) {
            const id = ops.find((o) => o.name === "eq" && o.args[0] === "id").args[1];
            const t = trials.find((x) => x.id === id);
            if (t && t.trial_status === "active" && t.trial_end_at < op("lt").args[1]) t.trial_status = "expired";
            return { data: null, error: null };
          }
          if (single) {
            const id = ops.find((o) => o.name === "eq" && o.args[0] === "id").args[1];
            return { data: trials.find((x) => x.id === id) ?? null, error: null };
          }
          if (f.trialError) return { data: null, error: { message: "timeout" } };
          if (f.trialNotArray) return { data: { id: "x" }, error: null };
          // Evaluate the !inner join: license rows whose workspace has a
          // membership for the filtered user.
          const user = ops.find((o) => o.name === "eq" && o.args[0] === MEMBERSHIP_FILTER)?.args[1];
          const memberOf = new Set(world.memberships.filter((m) => m.user_id === user).map((m) => m.workspace_id));
          const rows = trials
            .filter((t) => memberOf.has(t.workspace_id))
            .sort((a, b) => (a.created_at === b.created_at ? (a.id < b.id ? 1 : -1) : a.created_at < b.created_at ? 1 : -1))
            .slice(0, op("limit").args[0]);
          if (f.trialMalformedId && rows[0]) return { data: [{ ...rows[0], id: 42 }], error: null };
          return { data: rows, error: null };
        }
        return { data: [], error: null };
      };
      const builder = new Proxy(
        {},
        {
          get(_t, prop) {
            if (prop === "then") return (ok, err) => Promise.resolve(run(false)).then(ok, err);
            if (prop === "maybeSingle" || prop === "single") return async () => run(true);
            return (...args) => {
              ops.push({ name: prop, args });
              return builder;
            };
          },
        },
      );
      return builder;
    },
  };
}

const memberOf = (n, user = USER) => Array.from({ length: n }, (_, i) => ({ user_id: user, workspace_id: wsId(i) }));
const at = (micros) => `2026-09-01T00:00:00.${String(micros).padStart(6, "0")}+00:00`;
const trial = (id, workspace_id, trial_status, endOffset, created_at = at(0)) => ({ id, workspace_id, trial_status, trial_end_at: iso(endOffset), created_at });
const licenseLookup = (client) => client.queries.find((q) => q.table === "trial_licenses" && !q.ops.some((o) => o.name === "update") && q.ops.some((o) => o.name === "limit"));

// ─── Query shape: one server-side statement over every membership ────────────

test("the license lookup is ONE statement joining through the user's memberships, ordered and limited by Postgres", async () => {
  const client = postgres({ memberships: memberOf(150) });
  await resolveTrialEntitlement(client, USER);
  const lookup = licenseLookup(client);
  const select = lookup.ops.find((o) => o.name === "select").args[0];
  assert.match(select, /workspaces!inner\(workspace_memberships!inner\(user_id\)\)/, "both embeds must be !inner so the filter restricts license rows");
  assert.deepEqual(lookup.ops.find((o) => o.name === "eq").args, [MEMBERSHIP_FILTER, USER]);
  assert.deepEqual(lookup.ops.filter((o) => o.name === "order").map((o) => o.args), [["created_at", { ascending: false }], ["id", { ascending: false }]]);
  assert.deepEqual(lookup.ops.find((o) => o.name === "limit").args, [1]);
  for (const forbidden of ["in", "range"]) {
    assert.ok(!client.queries.some((q) => q.ops.some((o) => o.name === forbidden)), `no client-side ${forbidden}() over membership ids`);
  }
  assert.equal(client.queries.filter((q) => q.table === "trial_licenses").length, 1, "Free account: exactly one license query");
});

// ─── Free accounts at every size ─────────────────────────────────────────────

for (const n of [1, 20, 21, 100, 101, 150, 1200]) {
  test(`${n} membership(s), no trial anywhere → entitled (Free)`, async () => {
    assert.equal(await resolveTrialEntitlement(postgres({ memberships: memberOf(n) }), USER), "entitled");
  });
}

// ─── Expired / revoked trial anywhere in the membership set ──────────────────

for (const [n, status, end] of [
  [21, "expired", -DAY],
  [21, "revoked", 30 * DAY],
  [101, "expired", -DAY],
  [150, "revoked", 30 * DAY],
  [1200, "expired", -DAY],
  [1200, "active", -DAY], // active but past trial_end_at
]) {
  test(`${n} memberships, ${status}${status === "active" ? " (past end)" : ""} trial on the LAST workspace → blocked`, async () => {
    const client = postgres({ memberships: memberOf(n), trials: [trial("t-last", wsId(n - 1), status, end)] });
    assert.equal(await resolveTrialEntitlement(client, USER), "blocked");
  });
}

// ─── Mixed trials; ordering decided by Postgres at full precision ────────────

test("mixed: newest active, older expired and revoked → entitled", async () => {
  const client = postgres({
    memberships: memberOf(250),
    trials: [trial("t-exp", wsId(3), "expired", -DAY, at(1)), trial("t-rev", wsId(120), "revoked", 30 * DAY, at(2)), trial("t-act", wsId(240), "active", 30 * DAY, at(3))],
  });
  assert.equal(await resolveTrialEntitlement(client, USER), "entitled");
});

test("mixed: newest revoked, older active → blocked", async () => {
  const client = postgres({ memberships: memberOf(250), trials: [trial("t-rev", wsId(2), "revoked", 30 * DAY, at(9)), trial("t-act", wsId(240), "active", 30 * DAY, at(1))] });
  assert.equal(await resolveTrialEntitlement(client, USER), "blocked");
});

test("licenses 1µs apart: the newer (revoked) wins even though the older (active) has the higher id", async () => {
  const client = postgres({
    memberships: memberOf(250),
    trials: [trial("ffff-older-active", wsId(5), "active", 30 * DAY, at(123455)), trial("0000-newer-revoked", wsId(245), "revoked", 30 * DAY, at(123456))],
  });
  assert.equal(await resolveTrialEntitlement(client, USER), "blocked");
});

test("identical created_at is broken by id, server-side", async () => {
  const client = postgres({ memberships: memberOf(10), trials: [trial("t-a", wsId(1), "active", 30 * DAY), trial("t-b", wsId(2), "revoked", 30 * DAY)] });
  assert.equal(await resolveTrialEntitlement(client, USER), "blocked", "t-b > t-a, so the revoked license is the most recent");
});

test("isolation: another user's expired trial on a workspace this user is not in has no effect", async () => {
  const client = postgres({
    memberships: [...memberOf(3), { user_id: "user-2", workspace_id: "ws-other" }],
    trials: [trial("t-other", "ws-other", "expired", -DAY)],
  });
  assert.equal(await resolveTrialEntitlement(client, USER), "entitled");
  assert.equal(await resolveTrialEntitlement(client, "user-2"), "blocked");
});

// ─── Fail closed ─────────────────────────────────────────────────────────────

for (const [name, faults] of [
  ["membership read fails", { membershipError: true }],
  ["license read fails", { trialError: true }],
  ["license read returns a non-array", { trialNotArray: true }],
  ["license row has a malformed id", { trialMalformedId: true }],
]) {
  test(`fail closed: ${name} → blocked`, async () => {
    const client = postgres({ memberships: memberOf(21), trials: [trial("t", wsId(0), "active", 30 * DAY)], faults });
    assert.equal(await resolveTrialEntitlement(client, USER), "blocked");
  });
}

test("fail closed propagates through resolveOnboardingState as trial_blocked", async () => {
  const client = postgres({ memberships: memberOf(150), faults: { trialError: true } });
  assert.equal(await resolveOnboardingState({ id: USER, email: "u@example.test" }, wsId(0), { getClient: () => client }), "trial_blocked");
});

test("zero memberships → blocked", async () => {
  assert.equal(await resolveTrialEntitlement(postgres({ memberships: [] }), USER), "blocked");
});
