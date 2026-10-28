/**
 * Schema contract tests.
 *
 * These tests enforce the canonical contract between the runtime and
 * the database by cross-checking:
 *   1. That every column declared in database-contract.ts appears in
 *      at least one migration file.
 *   2. That known-drifted columns (the ones patched in the hardening
 *      migration) now exist in migrations and in the contract file.
 *   3. That the governance schema_version constants match what the
 *      save/load functions actually use.
 *   4. That the RLS fix for workspace_governance is present.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();

function readMigrationsContent() {
  const dir = join(ROOT, "supabase/migrations");
  return readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .map((f) => readFileSync(join(dir, f), "utf8"))
    .join("\n");
}

const migrations = readMigrationsContent();
const contract = readFileSync(join(ROOT, "src/lib/db/database-contract.ts"), "utf8");
const resolver = readFileSync(join(ROOT, "src/lib/workspaces/canonical-workspace-resolver.ts"), "utf8");
const saveOnboarding = readFileSync(join(ROOT, "src/lib/projects/save-project-onboarding.ts"), "utf8");
const loadTenant = readFileSync(join(ROOT, "src/lib/pmo/load-pmo-tenant.ts"), "utf8");
const saveTenant = readFileSync(join(ROOT, "src/lib/pmo/save-pmo-tenant.ts"), "utf8");
const saveGovernance = readFileSync(join(ROOT, "src/lib/pmo/save-workspace-governance.ts"), "utf8");

// ─────────────────────────────────────────────────────────────────────────────
// DRIFT-01: workspaces.status
// ─────────────────────────────────────────────────────────────────────────────

test("workspaces.status column exists in migrations", () => {
  assert.match(
    migrations,
    /alter table public\.workspaces\s+add column if not exists status text/,
    "workspaces.status must be added in a migration"
  );
});

test("workspaces.status has correct check constraint in migrations", () => {
  assert.match(
    migrations,
    /workspaces_status_check/,
    "workspaces_status_check constraint must exist"
  );
  assert.match(
    migrations,
    /check \(status in \('active', 'archived', 'deleted'\)\)/,
    "status check constraint must enumerate allowed values"
  );
});

test("workspaces.status is declared in database-contract.ts", () => {
  assert.match(contract, /status: WorkspaceStatus/, "WorkspaceRow must include status field");
  assert.match(contract, /WorkspaceStatus = "active" \| "archived" \| "deleted"/, "WorkspaceStatus type must be declared");
});

test("canonical-workspace-resolver consumes only contract-declared columns", () => {
  // It selects id and status — both must be in contract
  assert.match(resolver, /select\("id, status"\)/, "resolver must select id and status");
  // It must NOT select any column absent from the contract
  assert.doesNotMatch(resolver, /\.select\(".*?(?:description|onboarding_payload|governance_jsonb).*?"\)/);
});

// ─────────────────────────────────────────────────────────────────────────────
// DRIFT-02: projects.onboarding_payload
// ─────────────────────────────────────────────────────────────────────────────

test("projects.onboarding_payload column exists in migrations", () => {
  assert.match(
    migrations,
    /alter table public\.projects\s+add column if not exists onboarding_payload jsonb/,
    "projects.onboarding_payload must be added in a migration"
  );
});

test("projects.onboarding_payload is declared in database-contract.ts", () => {
  assert.match(contract, /onboarding_payload: Record<string, unknown> \| null/);
  assert.match(contract, /"onboarding_payload"/, "onboarding_payload must be in PROJECT_SELECTABLE_COLUMNS");
});

test("save-project-onboarding.ts inserts onboarding_payload", () => {
  // Q12: the payload is handed to create_project_within_limit, which writes the column.
  assert.match(saveOnboarding, /onboardingPayload: payload as unknown as Record<string, unknown>/, "runtime must write onboarding_payload");
  assert.match(
    readFileSync("supabase/migrations/20261028000000_q12_project_create_quota.sql", "utf8"),
    /insert into public\.projects \(user_id, workspace_id, pmo_id, name, description, onboarding_payload\)/,
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// DRIFT-03: workspace_governance RLS cast fix
// ─────────────────────────────────────────────────────────────────────────────

test("workspace_governance RLS policy uses explicit uuid cast", () => {
  assert.match(
    migrations,
    /workspace_id::uuid in/,
    "governance RLS must cast workspace_id::uuid to compare with workspace_memberships"
  );
});

test("workspace_governance RLS policy does NOT use auth.uid()::text for membership join", () => {
  // The old broken version cast uid to text for the workspace_memberships lookup.
  // The fix compares directly: user_id = auth.uid()
  const hardeningMigration = readFileSync(
    join(ROOT, "supabase/migrations/20260601000000_schema_contract_hardening.sql"),
    "utf8"
  );
  assert.doesNotMatch(
    hardeningMigration,
    /where user_id = auth\.uid\(\)::text/,
    "hardening migration must not use ::text cast for uuid user_id comparison"
  );
  assert.match(
    hardeningMigration,
    /where user_id = auth\.uid\(\)/,
    "hardening migration must compare user_id = auth.uid() directly"
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// Schema version contract (intentional two-phase design)
// ─────────────────────────────────────────────────────────────────────────────

test("contract declares both governance schema version constants", () => {
  assert.match(contract, /GOVERNANCE_SCHEMA_VERSION_SKELETON = 1/);
  assert.match(contract, /GOVERNANCE_SCHEMA_VERSION_TENANT\s*= 2/);
});

test("save-workspace-governance.ts uses schema version 1 (skeleton phase)", () => {
  assert.match(saveGovernance, /GOVERNANCE_SCHEMA_VERSION\s*=\s*1/, "governance wizard must write v1");
});

test("save-pmo-tenant.ts uses schema version 2 (tenant activation phase)", () => {
  assert.match(saveTenant, /PMO_TENANT_SCHEMA_VERSION\s*=\s*2/, "tenant activation must write v2");
});

test("load-pmo-tenant.ts only accepts schema version 2", () => {
  assert.match(loadTenant, /schema_version !== 2/, "tenant loader must reject non-v2 records");
});

// ─────────────────────────────────────────────────────────────────────────────
// Structural: contract file integrity
// ─────────────────────────────────────────────────────────────────────────────

test("contract exports DATABASE_CONTRACT_VERSION", () => {
  assert.match(contract, /DATABASE_CONTRACT_VERSION/);
});

test("contract declares all six core tables", () => {
  for (const table of [
    "WorkspaceRow",
    "WorkspaceMembershipRow",
    "ProjectRow",
    "WorkspaceGovernanceRow",
    "WorkspaceRuntimeStateRow",
    "TrialLicenseRow",
  ]) {
    assert.match(contract, new RegExp(`export type ${table}`), `contract must export ${table}`);
  }
});

test("workspace_runtime_state text PK architecture is documented in contract", () => {
  assert.match(
    contract,
    /company_id.*text.*PK.*1/s,
    "contract must document that runtime state PKs are text by design"
  );
});
