/**
 * PB-CHAT-01 (RC-1) — shared transport fake for the cold-runtime Project Brain route tests
 * (pb-chat-01-cold-runtime-*.test.mjs). Not a test file itself.
 *
 * Only the transport is faked: `next/headers` and the `@supabase/ssr` / `@supabase/supabase-js`
 * clients answer the way PostgREST does. Everything between the route and those clients —
 * the runtime authority, access guards, governance, entitlement, turn service — is real.
 * Nothing here registers runtime authority dependencies: each test file runs in its own
 * `node --test` process, so the route starts on a genuinely cold runtime.
 */

import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { makeCookieJar, mockModuleOptions, resolveMockTarget } from "./release-gate-01-fake-supabase.mjs";

export const USER_ID = "8f0f7c55-6f7b-4d57-9a57-6a0d2f1d2b01";
export const WORKSPACE_ID = "0b6c2f0e-3f4c-4a55-8a1b-9c6d2e7f8a01";
export const PROJECT_ID = "5d2e1c3b-7a8f-4e9d-b0c1-2a3b4c5d6e01";

/** Mutable per-test world: who is signed in and what their membership is. */
export const world = { user: { id: USER_ID, email: "pm@example.test", user_metadata: {} }, role: "owner", writes: [] };

let seq = 0;
const stored = { context_conversations: [], context_messages: [] };

function rowsFor(table) {
  if (table === "projects") return [{ id: PROJECT_ID, workspace_id: WORKSPACE_ID, name: "Cold Runtime Project", status: "active", onboarding_payload: {} }];
  if (table === "workspace_memberships") return world.role ? [{ role: world.role, workspace_id: WORKSPACE_ID, user_id: USER_ID }] : [];
  return stored[table] ?? [];
}

function query(table) {
  let rows = rowsFor(table);
  let inserted = null;
  const result = () => ({ data: inserted ?? rows, error: null });
  const chain = {
    select: () => chain, eq: () => chain, neq: () => chain, is: () => chain, not: () => chain, in: () => chain,
    gt: () => chain, gte: () => chain, lt: () => chain, lte: () => chain, contains: () => chain,
    order: () => chain, limit: () => chain, range: () => chain,
    insert: (payload) => {
      const list = (Array.isArray(payload) ? payload : [payload]).map((row) => ({
        id: randomUUID(), created_at: new Date().toISOString(), message_seq: ++seq, ...row,
      }));
      world.writes.push({ table, rows: list });
      if (stored[table]) stored[table].push(...list);
      inserted = list;
      rows = list;
      return chain;
    },
    update: () => chain, upsert: () => chain, delete: () => chain,
    maybeSingle: async () => ({ data: (inserted ?? rows)[0] ?? null, error: null }),
    single: async () => ({ data: (inserted ?? rows)[0] ?? null, error: (inserted ?? rows)[0] ? null : { message: "no rows" } }),
    then: (resolve, reject) => Promise.resolve(result()).then(resolve, reject),
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
  // The transcript reader and the Project Brain reply writer use the service-role client;
  // its transport is faked the same way (no real key, no network).
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-test-key";
  t.mock.module(resolveMockTarget("next/headers"), mockModuleOptions({ cookies: async () => makeCookieJar({ writesSucceed: true }), headers: async () => ({ get: () => null }) }));
  t.mock.module(resolveMockTarget("@supabase/ssr"), mockModuleOptions({ createServerClient: () => client() }));
  // Both entry points: the TypeScript sources load as CommonJS (dist/index.cjs), while an ESM
  // importer resolves dist/index.mjs.
  for (const target of new Set([resolveMockTarget("@supabase/supabase-js"), pathToFileURL(createRequire(import.meta.url).resolve("@supabase/supabase-js")).href])) {
    t.mock.module(target, mockModuleOptions({ createClient: () => client() }));
  }
}

export const turnsUrl = `http://localhost:3000/api/projects/${PROJECT_ID}/brain/turns`;
export const routeContext = { params: Promise.resolve({ id: PROJECT_ID }) };
