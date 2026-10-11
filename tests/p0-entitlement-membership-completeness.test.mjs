/**
 * Security hotfix after PR #640 — entitlement must be decided on the COMPLETE
 * membership set.
 *
 * PR #640's resolver read at most 20 memberships, unordered, and then treated
 * "no trial license among those workspaces" as a self-serve Free account. A
 * user with more than 20 memberships could therefore have the workspace
 * holding their expired/revoked trial left out of the read and be granted
 * access.
 *
 * The fake below behaves like PostgREST for the calls the resolver makes:
 * ORDER BY, OFFSET/LIMIT via range(), an exact count, a server-side `max-rows`
 * cap that silently shortens pages, `IN (...)` filters, and injectable faults.
 * The same scenarios run against real PostgREST in
 * scripts/check-entitlement-hardening-live-db.mjs.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { resolveTrialEntitlement, resolveOnboardingState, ENTITLEMENT_PAGE_SIZE } from "../src/lib/auth/resolve-onboarding-state.ts";

const USER = "user-1";
const DAY = 24 * 60 * 60 * 1000;
const iso = (offsetMs) => new Date(Date.now() + offsetMs).toISOString();
const wsId = (i) => `ws-${String(i).padStart(4, "0")}`;

/**
 * world:
 *   memberships: workspace ids
 *   trials: [{ id, workspace_id, trial_status, trial_end_at, created_at }]
 *   maxRows: server-side row cap (PostgREST max-rows)
 *   faults: { membershipErrorOnPage, membershipMissingCount, membershipCountDrift,
 *             membershipShortBy, membershipDuplicate, trialErrorOnChunk, trialMalformed }
 */
function postgrest(world) {
  const calls = { membershipPages: 0, trialChunks: 0, inSizes: [] };
  const trials = (world.trials ?? []).map((t) => ({ ...t }));
  const client = {
    calls,
    from(table) {
      const ops = [];
      const run = (single) => {
        const op = (name) => ops.find((o) => o.name === name);
        const f = world.faults ?? {};
        if (table === "workspace_memberships") {
          const page = calls.membershipPages++;
          if (f.membershipErrorOnPage === page) return { data: null, error: { message: "timeout" }, count: null };
          let rows = [...world.memberships].sort().map((workspace_id) => ({ workspace_id }));
          let count = rows.length;
          if (f.membershipShortBy) rows = rows.slice(0, rows.length - f.membershipShortBy);
          if (f.membershipDuplicate && rows.length > 1) rows[rows.length - 1] = rows[0];
          if (f.membershipCountDrift && page > 0) count += 1;
          const [from, to] = op("range").args;
          const cap = world.maxRows ?? 1000;
          const data = rows.slice(from, Math.min(to + 1, from + cap));
          return { data, error: null, count: f.membershipMissingCount ? null : count };
        }
        if (table === "trial_licenses") {
          if (op("update")) {
            const id = ops.find((o) => o.name === "eq" && o.args[0] === "id").args[1];
            const cutoff = op("lt").args[1];
            const t = trials.find((x) => x.id === id);
            if (t && t.trial_status === "active" && t.trial_end_at < cutoff) t.trial_status = "expired";
            return { data: null, error: null };
          }
          if (single) {
            const id = ops.find((o) => o.name === "eq" && o.args[0] === "id").args[1];
            return { data: trials.find((x) => x.id === id) ?? null, error: null };
          }
          const chunk = calls.trialChunks++;
          if (f.trialErrorOnChunk === chunk) return { data: null, error: { message: "timeout" } };
          const ids = op("in").args[1];
          calls.inSizes.push(ids.length);
          const matches = trials
            .filter((t) => ids.includes(t.workspace_id))
            .sort((a, b) => (a.created_at === b.created_at ? (a.id < b.id ? 1 : -1) : a.created_at < b.created_at ? 1 : -1));
          if (f.trialMalformed && matches[0]) return { data: [{ ...matches[0], created_at: "not-a-date" }], error: null };
          return { data: matches.slice(0, op("limit").args[0]), error: null };
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
  return client;
}

const memberships = (n) => Array.from({ length: n }, (_, i) => wsId(i));
const trial = (id, workspace_id, trial_status, endOffset, createdAt = "2026-09-01T00:00:00.000000+00:00") => ({
  id,
  workspace_id,
  trial_status,
  trial_end_at: iso(endOffset),
  created_at: createdAt,
});

// ─── Free accounts at every size ─────────────────────────────────────────────

for (const n of [1, 20, 21, 100, 101, 150, 250]) {
  test(`${n} membership(s), no trial anywhere → entitled (Free), every membership examined`, async () => {
    const client = postgrest({ memberships: memberships(n) });
    assert.equal(await resolveTrialEntitlement(client, USER), "entitled");
    assert.equal(client.calls.membershipPages, Math.max(1, Math.ceil(n / ENTITLEMENT_PAGE_SIZE)));
    assert.equal(client.calls.inSizes.reduce((a, b) => a + b, 0), n, "every workspace id must be checked for a trial");
  });
}

// ─── Expired / revoked trial outside the first 20 (and first page) ───────────

for (const [n, status, end] of [
  [21, "expired", -DAY],
  [21, "revoked", 30 * DAY],
  [101, "expired", -DAY],
  [150, "revoked", 30 * DAY],
  [250, "expired", -DAY],
  [250, "active", -DAY], // active but past trial_end_at
]) {
  test(`${n} memberships, ${status} trial on the LAST workspace → blocked`, async () => {
    const client = postgrest({ memberships: memberships(n), trials: [trial("t-last", wsId(n - 1), status, end)] });
    assert.equal(await resolveTrialEntitlement(client, USER), "blocked");
  });
}

test("a server max-rows cap smaller than the page size still reads every membership", async () => {
  const client = postgrest({ memberships: memberships(150), maxRows: 7, trials: [trial("t", wsId(149), "expired", -DAY)] });
  assert.equal(await resolveTrialEntitlement(client, USER), "blocked");
  assert.equal(client.calls.membershipPages, Math.ceil(150 / 7));
});

test("a server max-rows cap smaller than the page size still grants a genuine Free account", async () => {
  const client = postgrest({ memberships: memberships(150), maxRows: 7 });
  assert.equal(await resolveTrialEntitlement(client, USER), "entitled");
});

// ─── Incomplete or failed reads fail closed ──────────────────────────────────

const failClosed = [
  ["membership read fails on the first page", { membershipErrorOnPage: 0 }, 1],
  ["membership read fails on a later page", { membershipErrorOnPage: 1 }, 150],
  ["membership count is missing", { membershipMissingCount: true }, 21],
  ["membership count changes between pages", { membershipCountDrift: true }, 150],
  ["server returns fewer rows than it counted", { membershipShortBy: 3 }, 150],
  ["server returns fewer rows than it counted (single page)", { membershipShortBy: 1 }, 21],
  ["duplicate membership rows", { membershipDuplicate: true }, 21],
  ["trial read fails on the first chunk", { trialErrorOnChunk: 0 }, 21],
  ["trial read fails on a later chunk", { trialErrorOnChunk: 1 }, 150],
  ["trial row has an unparseable created_at", { trialMalformed: true }, 21],
];

for (const [name, faults, n] of failClosed) {
  test(`fail closed: ${name} → blocked (even for a would-be Free account)`, async () => {
    const trials = faults.trialMalformed ? [trial("t", wsId(0), "active", 30 * DAY)] : [];
    const client = postgrest({ memberships: memberships(n), trials, faults });
    assert.equal(await resolveTrialEntitlement(client, USER), "blocked");
  });
}

test("fail closed propagates through resolveOnboardingState as trial_blocked", async () => {
  const client = postgrest({ memberships: memberships(150), faults: { membershipErrorOnPage: 1 } });
  assert.equal(await resolveOnboardingState({ id: USER, email: "u@example.test" }, wsId(0), { getClient: () => client }), "trial_blocked");
});

test("zero memberships → blocked", async () => {
  assert.equal(await resolveTrialEntitlement(postgrest({ memberships: [] }), USER), "blocked");
});

// ─── Mixed active / expired / revoked trials across chunks ───────────────────

test("mixed: newest trial active (in a later chunk), older expired and revoked → entitled", async () => {
  const client = postgrest({
    memberships: memberships(250),
    trials: [
      trial("t-exp", wsId(3), "expired", -DAY, "2026-06-01T00:00:00+00:00"),
      trial("t-rev", wsId(120), "revoked", 30 * DAY, "2026-07-01T00:00:00+00:00"),
      trial("t-act", wsId(240), "active", 30 * DAY, "2026-09-01T00:00:00+00:00"),
    ],
  });
  assert.equal(await resolveTrialEntitlement(client, USER), "entitled");
});

test("mixed: newest trial revoked (in an earlier chunk), older active → blocked", async () => {
  const client = postgrest({
    memberships: memberships(250),
    trials: [
      trial("t-rev", wsId(2), "revoked", 30 * DAY, "2026-09-01T00:00:00+00:00"),
      trial("t-act", wsId(240), "active", 30 * DAY, "2026-06-01T00:00:00+00:00"),
    ],
  });
  assert.equal(await resolveTrialEntitlement(client, USER), "blocked");
});

test("mixed: newest trial expired in the last chunk, older active in the first → blocked", async () => {
  const client = postgrest({
    memberships: memberships(250),
    trials: [
      trial("t-act", wsId(1), "active", 30 * DAY, "2026-06-01T00:00:00+00:00"),
      trial("t-exp", wsId(249), "expired", -DAY, "2026-09-01T00:00:00+00:00"),
    ],
  });
  assert.equal(await resolveTrialEntitlement(client, USER), "blocked");
});

test("mixed: identical created_at across chunks is broken by id, independent of chunk order", async () => {
  const at = "2026-09-01T00:00:00+00:00";
  const a = postgrest({ memberships: memberships(250), trials: [trial("t-a", wsId(10), "active", 30 * DAY, at), trial("t-b", wsId(210), "revoked", 30 * DAY, at)] });
  const b = postgrest({ memberships: memberships(250), trials: [trial("t-b", wsId(10), "revoked", 30 * DAY, at), trial("t-a", wsId(210), "active", 30 * DAY, at)] });
  assert.equal(await resolveTrialEntitlement(a, USER), "blocked", "t-b > t-a, so the revoked license is the most recent");
  assert.equal(await resolveTrialEntitlement(b, USER), "blocked");
});

test("an active trial past trial_end_at in a later chunk is expired on read and blocks", async () => {
  const client = postgrest({ memberships: memberships(150), trials: [trial("t", wsId(140), "active", -DAY)] });
  assert.equal(await resolveTrialEntitlement(client, USER), "blocked");
});

test("no IN filter ever exceeds the page size", async () => {
  const client = postgrest({ memberships: memberships(250) });
  await resolveTrialEntitlement(client, USER);
  assert.ok(client.calls.inSizes.every((n) => n > 0 && n <= ENTITLEMENT_PAGE_SIZE));
});
