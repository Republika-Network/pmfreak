/**
 * Build-time DB schema contract enforcer.
 *
 * Blocks compilation if any runtime file consumes a column that is not
 * declared in src/lib/db/database-contract.ts.
 *
 * Usage: node scripts/check-db-schema-contract.mjs
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();

// ─── Helpers ─────────────────────────────────────────────────────────────────

function walk(dir, exts = [".ts", ".tsx"], files = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, exts, files);
    else if (exts.some((e) => full.endsWith(e))) files.push(full);
  }
  return files;
}

function rel(abs) {
  return abs.replace(`${ROOT}/`, "");
}

// ─── Load contract declared columns per table ─────────────────────────────────

const contract = readFileSync(join(ROOT, "src/lib/db/database-contract.ts"), "utf8");

// Extract `"column_name"` string literals from SELECTABLE_COLUMNS arrays.
// Pattern: finds arrays like `["id", "name", ...]`
function extractDeclaredColumns(tableConst) {
  const re = new RegExp(`${tableConst}[\\s\\S]*?\\] as const`, "m");
  const match = contract.match(re);
  if (!match) return new Set();
  const cols = new Set();
  for (const m of match[0].matchAll(/"([a-z_]+)"/g)) cols.add(m[1]);
  return cols;
}

const CONTRACT = {
  workspaces: extractDeclaredColumns("WORKSPACE_SELECTABLE_COLUMNS"),
  workspace_memberships: extractDeclaredColumns("WORKSPACE_MEMBERSHIP_SELECTABLE_COLUMNS"),
  projects: extractDeclaredColumns("PROJECT_SELECTABLE_COLUMNS"),
  pmos: extractDeclaredColumns("PMO_SELECTABLE_COLUMNS"),
  context_conversations: extractDeclaredColumns("CONTEXT_CONVERSATION_SELECTABLE_COLUMNS"),
  context_messages: extractDeclaredColumns("CONTEXT_MESSAGE_SELECTABLE_COLUMNS"),
  workspace_governance: extractDeclaredColumns("WORKSPACE_GOVERNANCE_SELECTABLE_COLUMNS"),
  workspace_runtime_state: extractDeclaredColumns("WORKSPACE_RUNTIME_STATE_SELECTABLE_COLUMNS"),
  operational_governance_briefs: extractDeclaredColumns("OPERATIONAL_GOVERNANCE_BRIEF_SELECTABLE_COLUMNS"),
  project_discovery: extractDeclaredColumns("PROJECT_DISCOVERY_SELECTABLE_COLUMNS"),
  raid_items: extractDeclaredColumns("RAID_ITEM_SELECTABLE_COLUMNS"),
  trial_licenses: extractDeclaredColumns("TRIAL_LICENSE_SELECTABLE_COLUMNS"),
  early_access_invites: extractDeclaredColumns("EARLY_ACCESS_INVITE_SELECTABLE_COLUMNS"),
  recommended_actions: extractDeclaredColumns("RECOMMENDED_ACTION_SELECTABLE_COLUMNS"),
  task_drafts: extractDeclaredColumns("TASK_DRAFT_SELECTABLE_COLUMNS"),
  execution_tasks: extractDeclaredColumns("EXECUTION_TASK_SELECTABLE_COLUMNS"),
  execution_task_events: extractDeclaredColumns("EXECUTION_TASK_EVENT_SELECTABLE_COLUMNS"),
  execution_task_dependencies: extractDeclaredColumns("EXECUTION_TASK_DEPENDENCY_SELECTABLE_COLUMNS"),
  internal_task_executions: extractDeclaredColumns("INTERNAL_TASK_EXECUTION_SELECTABLE_COLUMNS"),
  canonical_task_outcomes: extractDeclaredColumns("CANONICAL_TASK_OUTCOME_SELECTABLE_COLUMNS"),
  canonical_outcome_observations: extractDeclaredColumns("CANONICAL_OUTCOME_OBSERVATION_SELECTABLE_COLUMNS"),
  canonical_learning_candidates: extractDeclaredColumns("CANONICAL_LEARNING_CANDIDATE_SELECTABLE_COLUMNS"),
  canonical_learning_candidate_sources: extractDeclaredColumns("CANONICAL_LEARNING_CANDIDATE_SOURCE_SELECTABLE_COLUMNS"),
  project_milestones: extractDeclaredColumns("PROJECT_MILESTONE_SELECTABLE_COLUMNS"),
  pmo_executive_reports: extractDeclaredColumns("PMO_EXECUTIVE_REPORT_SELECTABLE_COLUMNS"),
  pmo_alert_payloads: extractDeclaredColumns("PMO_ALERT_PAYLOAD_SELECTABLE_COLUMNS"),
  playbook_snapshots: extractDeclaredColumns("PLAYBOOK_SNAPSHOT_SELECTABLE_COLUMNS"),
  playbook_recommendations: extractDeclaredColumns("PLAYBOOK_RECOMMENDATION_SELECTABLE_COLUMNS"),
  playbook_audit_events: extractDeclaredColumns("PLAYBOOK_AUDIT_EVENT_SELECTABLE_COLUMNS"),
  workspace_onboarding_preferences: extractDeclaredColumns("WORKSPACE_ONBOARDING_PREFERENCE_SELECTABLE_COLUMNS"),
};

// ─── Known-drift patterns that MUST NOT appear in runtime code ───────────────
// Each entry represents a previously broken column reference that was absent
// from the DB schema.  After the hardening migration both the column and the
// contract entry exist, but we still verify the migration patched them.

const REQUIRED_MIGRATION_PATCHES = [
  {
    description: "workspaces.status column must exist in migrations",
    file: "supabase/migrations/20260601000000_schema_contract_hardening.sql",
    pattern: /add column if not exists status text/,
  },
  {
    description: "projects.onboarding_payload column must exist in migrations",
    file: "supabase/migrations/20260601000000_schema_contract_hardening.sql",
    pattern: /add column if not exists onboarding_payload jsonb/,
  },
  {
    description: "workspace_governance RLS must cast workspace_id::uuid",
    file: "supabase/migrations/20260601000000_schema_contract_hardening.sql",
    pattern: /workspace_id::uuid in/,
  },
];

// ─── Scan runtime files for .from("table").select("col, col") patterns ───────
//
// This scanner catches the most common Supabase query patterns:
//   .from("table").select("col1, col2")
// It does NOT attempt to parse all Supabase query builder permutations —
// that would require full AST analysis.  For comprehensive coverage the
// canonical contract types provide TypeScript-level enforcement.
//
// Limitations intentionally excluded from scanning:
//   - Relation embeds: .select("relation(col1, col2)") — valid Supabase join syntax
//   - Multi-chain queries where .from() and .select() appear on different lines
//     with other .from() calls between them

const SCAN_DIRS = ["src/lib", "src/app/api", "src/app/(protected)"];
const SKIP_FILES = ["src/lib/db/database-contract.ts"];

// Match .from("table") immediately followed by .select("cols") without
// crossing another .from( call.  This prevents false positives from
// multi-step query chains where the .from and .select belong to different
// logical queries in the same file.
const SELECT_RE = /\.from\(["'](\w+)["']\)(?:(?!\.from\().)*?\.select\(["']([\w\s,.*()]+)["']\)/gs;

let violations = [];

for (const dir of SCAN_DIRS) {
  const absDir = join(ROOT, dir);
  for (const file of walk(absDir)) {
    const relPath = rel(file);
    if (SKIP_FILES.some((s) => relPath.includes(s))) continue;

    const src = readFileSync(file, "utf8");
    for (const match of src.matchAll(SELECT_RE)) {
      const table = match[1];
      const colsRaw = match[2];
      if (!(table in CONTRACT)) continue;

      const contractCols = CONTRACT[table];

      // Parse comma-separated column names.
      // Skip:
      //   - relation embeds: tokens containing "(" e.g. "workspace(id, name)"
      //   - wildcard *
      //   - tokens with ")" which are the tail of a relation embed
      const cols = colsRaw
        .split(",")
        .map((c) => c.trim())
        .filter((c) => c && c !== "*" && !c.includes("(") && !c.includes(")"));

      for (const col of cols) {
        if (!contractCols.has(col)) {
          violations.push(`${relPath}: column "${col}" on table "${table}" is NOT in database-contract.ts`);
        }
      }
    }
  }
}

// ─── Verify required migration patches ───────────────────────────────────────

for (const { description, file, pattern } of REQUIRED_MIGRATION_PATCHES) {
  try {
    const content = readFileSync(join(ROOT, file), "utf8");
    if (!pattern.test(content)) {
      violations.push(`Migration patch missing — ${description}`);
    }
  } catch {
    violations.push(`Migration file not found: ${file} — ${description}`);
  }
}

// ─── Report ───────────────────────────────────────────────────────────────────

if (violations.length) {
  console.error("\nDB schema contract violations detected:\n");
  for (const v of violations) console.error(`  ✗ ${v}`);
  console.error(
    `\n${violations.length} violation(s). Add the column to a migration AND declare it in src/lib/db/database-contract.ts.\n`
  );
  process.exit(1);
}

console.log("DB schema contract check passed.");
