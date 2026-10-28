// Perilla 7 — Supabase RLS / Service Role Boundary Audit.
//
// There is no live Supabase instance in this test environment (see the
// "Honest snapshot" framing in docs/security/rls-gap-inventory-phase-4.3.md
// and docs/security/rls-tenant-isolation-audit-phase-3.md), so this suite is
// a source/migration scan: it fails if a future migration or code change
// reopens one of the trust-boundary gaps this perilla closed, or introduces
// a new sensitive table without RLS, or a new createSupabaseServiceRoleClient
// usage that isn't inventoried in the privileged-access registry.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";

const repoRoot = new URL("..", import.meta.url);
const readSource = (relativePath) => fs.readFile(new URL(relativePath, repoRoot), "utf8");

const MIGRATIONS_DIR = new URL("../supabase/migrations/", import.meta.url);

// Strip `--` line comments before any regex scan below — several migrations
// (e.g. 20260515100000_rls_governance_fixes.sql) keep a commented-out DOWN/
// rollback section for traceability, including lines like
// "-- alter table public.workspace_memberships disable row level security;".
// Without stripping, that rollback documentation reads as a live violation.
const stripSqlComments = (text) =>
  text
    .split("\n")
    .map((line) => {
      const idx = line.indexOf("--");
      return idx === -1 ? line : line.slice(0, idx);
    })
    .join("\n");

async function readAllMigrations() {
  const entries = await fs.readdir(MIGRATIONS_DIR);
  const sqlFiles = entries.filter((name) => name.endsWith(".sql")).sort();
  const files = await Promise.all(
    sqlFiles.map(async (name) => ({ name, text: stripSqlComments(await fs.readFile(new URL(name, MIGRATIONS_DIR), "utf8")) })),
  );
  return files;
}

let migrations;

test.before(async () => {
  migrations = await readAllMigrations();
});

const allMigrationsText = () => migrations.map((m) => m.text).join("\n");

// A policy is "service-role-gated" if it either targets only the
// service_role grantee, or its predicate itself checks auth.role() =
// 'service_role' — both styles are used across this schema
// (e.g. billing_webhook_events uses the auth.role() predicate style with no
// explicit TO clause, which defaults to PUBLIC but is still denied to any
// non-service-role caller by the predicate).
const isServiceRoleGated = (statement) =>
  (/to\s+service_role\b/i.test(statement) && !/to\s+(authenticated|anon|public)\b/i.test(statement)) ||
  /auth\.role\(\)\s*=\s*'service_role'/i.test(statement);

// A policy "targets a client role" if it grants to authenticated/anon/public
// explicitly, or omits TO entirely (which defaults to PUBLIC in Postgres).
const targetsClientRole = (statement) => /to\s+(authenticated|anon|public)\b/i.test(statement) || !/\bto\s+\w+/i.test(statement);

const POLICY_STATEMENT_PATTERN = /create policy(?:\s+if not exists)?\s+"([^"]+)"\s+on\s+(?:public\.)?(\w+)([\s\S]*?);/gi;
const DROP_POLICY_PATTERN = /drop policy(?:\s+if exists)?\s+"([^"]+)"\s+on\s+(?:public\.)?(\w+)/gi;
const RLS_TOGGLE_PATTERN = /alter table (?:if exists )?(?:public\.)?(\w+)\s+(enable|disable) row level security/gi;

/**
 * Replays every migration in chronological (filename) order to compute the
 * *final* set of live policies per table and the final RLS-enabled state —
 * as opposed to scanning each migration file in isolation, which would flag
 * a policy a later corrective migration already dropped. This mirrors how
 * `supabase db push`/`migrate` actually applies the directory: additive,
 * in order, with later `drop policy` / `create policy` statements
 * superseding earlier ones.
 */
function buildFinalRlsState(migrationList) {
  const policies = new Map(); // `${table}::${name}` -> statement text
  const rlsEnabled = new Map(); // table -> boolean

  for (const { text } of migrationList) {
    let m;
    RLS_TOGGLE_PATTERN.lastIndex = 0;
    while ((m = RLS_TOGGLE_PATTERN.exec(text))) rlsEnabled.set(m[1], m[2].toLowerCase() === "enable");

    DROP_POLICY_PATTERN.lastIndex = 0;
    while ((m = DROP_POLICY_PATTERN.exec(text))) policies.delete(`${m[2]}::${m[1]}`);

    POLICY_STATEMENT_PATTERN.lastIndex = 0;
    while ((m = POLICY_STATEMENT_PATTERN.exec(text))) {
      const [full, name, table] = m;
      policies.set(`${table}::${name}`, full);
    }
  }

  return { policies, rlsEnabled };
}

const finalPoliciesForTable = (state, table) =>
  [...state.policies.entries()].filter(([key]) => key.startsWith(`${table}::`)).map(([, statement]) => statement);

// ─────────────────────────────────────────────────────────────────────────────
// 1. Sensitive tables have RLS enabled somewhere in the migration history
//    (test #1)
// ─────────────────────────────────────────────────────────────────────────────

const SENSITIVE_TABLES = [
  "workspace_memberships",
  "workspace_invitations",
  "company_subscriptions",
  "billing_webhook_events",
  "early_access_invites",
  "early_access_events",
  "trial_licenses",
  "workspace_activations",
  "pmo_team_invites",
];

test("every sensitive table has an 'enable row level security' statement in some migration (test #1)", () => {
  const text = allMigrationsText();
  for (const table of SENSITIVE_TABLES) {
    const pattern = new RegExp(`alter table (?:if exists )?(?:public\\.)?${table}\\s+enable row level security`, "i");
    assert.match(text, pattern, `${table} must have RLS enabled in some migration`);
  }
});

test("every sensitive table's final (chronologically-replayed) RLS state is enabled", () => {
  const state = buildFinalRlsState(migrations);
  for (const table of SENSITIVE_TABLES) {
    assert.equal(state.rlsEnabled.get(table), true, `${table} must have RLS enabled in the final migration state`);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. No broad using(true)/with check(true) authenticated/anon policy on a
//    sensitive table, in the FINAL replayed state (test #2)
// ─────────────────────────────────────────────────────────────────────────────

test("no sensitive table's final policy set has a broad 'using (true)' policy reachable by authenticated/anon", () => {
  const state = buildFinalRlsState(migrations);
  for (const table of SENSITIVE_TABLES) {
    for (const statement of finalPoliciesForTable(state, table)) {
      if (isServiceRoleGated(statement)) continue; // service_role bypasses RLS by design — using(true) here is fine
      const hasBroadUsing = /using\s*\(\s*true\s*\)/i.test(statement);
      assert.ok(
        !(targetsClientRole(statement) && hasBroadUsing),
        `${table}: final policy grants authenticated/anon a broad using(true) row:\n${statement}`,
      );
    }
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 3 & 4. No authenticated write policy on company_subscriptions /
//    billing_webhook_events, in the FINAL replayed state (tests #3, #4)
// ─────────────────────────────────────────────────────────────────────────────

for (const table of ["company_subscriptions", "billing_webhook_events"]) {
  test(`no client-reachable policy grants insert/update/delete/all on ${table} in the final migration state (tests #3, #4)`, () => {
    const state = buildFinalRlsState(migrations);
    for (const statement of finalPoliciesForTable(state, table)) {
      if (isServiceRoleGated(statement)) continue;
      const isWriteCommand = /for\s+(all|insert|update|delete)\b/i.test(statement);
      assert.ok(
        !(targetsClientRole(statement) && isWriteCommand),
        `${table}: final policy set still grants a client-reachable write:\n${statement}`,
      );
    }
  });
}

test("the corrective migration removes the legacy 'for all to authenticated' company_subscriptions policy", async () => {
  const text = await readSource("supabase/migrations/20260818000000_supabase_rls_service_role_boundary_hardening.sql");
  assert.match(text, /drop policy if exists "tenant access company_subscriptions" on public\.company_subscriptions/);
  assert.match(text, /create policy "authenticated can read own company_subscriptions"[\s\S]*?for select/);
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. No self-role-update / no-write-at-all policy on workspace_memberships,
//    in the FINAL replayed state (test #5)
// ─────────────────────────────────────────────────────────────────────────────

test("no final policy allows authenticated users to update their own workspace_memberships row (test #5)", () => {
  const state = buildFinalRlsState(migrations);
  for (const statement of finalPoliciesForTable(state, "workspace_memberships")) {
    if (isServiceRoleGated(statement)) continue;
    const isUpdate = /for\s+(all|update)\b/i.test(statement);
    const selfScoped = /auth\.uid\(\)\s*=\s*user_id|user_id\s*=\s*auth\.uid\(\)/i.test(statement);
    assert.ok(
      !(isUpdate && selfScoped && targetsClientRole(statement)),
      `found a self-scoped UPDATE policy on workspace_memberships:\n${statement}`,
    );
  }
});

test("workspace_memberships' final policy set has no INSERT/UPDATE/DELETE reachable by authenticated at all — writes are service-role/helper-only", () => {
  const state = buildFinalRlsState(migrations);
  for (const statement of finalPoliciesForTable(state, "workspace_memberships")) {
    if (isServiceRoleGated(statement)) continue;
    const isWrite = /for\s+(all|insert|update|delete)\b/i.test(statement);
    assert.ok(
      !(isWrite && targetsClientRole(statement)),
      `found a client-reachable write policy on workspace_memberships (writes must go through service-role helpers):\n${statement}`,
    );
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. No policy authorizes off user_metadata/raw_user_meta_data (test #6)
// ─────────────────────────────────────────────────────────────────────────────

test("no RLS policy authorizes admin/founder/owner/billing access via user_metadata or raw_user_meta_data (test #6)", () => {
  for (const { name, text } of migrations) {
    const policyPattern = /create policy[\s\S]*?;/gi;
    const matches = text.match(policyPattern) ?? [];
    for (const statement of matches) {
      assert.doesNotMatch(
        statement,
        /raw_user_meta_data|user_metadata|auth\.jwt\(\)\s*->>?\s*'role'/i,
        `${name}: a policy must not use user_metadata/raw_user_meta_data/jwt role claims for authorization:\n${statement}`,
      );
    }
  }
});

// current_company_id() keys every legacy company-scoped RLS policy. It used to
// read user_metadata.company_id, which users can rewrite through GoTrue (F1);
// PR-1 (20261021000000_current_company_id_from_auth_uid.sql) binds it to
// auth.uid(). Pin that the EFFECTIVE (latest) definition never reads
// user-editable metadata again, and that the residual-risk doc records it.
test("current_company_id()'s effective definition never reads user-editable metadata (F1)", async () => {
  const definitions = migrations.filter(({ text }) => /create\s+(or\s+replace\s+)?function\s+public\.current_company_id\s*\(/i.test(text));
  assert.ok(definitions.length > 0, "no migration defines public.current_company_id()");
  const latest = definitions[definitions.length - 1];
  const body = latest.text.match(/function\s+public\.current_company_id\s*\([\s\S]*?\$\$([\s\S]*?)\$\$/i)?.[1] ?? "";
  assert.match(body, /auth\.uid\(\)/, `${latest.name}: current_company_id() must resolve from auth.uid()`);
  assert.doesNotMatch(body, /user_metadata|raw_user_meta_data|auth\.jwt\(\)/i, `${latest.name}: current_company_id() must not read JWT/user metadata`);

  const doc = await readSource("docs/security/supabase-rls-service-role-boundary.md");
  assert.match(doc, /current_company_id/);
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. No service-role import in "use client" files (test #7)
// ─────────────────────────────────────────────────────────────────────────────

async function listFilesRecursive(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const results = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === ".next") continue;
      results.push(...(await listFilesRecursive(full)));
    } else if (/\.(ts|tsx)$/.test(entry.name)) {
      results.push(full);
    }
  }
  return results;
}

test("no 'use client' file imports or calls the service-role client factory (test #7)", async () => {
  const srcDir = new URL("../src/", import.meta.url).pathname;
  const files = await listFilesRecursive(srcDir);
  for (const file of files) {
    const text = await fs.readFile(file, "utf8");
    const firstMeaningfulLine = text.split("\n").find((line) => line.trim().length > 0) ?? "";
    if (!/^["']use client["']/.test(firstMeaningfulLine.trim())) continue;
    assert.doesNotMatch(
      text,
      /createSupabaseServiceRoleClient|createPrivilegedSupabaseClient|SUPABASE_SERVICE_ROLE_KEY/,
      `${file}: a "use client" file must never reference the service-role client factory or key`,
    );
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 8. Every direct service-role usage site is registered (test #8)
// ─────────────────────────────────────────────────────────────────────────────

// Factory/definition/infra files: they define or generically re-export the
// privileged-client constructor rather than performing a specific
// privileged database operation, so they are not themselves "usage sites"
// requiring an individual registry entry (consistent with
// src/lib/db/supabase-server.ts's legacy factory being registered as a
// factory, not a usage, and src/lib/supabase/admin.ts never having been
// registered as a usage in the pre-existing registry).
const REGISTRY_EXEMPT_FACTORY_FILES = new Set([
  "src/lib/security/privileged-access.ts",
  "src/lib/supabase/admin.ts",
  "src/lib/aoc/adapters/privileged-db.ts",
  "src/lib/security/privileged-access-registry.ts",
]);

test("every file directly calling createSupabaseServiceRoleClient(/createPrivilegedSupabaseClient( is listed in the privileged-access registry (test #8)", async () => {
  const srcDir = new URL("../src/", import.meta.url).pathname;
  const files = await listFilesRecursive(srcDir);
  const registrySource = await readSource("src/lib/security/privileged-access-registry.ts");

  const usageFiles = [];
  for (const file of files) {
    const relative = path.relative(new URL("..", import.meta.url).pathname, file);
    if (REGISTRY_EXEMPT_FACTORY_FILES.has(relative)) continue;
    const text = await fs.readFile(file, "utf8");
    if (/createSupabaseServiceRoleClient\(|createPrivilegedSupabaseClient\(/.test(text)) {
      usageFiles.push(relative);
    }
  }

  assert.ok(usageFiles.length > 10, "sanity check: expected more than 10 direct usage sites");

  const unregistered = usageFiles.filter((relative) => !registrySource.includes(`"${relative}"`));
  assert.deepEqual(unregistered, [], `unregistered privileged-access usage sites: ${unregistered.join(", ")}`);
});

test("assertPrivilegedAccessJustified throws for a file not in the registry", async () => {
  const { assertPrivilegedAccessJustified } = await import("../src/lib/security/privileged-access-registry.ts");
  assert.throws(() => assertPrivilegedAccessJustified("src/lib/definitely-not-registered.ts"));
});

// ─────────────────────────────────────────────────────────────────────────────
// 9 & 10. Stripe webhook / founder dashboard gate ordering (tests #9, #10)
// ─────────────────────────────────────────────────────────────────────────────

test("Stripe webhook route verifies the signature before creating any service-role client (test #9)", async () => {
  const source = await readSource("src/app/api/billing/webhook/route.ts");
  const verifyIndex = source.indexOf("verifyStripeWebhookEvent");
  const serviceRoleIndex = source.indexOf("createPrivilegedSupabaseClient(");
  assert.ok(verifyIndex > -1, "verifyStripeWebhookEvent call not found");
  assert.ok(serviceRoleIndex > verifyIndex, "service-role client must not be created before signature verification");
});

test("founder early-access dashboard gates on isFounderOrInternalUser before any service-role client (test #10)", async () => {
  const source = await readSource("src/app/(protected)/early-access/page.tsx");
  const gateIndex = source.indexOf("isFounderOrInternalUser(user)");
  const serviceRoleIndex = source.indexOf("createSupabaseServiceRoleClient(");
  assert.ok(gateIndex > -1 && serviceRoleIndex > gateIndex);
});

// ─────────────────────────────────────────────────────────────────────────────
// 11-13. Early-access mutations / invite acceptance / billing lifecycle are
//    documented service-role usages (tests #11, #12, #13)
// ─────────────────────────────────────────────────────────────────────────────

test("early-access mutation helpers (src/lib/early-access.ts) are registered as a documented privileged caller (test #11)", async () => {
  const registrySource = await readSource("src/lib/security/privileged-access-registry.ts");
  assert.match(registrySource, /"src\/lib\/early-access\.ts"/);
});

test("workspace invite acceptance service-role usage is documented (test #12)", async () => {
  const registrySource = await readSource("src/lib/security/privileged-access-registry.ts");
  assert.match(registrySource, /"src\/lib\/workspace-team\.ts"/);
  assert.match(registrySource, /acceptWorkspaceInvite/);
});

test("billing lifecycle service-role usage is documented and behind webhook signature verification (test #13)", async () => {
  const registrySource = await readSource("src/lib/security/privileged-access-registry.ts");
  assert.match(registrySource, /"src\/lib\/billing\.ts"/);
  assert.match(registrySource, /"src\/app\/api\/billing\/webhook\/route\.ts"/);
});

// ─────────────────────────────────────────────────────────────────────────────
// 14-17. Table-specific write-site allowlists (tests #14-17)
// ─────────────────────────────────────────────────────────────────────────────

async function findWriteSites(table, { insertUpdateUpsertDelete = true } = {}) {
  const srcDir = new URL("../src/", import.meta.url).pathname;
  const files = await listFilesRecursive(srcDir);
  const sites = [];
  const methodPattern = insertUpdateUpsertDelete ? /\.(insert|update|upsert|delete)\(/ : /\.(update|upsert)\(/;
  for (const file of files) {
    const text = await fs.readFile(file, "utf8");
    const relative = path.relative(new URL("..", import.meta.url).pathname, file);
    const fromPattern = new RegExp(`\\.from\\("${table}"\\)`, "g");
    let match;
    while ((match = fromPattern.exec(text))) {
      const windowText = text.slice(match.index, match.index + 400);
      if (methodPattern.test(windowText)) {
        sites.push(relative);
        break;
      }
    }
  }
  return [...new Set(sites)];
}

test("workspace_memberships writes only occur in approved server helpers (test #14)", async () => {
  const sites = await findWriteSites("workspace_memberships");
  const allowed = new Set([
    "src/lib/workspace-team.ts", // acceptWorkspaceInvite, updateWorkspaceMemberRole
    "src/lib/workspaces.ts", // workspace bootstrap
    "src/lib/early-access.ts", // early-access workspace activation
  ]);
  const unexpected = sites.filter((s) => !allowed.has(s));
  assert.deepEqual(unexpected, [], `unexpected workspace_memberships write site(s): ${unexpected.join(", ")}`);
});

test("company_subscriptions writes only occur in billing.ts (test #15)", async () => {
  const sites = await findWriteSites("company_subscriptions");
  assert.deepEqual(sites, ["src/lib/billing.ts"]);
});

test("billing_webhook_events writes only occur in billing.ts (test #16)", async () => {
  const sites = await findWriteSites("billing_webhook_events");
  assert.deepEqual(sites, ["src/lib/billing.ts"]);
});

test("early_access_invites writes only occur in the early-access helper (test #17)", async () => {
  const sites = await findWriteSites("early_access_invites");
  assert.deepEqual(sites, ["src/lib/early-access.ts"]);
});

// ─────────────────────────────────────────────────────────────────────────────
// 18. workspace_invitations tokens not exposed through a broad select policy
//    (test #18)
// ─────────────────────────────────────────────────────────────────────────────

test("workspace_invitations: authenticated SELECT grant is column-scoped and excludes token (test #18)", async () => {
  const text = await readSource("supabase/migrations/20260818000000_supabase_rls_service_role_boundary_hardening.sql");
  assert.match(text, /revoke select on public\.workspace_invitations from authenticated/i);
  const grantMatch = text.match(/grant select\s*\(([\s\S]*?)\)\s*on public\.workspace_invitations to authenticated/i);
  assert.ok(grantMatch, "expected a column-scoped grant select (...) on workspace_invitations to authenticated");
  assert.doesNotMatch(grantMatch[1], /\btoken\b/, "token column must not be in the authenticated column grant");
});

test("no application code selects the workspace_invitations.token column for an authenticated (non-service-role) client", async () => {
  const source = await readSource("src/app/(protected)/team/page.tsx");
  const selectMatch = source.match(/from\("workspace_invitations"\)\.select\("([^"]+)"\)/);
  assert.ok(selectMatch, "expected a .from(\"workspace_invitations\").select(...) call in team/page.tsx");
  assert.doesNotMatch(selectMatch[1], /\btoken\b/);
});

// ─────────────────────────────────────────────────────────────────────────────
// 19-21. Documentation (tests #19, #20, #21)
// ─────────────────────────────────────────────────────────────────────────────

test("Supabase RLS / service-role boundary doc exists (test #19)", async () => {
  await assert.doesNotReject(readSource("docs/security/supabase-rls-service-role-boundary.md"));
});

test("doc lists all required service-role-only tables (test #20)", async () => {
  const doc = await readSource("docs/security/supabase-rls-service-role-boundary.md");
  for (const table of ["billing_webhook_events", "early_access_invites", "early_access_events", "company_subscriptions"]) {
    assert.match(doc, new RegExp(table));
  }
});

test("doc lists all required approved service-role usages (test #21)", async () => {
  const doc = await readSource("docs/security/supabase-rls-service-role-boundary.md");
  assert.match(doc, /Stripe webhook/i);
  assert.match(doc, /founder|internal early access/i);
  assert.match(doc, /invite acceptance/i);
  assert.match(doc, /billing lifecycle/i);
});
