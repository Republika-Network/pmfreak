/**
 * SIT-024 — shared transport fake for the workspace-read authorization route tests
 * (sit-024-*.test.mjs). Not a test file itself.
 *
 * Only the transport is faked: `next/headers` and the `@supabase/ssr` / `@supabase/supabase-js`
 * clients answer the way PostgREST does. Everything between the route and those clients — the
 * runtime authority, access guards, governance policy registry, access-verification adapter,
 * context-chat service — is real.
 *
 * Unlike the PB-CHAT-01 cold-runtime fake, this one APPLIES `eq` / `in` / `is` filters, so a
 * membership in workspace A genuinely does not answer a lookup for workspace B.
 */

import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { makeCookieJar, mockModuleOptions, resolveMockTarget } from "./release-gate-01-fake-supabase.mjs";

export const USER_ID = "7a1c0e55-6f7b-4d57-9a57-6a0d2f1d2b24";
export const WORKSPACE_A = "1b6c2f0e-3f4c-4a55-8a1b-9c6d2e7f8a24";
export const WORKSPACE_B = "2c7d3a1f-4a5d-4b66-9b2c-0d7e3f8a9b24";
export const PMO_A = "3d8e4b2a-5b6e-4c77-8c3d-1e8f4a9b0c24";
export const PMO_B = "4e9f5c3b-6c7f-4d88-9d4e-2f9a5b0c1d24";
export const PROJECT_A = "5f0a6d4c-7d8a-4e99-8e5f-3a0b6c1d2e24";
export const PROJECT_B = "6a1b7e5d-8e9b-4fa0-9f6a-4b1c7d2e3f24";

/**
 * Mutable per-test world. `memberships` is the persisted `workspace_memberships` vocabulary
 * (owner | admin | pm | viewer), never the canonical RBAC names — the adapter normalizes.
 * `user_metadata.role` is the DISPLAY role; tests set it to "viewer" to prove it is inert.
 */
export const world = {
  user: { id: USER_ID, email: "member@example.test", user_metadata: { role: "viewer" } },
  memberships: [{ user_id: USER_ID, workspace_id: WORKSPACE_A, role: "owner", created_at: "2026-01-01T00:00:00Z" }],
  writes: [],
};

const stored = { context_conversations: [], context_messages: [] };
let seq = 0;

export function resetWorld({ role = "owner", workspaceId = WORKSPACE_A } = {}) {
  world.user = { id: USER_ID, email: "member@example.test", user_metadata: { role: "viewer" } };
  world.memberships = role ? [{ user_id: USER_ID, workspace_id: workspaceId, role, created_at: "2026-01-01T00:00:00Z" }] : [];
  world.writes.length = 0;
  stored.context_conversations.length = 0;
  stored.context_messages.length = 0;
}

function baseRows(table) {
  switch (table) {
    case "workspace_memberships": return world.memberships;
    case "workspaces": return [{ id: WORKSPACE_A, status: "active", name: "Workspace A" }, { id: WORKSPACE_B, status: "active", name: "Workspace B" }];
    case "pmos": return [{ id: PMO_A, workspace_id: WORKSPACE_A, name: "PMO A", status: "active" }, { id: PMO_B, workspace_id: WORKSPACE_B, name: "PMO B", status: "active" }];
    case "projects": return [
      { id: PROJECT_A, workspace_id: WORKSPACE_A, pmo_id: PMO_A, name: "Project A", status: "active", onboarding_payload: {} },
      { id: PROJECT_B, workspace_id: WORKSPACE_B, pmo_id: PMO_B, name: "Project B", status: "active", onboarding_payload: {} },
    ];
    default: return stored[table] ?? [];
  }
}

function query(table) {
  const filters = [];
  let inserted = null;
  const current = () => (inserted ?? baseRows(table)).filter((row) => filters.every((f) => f(row)));
  const chain = {
    select: () => chain,
    eq: (col, value) => { filters.push((row) => row[col] === value); return chain; },
    neq: (col, value) => { filters.push((row) => row[col] !== value); return chain; },
    is: (col, value) => { filters.push((row) => (row[col] ?? null) === value); return chain; },
    in: (col, values) => { filters.push((row) => values.includes(row[col])); return chain; },
    not: () => chain, gt: () => chain, gte: () => chain, lt: () => chain, lte: () => chain, contains: () => chain,
    order: () => chain, limit: () => chain, range: () => chain,
    insert: (payload) => {
      const list = (Array.isArray(payload) ? payload : [payload]).map((row) => ({
        id: randomUUID(), created_at: new Date().toISOString(), status: table === "context_conversations" ? "active" : undefined, message_seq: ++seq, ...row,
      }));
      world.writes.push({ table, rows: list });
      if (stored[table]) stored[table].push(...list);
      inserted = list;
      return chain;
    },
    update: () => chain, upsert: () => chain, delete: () => chain,
    maybeSingle: async () => ({ data: current()[0] ?? null, error: null }),
    single: async () => ({ data: current()[0] ?? null, error: current()[0] ? null : { message: "no rows" } }),
    then: (resolve, reject) => Promise.resolve({ data: current(), error: null }).then(resolve, reject),
  };
  return chain;
}

function client() {
  return {
    auth: {
      getUser: async () => (world.user ? { data: { user: world.user }, error: null } : { data: { user: null }, error: { status: 401, message: "No session" } }),
      admin: { getUserById: async () => ({ data: { user: world.user }, error: null }) },
    },
    from: (table) => query(table),
    rpc: async () => ({ data: null, error: null }),
  };
}

export function installTransportFakes(t) {
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon-key";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-test-key";
  t.mock.module(resolveMockTarget("next/headers"), mockModuleOptions({ cookies: async () => makeCookieJar({ writesSucceed: true }), headers: async () => ({ get: () => null }) }));
  t.mock.module(resolveMockTarget("@supabase/ssr"), mockModuleOptions({ createServerClient: () => client() }));
  for (const target of new Set([resolveMockTarget("@supabase/supabase-js"), pathToFileURL(createRequire(import.meta.url).resolve("@supabase/supabase-js")).href])) {
    t.mock.module(target, mockModuleOptions({ createClient: () => client() }));
  }
}

/** Governance decisions recorded by the runtime's security-audit adapter, in order. */
export function governanceDecisions() {
  return world.writes
    .filter((w) => w.table === "security_events")
    .flatMap((w) => w.rows)
    .map((row) => ({ eventType: row.event_type, decision: row.metadata?.governanceDecision ?? null, requestedPermission: row.requested_permission }))
    .filter((entry) => entry.decision);
}
