import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

// ─── Regression tests for defects found by an automated review (Codex) on
// PR #526 (Workspace → PMO → Project hierarchy) after it was merged to main.
// Each test pins a fix so a future refactor cannot silently reintroduce the
// defect. Three findings were architecturally significant enough to check
// with the user before fixing (see PR conversation): which workspace new
// projects/PMOs should resolve to for multi-workspace users, the
// ensureDefaultPmo runtime race, and what counts as "PMO setup complete"
// for onboarding. The user asked for the first two to be fixed and the
// third investigated (not changed) — both are covered below alongside the
// first-round findings.
// ─────────────────────────────────────────────────────────────────────────────

const layout = fs.readFileSync("src/app/(protected)/layout.tsx", "utf8");
const projectSettingsClient = fs.readFileSync("src/components/pmfreak/projects/project-settings-client.tsx", "utf8");
const contextChatService = fs.readFileSync("src/lib/chat/context-chat-service.ts", "utf8");
const savePmoTenant = fs.readFileSync("src/lib/pmo/save-pmo-tenant.ts", "utf8");
const projectAdminService = fs.readFileSync("src/lib/projects/project-admin-service.ts", "utf8");
const migration = fs.readFileSync("supabase/migrations/20260828000001_workspace_pmo_project_hierarchy.sql", "utf8");
const ensureDefaultPmoMigration = fs.readFileSync("supabase/migrations/20260828000002_ensure_default_pmo_advisory_lock.sql", "utf8");
const resolveWriteWorkspace = fs.readFileSync("src/lib/workspaces/resolve-write-workspace.ts", "utf8");
const pmoService = fs.readFileSync("src/lib/pmos/pmo-service.ts", "utf8");
const saveProjectOnboarding = fs.readFileSync("src/lib/projects/save-project-onboarding.ts", "utf8");
const projectsActions = fs.readFileSync("src/app/(protected)/projects/actions.ts", "utf8");
// First Execution Experience sprint: projects/actions.ts now delegates
// project creation to this shared service (also used by POST /api/projects),
// so its workspace resolution lives there rather than being duplicated here.
const createMinimalProject = fs.readFileSync("src/lib/projects/create-minimal-project.ts", "utf8");
const commandCenterActions = fs.readFileSync("src/app/(protected)/command-center/actions.ts", "utf8");
const onboardingState = fs.readFileSync("src/lib/auth/resolve-onboarding-state.ts", "utf8");

// ─── Finding: resolveCanonicalWorkspace's `recovered` flag (meaning "the
// preferred-workspace cookie didn't match a real membership, fell back") was
// wired into resolveOnboardingState's `isRecovered` flag (meaning "this
// workspace was just bootstrapped, skip the trial check"). A trial-blocked
// user could set the pmfreak.workspaceId cookie to any non-matching value
// (a random UUID, or a workspace they left) and permanently bypass trial
// gating, since they fully control that cookie. Reproduced by tracing:
// resolveCanonicalWorkspace(userId, "garbage") -> recovered=true even though
// the fallback workspace has real trial history. ────────────────────────────

test("protected layout only skips the trial check for a workspace freshly bootstrapped in this request, never for a stale/tampered preferred-workspace cookie", () => {
  assert.ok(
    /isRecovered:\s*resolvedWorkspace\.bootstrapped/.test(layout),
    "resolveOnboardingState must receive a flag scoped to resolveWriteWorkspace's own bootstrap branch, not a cookie-mismatch-fallback signal"
  );
  assert.ok(
    !/isRecovered:\s*resolvedWorkspace\.recovered/.test(layout),
    "must not pass resolveCanonicalWorkspace's cookie-mismatch-fallback flag directly into the trial-skip gate"
  );
});

// ─── Finding: project-settings-client.tsx always resent form.pmoId on every
// save. The PMO dropdown only lists active PMOs, so a project currently
// sitting in an archived PMO keeps form.pmoId at that archived id (no
// matching <option>, never touched by the user) — resending it unconditionally
// resubmitted that unchanged value on every save and tripped the server's
// (correct) archived-PMO rejection for edits unrelated to the PMO field,
// blocking ALL edits to such a project, including fixing its status. ────────

test("project settings only sends pmoId in the PATCH body when the user actually changed it", () => {
  assert.ok(
    /pmoChanged\s*=\s*form\.pmoId\s*!==\s*\(project\.pmo_id\s*\?\?\s*""\)/.test(projectSettingsClient),
    "save() must compare form.pmoId against the original project.pmo_id"
  );
  assert.ok(
    /\.\.\.\(pmoChanged \? \{ pmoId: form\.pmoId \|\| null \} : \{\}\)/.test(projectSettingsClient),
    "pmoId must be omitted from the PATCH body entirely when unchanged, not just recomputed"
  );
});

// ─── Finding: context-chat-service.ts's listMessages ordered ascending then
// applied .limit(200) — for a conversation with more than 200 messages this
// returns the OLDEST 200 rows forever, never the newest, stranding long
// conversations on their earliest history. ──────────────────────────────────

test("listMessages fetches the newest N messages (descending + limit) then restores chronological order, rather than limiting an ascending query", () => {
  const fn = contextChatService.slice(contextChatService.indexOf("export async function listMessages"));
  // PB-CHAT-01: ordered by the insertion sequence (stable under timestamp ties), still descending.
  assert.ok(/order\("message_seq", \{ ascending: false \}\)/.test(fn), "must order descending before applying limit to take the most recent rows");
  assert.ok(/\.reverse\(\)/.test(fn), "must reverse the descending page back into chronological order for callers");
});

// ─── Finding: savePmoTenant's idempotent "skip if the workspace already has
// a pmos row" branch updated workspace_governance and workspaces.name but
// never the pmos row itself — re-running the setup wizard to rename a PMO
// left the pmos row (what navigation/chat/project-assignment hang off)
// showing the old, stale name indefinitely.
//
// PMF-004 replaced the raw check-then-insert-or-update this test originally
// pinned with a single call to the advisory-lock-guarded ensure_default_pmo
// RPC (see 20260831000000_pmo_command_center_activation_idempotency.sql):
// concurrent activations could otherwise both observe "no existing PMO" and
// both insert. p_sync_existing:true is what now carries the same
// keep-the-pmos-row-in-sync-on-rename guarantee this test protects. ────────

test("savePmoTenant syncs the existing default PMO's name/type on re-activation via the idempotent RPC, not just workspace_governance", () => {
  assert.match(savePmoTenant, /supabaseClient\.rpc\("ensure_default_pmo"/, "must call the shared advisory-lock-guarded RPC, not a raw check-then-insert");
  const rpcCall = savePmoTenant.slice(savePmoTenant.indexOf('supabaseClient.rpc("ensure_default_pmo"'));
  const callArgs = rpcCall.slice(0, rpcCall.indexOf("});"));
  assert.ok(callArgs.includes("p_name: tenant.identity.pmoName"), "the call must carry the wizard's (possibly renamed) PMO name");
  assert.ok(callArgs.includes("p_sync_existing: true"), "Command Center re-activation must sync an existing default PMO's name/type, not just create-once");
});

// ─── Finding: duplicateProject copied source.pmo_id directly into the new
// project with no archived-PMO check, even though updateProject (fixed in
// the prior independent-review sprint) rejects assigning a project to an
// archived PMO. Duplicating a project that lives in an archived PMO is the
// same kind of new assignment as an explicit move, so it silently bypassed
// that exact rule via a different code path. ────────────────────────────────

test("duplicateProject falls back to unassigned rather than copying an archived PMO into the new project", () => {
  const fn = projectAdminService.slice(projectAdminService.indexOf("export async function duplicateProject"));
  assert.ok(/pmo\.status === "archived"\) targetPmoId = null/.test(fn), "must null out targetPmoId when the source project's PMO is archived");
  assert.ok(/pmo_id:\s*targetPmoId/.test(fn), "the insert must use the archived-checked targetPmoId, not source.pmo_id directly");
});

// ─── Finding: the context_conversations CHECK constraint's comment described
// pmo_id as "optional denormalization" for project-scoped rows, even though
// the scope-unique index keys on (workspace_id, context_type, pmo_id,
// project_id). If any writer ever set pmo_id on a project-scoped row (which
// the constraint permitted), it would no longer collide with the pmo_id-less
// row for the same project on the unique index — producing a second "active"
// conversation and silently fragmenting that project's chat thread. The one
// real writer (getOrCreateConversation) never sets it, so this was a latent
// schema landmine rather than a live bug; closed by tightening the CHECK
// constraint to match what the real writer already does. ───────────────────

test("context_conversations CHECK constraint requires pmo_id to be null for project-scoped rows (no denormalization escape hatch)", () => {
  assert.ok(
    /context_type = 'project' and project_id is not null and pmo_id is null/.test(migration),
    "project scope must forbid a non-null pmo_id, closing the scope-unique-index fragmentation risk"
  );
});

// ─── Finding: context_messages.workspace_id is a caller-supplied parameter
// (appendMessage) with no database-level guarantee it matches its own
// conversation_id's real workspace_id — the same class of gap as
// projects.pmo_id / context_conversations.pmo_id, which already got
// BEFORE INSERT/UPDATE triggers in the validation sprint. This table was
// missed. Closed with the same trigger pattern. ─────────────────────────────

test("a trigger enforces context_messages.workspace_id matches its conversation's own workspace", () => {
  assert.ok(migration.includes("enforce_context_message_same_workspace"));
  assert.ok(/create trigger context_messages_same_workspace/.test(migration));
  assert.ok(/before insert or update of conversation_id, workspace_id on context_messages/.test(migration));
});

// ─── Finding (architecturally significant — user approved the fix):
// saveProjectOnboarding.ts, savePmoTenant.ts, projects/actions.ts,
// command-center/actions.ts, and api/getting-started all resolved the
// workspace to write into via ensureUserWorkspace/resolveCanonicalWorkspace
// with no preferred-workspace argument — always the user's OLDEST
// membership, never the workspace they're actually viewing/switched to via
// the preferred-workspace cookie. A user in Workspace A (oldest) and
// Workspace B (active/selected) would have a project or PMO silently
// created in Workspace A regardless of which workspace's UI they were
// using. Closed by centralizing resolution in one helper
// (resolveWriteWorkspace) that honors the caller's real, membership-
// validated preferred workspace and only falls back to
// ensureUserWorkspace's oldest-membership/bootstrap behavior when no valid
// preference exists. ─────────────────────────────────────────────────────

test("resolveWriteWorkspace resolves the caller's preferred (cookie-selected, membership-validated) workspace, falling back to ensureUserWorkspace only when none exists", () => {
  assert.ok(resolveWriteWorkspace.includes("resolvePreferredWorkspace"), "must consult the preferred-workspace cookie via the validated resolver");
  assert.ok(resolveWriteWorkspace.includes("ensureUserWorkspace"), "must still fall back to bootstrap/oldest-membership resolution when there is no valid preference");
  const fnBody = resolveWriteWorkspace.slice(resolveWriteWorkspace.indexOf("export async function resolveWriteWorkspace"));
  const preferredCallIdx = fnBody.indexOf("resolvePreferredWorkspace");
  const ensureCallIdx = fnBody.indexOf("ensureUserWorkspace(userId)");
  assert.ok(preferredCallIdx > -1 && ensureCallIdx > -1 && preferredCallIdx < ensureCallIdx, "must check the preferred workspace before ever falling back to ensureUserWorkspace");
});

test("every project/PMO write entry point resolves its workspace via resolveWriteWorkspace, not ensureUserWorkspace/resolveCanonicalWorkspace directly", () => {
  for (const [name, src] of [
    ["save-project-onboarding.ts", saveProjectOnboarding],
    ["save-pmo-tenant.ts", savePmoTenant],
    ["projects/actions.ts (via createMinimalProject)", projectsActions + createMinimalProject],
    ["command-center/actions.ts", commandCenterActions],
  ]) {
    assert.ok(src.includes("resolveWriteWorkspace"), `${name} must resolve its workspace via resolveWriteWorkspace`);
    assert.ok(!/\bensureUserWorkspace\(/.test(src), `${name} must not call ensureUserWorkspace directly (bypasses the preferred-workspace cookie)`);
    assert.ok(!/\bresolveCanonicalWorkspace\(/.test(src), `${name} must not call resolveCanonicalWorkspace directly (bypasses the shared bootstrap fallback)`);
  }
});

// ─── Finding (architecturally significant — user approved the fix):
// ensureDefaultPmo (pmo-service.ts) was a check-then-insert
// (listPmos() then createPmo()) run from application code — the same race
// class already fixed for the one-time migration backfill via
// pg_advisory_xact_lock, just triggered at runtime by any of four
// concurrent project-creation entry points instead of migration time.
// Closed by moving the check-then-insert into a single Postgres function
// (ensure_default_pmo, 20260828000002) that acquires the advisory lock and
// performs both steps in one transaction — verified live: 5 truly
// concurrent calls against the same brand-new workspace all returned the
// identical PMO id, exactly one row created. ────────────────────────────────

test("ensureDefaultPmo calls the advisory-lock-guarded ensure_default_pmo RPC instead of a check-then-insert from application code", () => {
  const fn = pmoService.slice(pmoService.indexOf("export async function ensureDefaultPmo"));
  assert.ok(/\.rpc\("ensure_default_pmo"/.test(fn), "must delegate to the single-transaction RPC, not listPmos()+createPmo()");
  assert.ok(!/listPmos\(/.test(fn), "must not read-then-decide from application code — the whole check-then-insert must happen inside the RPC");
});

test("the ensure_default_pmo Postgres function acquires a workspace-scoped advisory lock before its check-then-insert, and its EXECUTE grant is explicitly scoped (not left at the PUBLIC default)", () => {
  assert.ok(/pg_advisory_xact_lock\(hashtext\(/.test(ensureDefaultPmoMigration));
  assert.ok(/create or replace function ensure_default_pmo/.test(ensureDefaultPmoMigration));
  assert.ok(/revoke all on function public\.ensure_default_pmo/.test(ensureDefaultPmoMigration), "must not rely on Postgres's default PUBLIC execute grant, matching this codebase's established convention");
  assert.ok(/grant execute on function public\.ensure_default_pmo.*to authenticated, service_role/.test(ensureDefaultPmoMigration));
});

// ─── Superseded finding (PMF-001/PMF-002 canonical onboarding
// consolidation): the "any active pmos row satisfies PMO setup" check this
// finding originally pinned as intentional was itself the routing-layer gate
// that forced every PMO-less user through the legacy getting-started wizard
// before they could create a Project — a P0 defect (PMF-002), not the
// benign secondary-source-of-truth design this finding assumed. The legacy
// wizard (api/getting-started/route.ts) is retired, resolveOnboardingState
// no longer checks pmos at all, and no production path writes
// onboarding_completed. See
// docs/audits/remediation/pmf-001-002-canonical-onboarding-honest-activation.md.
// ─────────────────────────────────────────────────────────────────────────

test("resolveOnboardingState has no PMO precondition — Project creation never requires a PMO to exist first", () => {
  assert.ok(!onboardingState.includes('.from("pmos")'), "the resolver must not query pmos at all — no PMO precondition anywhere in onboarding state resolution");
  assert.ok(!/onboarding_completed/.test(savePmoTenant), "save-pmo-tenant.ts must no longer write the legacy onboarding_completed flag");
});
