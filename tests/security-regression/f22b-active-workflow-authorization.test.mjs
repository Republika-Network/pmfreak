/**
 * F22-B — remediated by 20261026000000_f22b_active_workflow_authorization.sql together with the
 * vault intake / task-draft status route gates, the evidence delete path check and the
 * GoTrue-verified invitation acceptance (workspace-team.ts).
 *
 * Before the fix, through PostgREST with their own session:
 *  - a viewer inserted and rewrote vault documents and signals, task drafts, execution task
 *    events, recommended-action decision rows and governance violations / commitments (feeding
 *    PM capacity, performance and compliance reports), and deleted commitments;
 *  - any member wrote events under another user's identity and on another tenant's task, and
 *    decision rows under another user's identity;
 *  - a writer stored or rewrote project_evidence.storage_path to any object path, which
 *    DELETE /api/project-evidence then removed with the service role;
 *  - every member read invitation token hashes;
 *  - any member read and overwrote another member's copilot conversation state;
 *  - an account with an unconfirmed email could accept an invitation issued to that address.
 *
 * Every refusal is compared with a snapshot of the affected tables in both tenants.
 */
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { bindAppEnvToHarness, createTenantFixtures, requireHarnessEnv } from "./support/harness.mjs";

const env = requireHarnessEnv();
bindAppEnvToHarness(env);

const { acceptWorkspaceInvite, WorkspaceInviteError } = await import("../../src/lib/workspace-team.ts");

const hex = (n = 4) => randomBytes(n).toString("hex");
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const inAWeek = () => new Date(Date.now() + 7 * 864e5).toISOString();

let fx;
let viewer;
let pm;
let admin;
let owner;
let aOwner;
const rows = { A: {}, B: {} };

const must = async (promise, what) => {
  const { data, error } = await promise;
  if (error) throw new Error(`[security-regression] fixture step failed (${what}): ${error.message}`);
  return data;
};
const seed = async (table, row, what) => (await must(fx.admin.from(table).insert(row).select("id").single(), what)).id;

before(async () => {
  fx = await createTenantFixtures(env, { label: "f22b" });
  for (const key of ["A", "B"]) {
    const workspaceId = fx.workspaces[key];
    const projectId = fx.projects[key];
    const ownerId = key === "A" ? fx.users.aOwner.id : fx.users.bOwner.id;
    const r = rows[key];
    r.doc = await seed("vault_documents", { workspace_id: workspaceId, project_id: projectId, title: `doc ${key}`, raw_content: "harness", normalized_content: "harness", created_by: ownerId }, `doc ${key}`);
    r.raid = await seed("raid_items", { workspace_id: workspaceId, project_id: projectId, source_document_id: r.doc, category: "risk", title: `risk ${key}`, description: "harness", fingerprint: `f22b-${key}-${fx.tag}` }, `raid ${key}`);
    r.action = await seed("recommended_actions", { workspace_id: workspaceId, project_id: projectId, title: `action ${key}`, description: "harness", recommended_action_type: "escalate_issue", fingerprint: `f22b-${key}-${fx.tag}` }, `action ${key}`);
    // Drafts are unique per (workspace, recommended action): spare actions without a draft.
    r.freeAction = await seed("recommended_actions", { workspace_id: workspaceId, project_id: projectId, title: `free action ${key}`, description: "harness", recommended_action_type: "escalate_issue", fingerprint: `f22b-free-${key}-${fx.tag}` }, `free action ${key}`);
    r.spareAction = await seed("recommended_actions", { workspace_id: workspaceId, project_id: projectId, title: `spare action ${key}`, description: "harness", recommended_action_type: "escalate_issue", fingerprint: `f22b-spare-${key}-${fx.tag}` }, `spare action ${key}`);
    r.draft = await seed("task_drafts", { workspace_id: workspaceId, project_id: projectId, recommended_action_id: r.action, title: `draft ${key}`, description: "harness", created_by: ownerId }, `draft ${key}`);
    r.task = await seed("execution_tasks", { workspace_id: workspaceId, project_id: projectId, title: `task ${key}`, description: "harness", created_by: ownerId }, `task ${key}`);
    const signal = await seed("governance_signals", { workspace_id: workspaceId, signal_type: "approval_delay", signal_source: "project", source_entity_type: "project", source_entity_id: projectId, title: `signal ${key}`, description: "harness", severity: "medium" }, `signal ${key}`);
    r.govAction = await seed("governance_actions", { workspace_id: workspaceId, signal_id: signal, action_type: "other", action_priority: "medium", title: `gov action ${key}`, description: "harness", recommended_owner_type: "pm", recommended_due_date: inAWeek(), justification: "harness" }, `gov action ${key}`);
    r.commitment = await seed("governance_commitments", { workspace_id: workspaceId, action_id: r.govAction, commitment_title: `commitment ${key}`, commitment_description: "harness", owner_id: ownerId, owner_type: "pm", priority: "medium", due_date: inAWeek() }, `commitment ${key}`);
    r.violation = await seed("governance_violations", { workspace_id: workspaceId, violation_type: "unauthorized_approval", action_type: "approve", action_entity_type: "project", action_entity_id: projectId, actor_id: ownerId }, `violation ${key}`);
  }
  rows.B.viewerState = await seed("runtime_conversation_state", { company_id: fx.users.bViewer.id, workspace_id: fx.workspaces.B, session_key: "default", expires_at: inAWeek(), recent_questions: ["viewer's private question"] }, "viewer copilot state");
  rows.B.invite = await seed("workspace_invitations", { workspace_id: fx.workspaces.B, company_id: fx.users.bOwner.id, email: `sec-f22b-pending-${fx.tag}@example.test`, role: "pm", status: "pending", invited_by_user_id: fx.users.bOwner.id, token_hash: sha256(`f22b-${hex()}`), expires_at: inAWeek() }, "pending invite");

  viewer = await fx.signIn(fx.users.bViewer);
  pm = await fx.signIn(fx.users.bPm);
  admin = await fx.signIn(fx.users.bAdmin);
  owner = await fx.signIn(fx.users.bOwner);
  aOwner = await fx.signIn(fx.users.aOwner);
});

after(async () => {
  if (!fx) return;
  const workspaces = [fx.workspaces.A, fx.workspaces.B];
  for (const table of ["execution_task_events", "recommended_actions", "raid_items"]) await fx.admin.from(table).delete().in("workspace_id", workspaces);
  await fx.teardown();
});

const rejectedOrNoRows = (result) => result.error !== null || (Array.isArray(result.data) && result.data.length === 0);

const SNAPSHOT_TABLES = ["vault_documents", "vault_operational_signals", "task_drafts", "execution_task_events", "recommended_action_decisions", "project_evidence", "governance_violations", "governance_commitments", "runtime_conversation_state"];
const state = async () => {
  const out = {};
  for (const table of SNAPSHOT_TABLES) {
    const { data, error } = await fx.admin.from(table).select("*").in("workspace_id", [fx.workspaces.A, fx.workspaces.B]);
    if (error) throw new Error(`[security-regression] snapshot ${table}: ${error.message}`);
    out[table] = [...data].sort((x, y) => JSON.stringify(x).localeCompare(JSON.stringify(y)));
  }
  return out;
};

const assertRefusedWithoutChange = async (label, attempts) => {
  const snapshot = await state();
  for (const [name, run] of attempts) {
    const result = await run();
    assert.ok(rejectedOrNoRows(result), `${label}: ${name} must be refused (got ${JSON.stringify(result.data)})`);
  }
  assert.deepEqual(await state(), snapshot, `${label}: refused writes must leave every table unchanged`);
};

const B = () => fx.workspaces.B;
const docRow = (overrides = {}) => ({ workspace_id: B(), project_id: fx.projects.B, title: `doc ${hex()}`, raw_content: "x", normalized_content: "x", created_by: fx.users.bPm.id, ...overrides });
const signalRow = (overrides = {}) => ({ document_id: rows.B.doc, workspace_id: B(), project_id: fx.projects.B, signal_type: "risk", signal_text: "harness signal", ...overrides });
const draftRow = (overrides = {}) => ({ workspace_id: B(), project_id: fx.projects.B, recommended_action_id: rows.B.freeAction, title: `draft ${hex()}`, description: "x", created_by: fx.users.bPm.id, ...overrides });
const eventRow = (overrides = {}) => ({ workspace_id: B(), project_id: fx.projects.B, task_id: rows.B.task, event_type: "status_changed", event_payload: { to: "done" }, actor_user_id: fx.users.bPm.id, ...overrides });
const decisionRow = (overrides = {}) => ({ workspace_id: B(), project_id: fx.projects.B, recommended_action_id: rows.B.action, previous_status: "proposed", new_status: "accepted", decided_by: fx.users.bPm.id, ...overrides });
const evidenceRow = (overrides = {}) => ({ workspace_id: B(), project_id: fx.projects.B, file_name: "e.txt", file_type: "TXT", storage_path: `${fx.users.bPm.id}/${fx.projects.B}/${hex(8)}-e.txt`, uploaded_by: fx.users.bPm.id, status: "uploaded", ...overrides });

// ── vault ───────────────────────────────────────────────────────────────────

test("vault: a viewer cannot write documents or signals; writers cannot cross workspaces or impersonate", async () => {
  await assertRefusedWithoutChange("vault", [
    ["viewer inserts a document", () => viewer.from("vault_documents").insert(docRow({ created_by: fx.users.bViewer.id })).select("id")],
    ["viewer rewrites a document", () => viewer.from("vault_documents").update({ raw_content: "viewer edit", normalized_content: "viewer edit" }).eq("id", rows.B.doc).select("id")],
    ["viewer inserts a signal", () => viewer.from("vault_operational_signals").insert(signalRow()).select("id")],
    ["pm attaches a document to A's project", () => pm.from("vault_documents").insert(docRow({ project_id: fx.projects.A })).select("id")],
    ["pm moves a document to A's project", () => pm.from("vault_documents").update({ project_id: fx.projects.A }).eq("id", rows.B.doc).select("id")],
    ["pm writes a document as the owner", () => pm.from("vault_documents").insert(docRow({ created_by: fx.users.bOwner.id })).select("id")],
    ["pm signals on A's document", () => pm.from("vault_operational_signals").insert(signalRow({ document_id: rows.A.doc })).select("id")],
    ["pm signals with a project other than the document's", () => pm.from("vault_operational_signals").insert(signalRow({ project_id: null })).select("id")],
    ["A's owner writes into B", () => aOwner.from("vault_documents").insert(docRow({ created_by: fx.users.aOwner.id })).select("id")],
  ]);
});

test("vault: owner, admin and pm write documents and signals in their own workspace", async () => {
  for (const [role, client, user] of [["pm", pm, fx.users.bPm], ["admin", admin, fx.users.bAdmin], ["owner", owner, fx.users.bOwner]]) {
    const doc = await client.from("vault_documents").insert(docRow({ created_by: user.id })).select("id").single();
    assert.equal(doc.error, null, `${role}: ${doc.error?.message}`);
    const signal = await client.from("vault_operational_signals").insert(signalRow({ document_id: doc.data.id })).select("id");
    assert.equal(signal.data?.length, 1, `${role}: ${signal.error?.message}`);
    const updated = await client.from("vault_documents").update({ ingestion_status: "completed" }).eq("id", doc.data.id).select("id");
    assert.equal(updated.data?.length, 1, `${role}: ${updated.error?.message}`);
  }
});

// ── task drafts ─────────────────────────────────────────────────────────────

test("task drafts: a viewer cannot write; writers cannot impersonate or reference another tenant", async () => {
  await assertRefusedWithoutChange("task drafts", [
    ["viewer inserts", () => viewer.from("task_drafts").insert(draftRow({ created_by: fx.users.bViewer.id })).select("id")],
    ["viewer approves", () => viewer.from("task_drafts").update({ draft_status: "approved", description: "viewer text" }).eq("id", rows.B.draft).select("id")],
    ["pm inserts as the owner", () => pm.from("task_drafts").insert(draftRow({ created_by: fx.users.bOwner.id })).select("id")],
    ["pm drafts from A's recommended action", () => pm.from("task_drafts").insert(draftRow({ recommended_action_id: rows.A.freeAction })).select("id")],
    ["pm drafts from A's RAID item", () => pm.from("task_drafts").insert(draftRow({ raid_item_id: rows.A.raid })).select("id")],
    ["pm drafts for A's project", () => pm.from("task_drafts").insert(draftRow({ project_id: fx.projects.A })).select("id")],
    ["pm re-points a draft to A's action", () => pm.from("task_drafts").update({ recommended_action_id: rows.A.action }).eq("id", rows.B.draft).select("id")],
  ]);
});

test("task drafts: pm creates and updates drafts in their own workspace", async () => {
  const created = await pm.from("task_drafts").insert(draftRow({ recommended_action_id: rows.B.spareAction, raid_item_id: rows.B.raid })).select("id").single();
  assert.equal(created.error, null, created.error?.message);
  const updated = await pm.from("task_drafts").update({ draft_status: "reviewed" }).eq("id", created.data.id).select("id");
  assert.equal(updated.data?.length, 1, updated.error?.message);
});

// ── execution task events ───────────────────────────────────────────────────

test("execution task events: only writers, only as themselves, only on this workspace's and project's task", async () => {
  const projectB2 = await fx.createProject(B(), fx.users.bOwner.id, `F22B second project ${fx.tag}`);
  await assertRefusedWithoutChange("events", [
    ["viewer inserts", () => viewer.from("execution_task_events").insert(eventRow({ actor_user_id: fx.users.bViewer.id })).select("id")],
    ["pm inserts as the owner", () => pm.from("execution_task_events").insert(eventRow({ actor_user_id: fx.users.bOwner.id })).select("id")],
    ["pm inserts without an actor", () => pm.from("execution_task_events").insert(eventRow({ actor_user_id: null })).select("id")],
    ["pm inserts on A's task", () => pm.from("execution_task_events").insert(eventRow({ task_id: rows.A.task, project_id: fx.projects.A })).select("id")],
    ["pm inserts on A's task labelled as B's project", () => pm.from("execution_task_events").insert(eventRow({ task_id: rows.A.task })).select("id")],
    ["pm inserts with a project other than the task's", () => pm.from("execution_task_events").insert(eventRow({ project_id: projectB2 })).select("id")],
    ["A's owner inserts on B's task", () => aOwner.from("execution_task_events").insert(eventRow({ actor_user_id: fx.users.aOwner.id })).select("id")],
  ]);
  const ok = await pm.from("execution_task_events").insert(eventRow()).select("id");
  assert.equal(ok.data?.length, 1, ok.error?.message);
});

// ── recommended action decisions ────────────────────────────────────────────

test("recommended action decisions: only writers, as themselves, on this workspace's action", async () => {
  await assertRefusedWithoutChange("decision rows", [
    ["viewer inserts", () => viewer.from("recommended_action_decisions").insert(decisionRow({ decided_by: fx.users.bViewer.id })).select("id")],
    ["pm inserts as the owner", () => pm.from("recommended_action_decisions").insert(decisionRow({ decided_by: fx.users.bOwner.id })).select("id")],
    ["pm decides A's action", () => pm.from("recommended_action_decisions").insert(decisionRow({ recommended_action_id: rows.A.action })).select("id")],
    ["pm decides A's action as A's project", () => pm.from("recommended_action_decisions").insert(decisionRow({ recommended_action_id: rows.A.action, project_id: fx.projects.A })).select("id")],
  ]);
  const ok = await pm.from("recommended_action_decisions").insert(decisionRow()).select("id");
  assert.equal(ok.data?.length, 1, ok.error?.message);
});

// ── evidence storage paths ──────────────────────────────────────────────────

test("evidence: clients store only their own upload path and can never change it afterwards", async () => {
  const victimPath = `${fx.users.aOwner.id}/${fx.projects.A}/${hex(8)}-board.pdf`;
  const evidence = await seed("project_evidence", evidenceRow(), "pm evidence");
  await assertRefusedWithoutChange("evidence paths", [
    ["pm stores tenant A's object path", () => pm.from("project_evidence").insert(evidenceRow({ storage_path: victimPath })).select("id")],
    ["pm stores the owner's prefix", () => pm.from("project_evidence").insert(evidenceRow({ storage_path: `${fx.users.bOwner.id}/${fx.projects.B}/${hex(8)}-x.txt` })).select("id")],
    ["pm stores another project's prefix", () => pm.from("project_evidence").insert(evidenceRow({ storage_path: `${fx.users.bPm.id}/${fx.projects.A}/${hex(8)}-x.txt` })).select("id")],
    ["pm stores a traversal path", () => pm.from("project_evidence").insert(evidenceRow({ storage_path: `${fx.users.bPm.id}/${fx.projects.B}/../../${victimPath}` })).select("id")],
    ["pm stores a nested path", () => pm.from("project_evidence").insert(evidenceRow({ storage_path: `${fx.users.bPm.id}/${fx.projects.B}/a/b.txt` })).select("id")],
    ["pm uploads as the owner", () => pm.from("project_evidence").insert(evidenceRow({ uploaded_by: fx.users.bOwner.id, storage_path: `${fx.users.bOwner.id}/${fx.projects.B}/${hex(8)}-x.txt` })).select("id")],
    ["pm rewrites a stored path", () => pm.from("project_evidence").update({ storage_path: victimPath }).eq("id", evidence).select("id")],
    ["admin rewrites a stored path", () => admin.from("project_evidence").update({ storage_path: `${fx.users.bPm.id}/${fx.projects.B}/${hex(8)}-other.txt` }).eq("id", evidence).select("id")],
    ["admin re-attributes the uploader", () => admin.from("project_evidence").update({ uploaded_by: fx.users.bAdmin.id }).eq("id", evidence).select("id")],
  ]);
  const own = await pm.from("project_evidence").insert(evidenceRow()).select("id").single();
  assert.equal(own.error, null, own.error?.message);
  const status = await pm.from("project_evidence").update({ status: "processed" }).eq("id", own.data.id).select("id");
  assert.equal(status.data?.length, 1, status.error?.message);
});

// ── invitations ─────────────────────────────────────────────────────────────

// Already enforced by 20260820000000_workspace_invite_token_hashing.sql (column SELECT revoked);
// kept here so the residual-triage claim that members read token hashes stays disproved.
test("invitations: no client can read token hashes; members still see the pending-invite list", async () => {
  for (const [role, client] of [["viewer", viewer], ["pm", pm], ["admin", admin], ["owner", owner]]) {
    const hashes = await client.from("workspace_invitations").select("token_hash").eq("id", rows.B.invite);
    assert.ok(hashes.error, `${role} must not read token_hash (got ${JSON.stringify(hashes.data)})`);
    const star = await client.from("workspace_invitations").select("*").eq("id", rows.B.invite);
    assert.ok(star.error, `${role}: select * must not expose token_hash`);
  }
  const listed = await viewer.from("workspace_invitations").select("email, role, expires_at, status").eq("workspace_id", B());
  assert.equal(listed.error, null, listed.error?.message);
  assert.ok(listed.data.some((invite) => invite.status === "pending"), "the /team pending-invite list still works");
});

test("invitations: an account whose email is not confirmed cannot accept; once confirmed it can", async () => {
  const invitee = await fx.createUser("unconfirmed-invitee", { confirmed: false });
  const token = `f22b-unconfirmed-${hex(8)}`;
  const inviteId = await seed("workspace_invitations", { workspace_id: B(), company_id: fx.users.bOwner.id, email: invitee.email, role: "pm", status: "pending", invited_by_user_id: fx.users.bAdmin.id, token_hash: sha256(token), expires_at: inAWeek() }, "invite for unconfirmed account");

  const refused = await acceptWorkspaceInvite({ token, userId: invitee.id, userEmail: invitee.email }).then(() => null, (error) => error);
  assert.ok(refused instanceof WorkspaceInviteError, String(refused));
  assert.equal(refused.reason, "email_unverified");
  assert.equal((await fx.admin.from("workspace_memberships").select("role").eq("workspace_id", B()).eq("user_id", invitee.id)).data.length, 0);
  assert.equal((await fx.admin.from("workspace_invitations").select("status").eq("id", inviteId).single()).data.status, "pending", "invite not consumed");

  // A different, confirmed account cannot claim it by asserting the invitee's email either.
  const impostor = await fx.createUser("impostor");
  const claimed = await acceptWorkspaceInvite({ token, userId: impostor.id, userEmail: invitee.email }).then(() => null, (error) => error);
  assert.equal(claimed?.reason, "email_mismatch");

  await must(fx.admin.auth.admin.updateUserById(invitee.id, { email_confirm: true }), "confirm invitee");
  const accepted = await acceptWorkspaceInvite({ token, userId: invitee.id, userEmail: invitee.email });
  assert.equal(accepted.role, "pm");
  assert.equal((await fx.admin.from("workspace_memberships").select("role").eq("workspace_id", B()).eq("user_id", invitee.id).single()).data.role, "pm");
});

// ── governance reports ──────────────────────────────────────────────────────

test("governance violations and commitments: viewers cannot fabricate or erase report inputs", async () => {
  const violation = { workspace_id: B(), violation_type: "unauthorized_approval", action_type: "approve", action_entity_type: "project", action_entity_id: fx.projects.B, actor_id: fx.users.bPm.id };
  const commitment = { workspace_id: B(), action_id: rows.B.govAction, commitment_title: "fabricated", commitment_description: "x", owner_id: fx.users.bPm.id, owner_type: "pm", priority: "high", due_date: inAWeek() };
  await assertRefusedWithoutChange("governance", [
    ["viewer records a violation against the pm", () => viewer.from("governance_violations").insert(violation).select("id")],
    ["viewer resolves a violation", () => viewer.from("governance_violations").update({ status: "resolved" }).eq("id", rows.B.violation).select("id")],
    ["viewer creates a commitment", () => viewer.from("governance_commitments").insert(commitment).select("id")],
    ["viewer breaches a commitment", () => viewer.from("governance_commitments").update({ status: "breached" }).eq("id", rows.B.commitment).select("id")],
    ["viewer deletes a commitment", () => viewer.from("governance_commitments").delete().eq("id", rows.B.commitment).select("id")],
    ["pm deletes a commitment", () => pm.from("governance_commitments").delete().eq("id", rows.B.commitment).select("id")],
    ["pm commits to A's governance action", () => pm.from("governance_commitments").insert({ ...commitment, action_id: rows.A.govAction }).select("id")],
    ["pm re-points a commitment to A's action", () => pm.from("governance_commitments").update({ action_id: rows.A.govAction }).eq("id", rows.B.commitment).select("id")],
    ["A's owner records a violation in B", () => aOwner.from("governance_violations").insert(violation).select("id")],
  ]);
  const readable = await viewer.from("governance_commitments").select("id").eq("id", rows.B.commitment);
  assert.equal(readable.data?.length, 1, "members still read commitments");
  const created = await pm.from("governance_commitments").insert(commitment).select("id").single();
  assert.equal(created.error, null, created.error?.message);
  const recorded = await pm.from("governance_violations").insert(violation).select("id");
  assert.equal(recorded.data?.length, 1, recorded.error?.message);
  const removed = await admin.from("governance_commitments").delete().eq("id", created.data.id).select("id");
  assert.equal(removed.data?.length, 1, removed.error?.message);
});

// ── copilot conversation state ──────────────────────────────────────────────

test("copilot state: a member reads and writes only their own conversation state", async () => {
  const stateRow = (companyId, overrides = {}) => ({ company_id: companyId, workspace_id: B(), session_key: "default", expires_at: inAWeek(), recent_questions: ["planted"], ...overrides });
  const peek = await pm.from("runtime_conversation_state").select("recent_questions").eq("id", rows.B.viewerState);
  assert.deepEqual(peek.data, [], "pm cannot read the viewer's copilot state");
  await assertRefusedWithoutChange("copilot state", [
    ["pm overwrites the viewer's state", () => pm.from("runtime_conversation_state").update({ recent_blockers: ["poisoned"] }).eq("id", rows.B.viewerState).select("id")],
    ["pm inserts state as the owner", () => pm.from("runtime_conversation_state").insert(stateRow(fx.users.bOwner.id, { session_key: `s-${hex()}` })).select("id")],
    ["viewer references A's project", () => viewer.from("runtime_conversation_state").insert(stateRow(fx.users.bViewer.id, { project_id: fx.projects.A, session_key: `s-${hex()}` })).select("id")],
  ]);
  const own = await viewer.from("runtime_conversation_state").update({ message_count: 3 }).eq("id", rows.B.viewerState).select("id");
  assert.equal(own.data?.length, 1, `the viewer keeps their own copilot state: ${own.error?.message}`);
  const pmOwn = await pm.from("runtime_conversation_state").insert(stateRow(fx.users.bPm.id, { project_id: fx.projects.B })).select("id");
  assert.equal(pmOwn.data?.length, 1, pmOwn.error?.message);
});
