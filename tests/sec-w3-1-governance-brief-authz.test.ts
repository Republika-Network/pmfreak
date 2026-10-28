import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// SEC-W3-1 (five-persona QA, Wave 3): a viewer could regenerate and overwrite the project's
// governance brief. Live coverage (owner/admin/pm allowed, viewer refused by route and RLS,
// cross-tenant refusal and slot squatting) is
// tests/security-regression/sec-w3-brief-authz-and-extraction-bounds.test.mjs.

const route = readFileSync("src/app/api/projects/[id]/operational-governance-brief/route.ts", "utf8");
const migration = readFileSync("supabase/migrations/20261029000000_sec_w3_1_governance_brief_writers.sql", "utf8");

test("SEC-W3-1: the regenerate route requires project write before reading or writing anything", () => {
  const authz = route.indexOf('await requireProjectAccess(projectId, "write");');
  assert.ok(authz > 0, "write permission required");
  for (const later of ['.from("projects")', "await generateAndPersistOperationalGovernanceBrief(", "await request.json()"]) {
    assert.ok(route.indexOf(later) > authz, `${later} only after the write check`);
  }
  assert.doesNotMatch(route, /getAuthUser/);
  assert.match(route, /denyFromAccessError\(error, \{ status: 403/);
});

test("SEC-W3-1: brief writes are owner/admin/pm only, with the project tied to the row's workspace", () => {
  assert.match(migration, /drop policy "workspace members can insert operational_governance_briefs"/);
  assert.match(migration, /drop policy "workspace members can update operational_governance_briefs"/);
  const writers = migration.match(/public\.has_workspace_role\(workspace_id, array\['owner', 'admin', 'pm'\]\)/g) ?? [];
  assert.equal(writers.length, 3, "insert WITH CHECK, update USING and update WITH CHECK");
  const tied = migration.match(/p\.id = operational_governance_briefs\.project_id\s+and p\.workspace_id = operational_governance_briefs\.workspace_id/g) ?? [];
  assert.equal(tied.length, 2, "insert and update both tie the project to the workspace");
  assert.doesNotMatch(migration, /is_workspace_member\(workspace_id\)\)\s*;?\s*$/m);
  assert.doesNotMatch(migration, /for select/, "the member read policy is unchanged");
});
