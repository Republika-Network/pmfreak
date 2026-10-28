/**
 * F22-A — remediated by 20261025000000_f22a_tenant_isolation_and_escalation.sql together with
 * discovery-repository.ts (workspace from `projects`) and workspace-team.ts (acceptance
 * re-validation). Each case was first reproduced live against the pre-fix stack.
 *
 * R1  A member of tenant B (a viewer was enough) inserted backdated project_evidence /
 *     project_evidence_content rows with workspace_id = B and project_id = <tenant A's project>.
 *     Discovery regeneration (privileged) loaded evidence by project_id only and took
 *     workspace_id from the oldest row, so A's discovery, RAID items and discovery source
 *     document were written into B, readable by B's viewer, and A lost its discovery.
 * R2  workspace_invitations allowed owner/admin to write any row, including role 'owner' and
 *     a token of their choice; acceptance granted the stored role and upserted the membership,
 *     so an admin could invite their own email as owner and upgrade themselves.
 * R3  project_decisions: a member-wide UPDATE policy voided the owner/admin/pm approver policy;
 *     a viewer approved decisions and named any user as approver.
 *
 * Every request is a real authenticated PostgREST call or the real application function, and
 * every refusal is compared with a snapshot of the affected tables in both tenants.
 */
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { bindAppEnvToHarness, createTenantFixtures, requireHarnessEnv } from "./support/harness.mjs";

const env = requireHarnessEnv();
bindAppEnvToHarness(env);

const { regenerateProjectDiscovery } = await import("../../src/lib/project-discovery/discovery-repository.ts");
const { acceptWorkspaceInvite, createWorkspaceInvitationRecord, WorkspaceInviteError } = await import("../../src/lib/workspace-team.ts");

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const hex64 = () => randomBytes(32).toString("hex");
const inAWeek = () => new Date(Date.now() + 7 * 864e5).toISOString();

let fx;
let viewer;
let pm;
let admin;
let owner;
let aOwner;
const rows = {};

const must = async (promise, what) => {
  const { data, error } = await promise;
  if (error) throw new Error(`[security-regression] fixture step failed (${what}): ${error.message}`);
  return data;
};
const seed = async (table, row, what) => (await must(fx.admin.from(table).insert(row).select("id").single(), what)).id;

const VICTIM_TEXT = [
  "Stakeholder: Dana Victim, CFO and executive sponsor for the migration.",
  "Risk: the acquisition of Northwind may be blocked by the regulator before the board meeting.",
  "Dependency: the vendor contract renewal must close in March.",
  "Milestone: board approval on 2026-12-01.",
].join("\n");

const evidenceRow = (workspaceId, projectId, name) => ({ workspace_id: workspaceId, project_id: projectId, file_name: name, file_type: "TXT", storage_path: `${workspaceId}/${projectId}/${name}-${randomBytes(6).toString("hex")}`, status: "processed" });
const contentRow = (evidenceId, workspaceId, projectId, text, extra = {}) => ({
  evidence_id: evidenceId,
  workspace_id: workspaceId,
  project_id: projectId,
  source_file_name: "harness.txt",
  source_file_type: "TXT",
  source_uploaded_at: new Date().toISOString(),
  extracted_text: text,
  content_hash: hex64(),
  extraction_method: "plain_text",
  processing_started_at: new Date().toISOString(),
  processing_completed_at: new Date().toISOString(),
  ...extra,
});

before(async () => {
  fx = await createTenantFixtures(env, { label: "f22a" });
  const { A, B } = fx.workspaces;
  for (const [key, workspaceId, projectId, text] of [["A", A, fx.projects.A, VICTIM_TEXT], ["B", B, fx.projects.B, "Risk: harness tenant B evidence."]]) {
    const evidence = await seed("project_evidence", evidenceRow(workspaceId, projectId, `evidence-${key}`), `evidence ${key}`);
    const content = await seed("project_evidence_content", contentRow(evidence, workspaceId, projectId, text), `content ${key}`);
    rows[key] = { workspaceId, projectId, evidence, content };
  }
  viewer = await fx.signIn(fx.users.bViewer);
  pm = await fx.signIn(fx.users.bPm);
  admin = await fx.signIn(fx.users.bAdmin);
  owner = await fx.signIn(fx.users.bOwner);
  aOwner = await fx.signIn(fx.users.aOwner);
});

after(async () => {
  if (!fx) return;
  // Discovery materialization output that does not cascade cleanly from the workspace delete.
  for (const table of ["recommended_actions", "raid_items"]) {
    await fx.admin.from(table).delete().in("workspace_id", [fx.workspaces.A, fx.workspaces.B]);
  }
  await fx.teardown();
});

const rejectedOrNoRows = (result) => result.error !== null || (Array.isArray(result.data) && result.data.length === 0);

const SNAPSHOT_TABLES = ["project_evidence", "project_evidence_content", "project_discovery", "raid_items", "vault_documents", "recommended_actions", "workspace_invitations", "workspace_memberships", "project_decisions"];
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

// ── R1 ──────────────────────────────────────────────────────────────────────

test("R1: no member of tenant B — viewer, pm, admin or owner — can plant evidence or discovery against tenant A's project", async () => {
  const { A, B } = fx.workspaces;
  for (const [role, client] of [["viewer", viewer], ["pm", pm], ["admin", admin], ["owner", owner]]) {
    await assertRefusedWithoutChange(`B ${role}`, [
      ["project_evidence (ws B, project A)", () => client.from("project_evidence").insert(evidenceRow(B, fx.projects.A, "planted")).select("id")],
      ["project_evidence_content (ws B, project A), backdated", () => client.from("project_evidence_content").insert(contentRow(rows.B.evidence, B, fx.projects.A, "Note.", { created_at: "2000-01-01T00:00:00Z" })).select("id")],
      ["project_evidence_content citing A's evidence", () => client.from("project_evidence_content").insert(contentRow(rows.A.evidence, B, fx.projects.B, "Note.")).select("id")],
      ["project_discovery (ws B, project A)", () => client.from("project_discovery").insert({ workspace_id: B, project_id: fx.projects.A, version: 99 }).select("id")],
      ["re-point B evidence to A's project", () => client.from("project_evidence").update({ project_id: fx.projects.A }).eq("id", rows.B.evidence).select("id")],
      ["re-point B content to A's project", () => client.from("project_evidence_content").update({ project_id: fx.projects.A, created_at: "2000-01-01T00:00:00Z" }).eq("id", rows.B.content).select("id")],
      ["write into A directly", () => client.from("project_evidence").insert(evidenceRow(A, fx.projects.A, "direct")).select("id")],
    ]);
  }
});

test("R1: the mismatch cannot be stored even by a privileged writer (composite foreign keys)", async () => {
  const { B } = fx.workspaces;
  await assertRefusedWithoutChange("service role", [
    ["project_evidence (ws B, project A)", () => fx.admin.from("project_evidence").insert(evidenceRow(B, fx.projects.A, "privileged")).select("id")],
    ["project_evidence_content (ws B, project A)", () => fx.admin.from("project_evidence_content").insert(contentRow(rows.B.evidence, B, fx.projects.A, "Note.")).select("id")],
    ["project_evidence_content citing A's evidence", () => fx.admin.from("project_evidence_content").insert(contentRow(rows.A.evidence, B, fx.projects.B, "Note.")).select("id")],
    ["project_discovery (ws B, project A)", () => fx.admin.from("project_discovery").insert({ workspace_id: B, project_id: fx.projects.A, version: 99 }).select("id")],
  ]);
});

test("R1: a viewer cannot write evidence or discovery in its own workspace", async () => {
  const { B } = fx.workspaces;
  await assertRefusedWithoutChange("B viewer", [
    ["insert evidence", () => viewer.from("project_evidence").insert(evidenceRow(B, fx.projects.B, "viewer")).select("id")],
    ["rewrite storage_path", () => viewer.from("project_evidence").update({ storage_path: `${fx.workspaces.A}/secret.pdf` }).eq("id", rows.B.evidence).select("id")],
    ["delete evidence", () => viewer.from("project_evidence").delete().eq("id", rows.B.evidence).select("id")],
    ["insert content", () => viewer.from("project_evidence_content").insert(contentRow(rows.B.evidence, B, fx.projects.B, "viewer")).select("id")],
    ["rewrite content", () => viewer.from("project_evidence_content").update({ extracted_text: "viewer edit" }).eq("id", rows.B.content).select("id")],
    ["insert discovery", () => viewer.from("project_discovery").insert({ workspace_id: B, project_id: fx.projects.B, version: 99 }).select("id")],
  ]);
});

test("R1: tenant A's discovery is written only into A, never into B, and B's viewer reads none of it", async () => {
  const { A, B } = fx.workspaces;
  // The pre-fix attack: B's viewer plants a backdated row. Refused now; if it is ever accepted
  // again, discovery must still resolve A's workspace from `projects` and ignore it.
  const plantedEvidence = await viewer.from("project_evidence").insert(evidenceRow(B, fx.projects.A, "x")).select("id").maybeSingle();
  await viewer.from("project_evidence_content").insert(contentRow(plantedEvidence.data?.id ?? rows.B.evidence, B, fx.projects.A, "Note.", { created_at: "2000-01-01T00:00:00Z" })).select("id");

  const discovery = await regenerateProjectDiscovery({ projectId: fx.projects.A, requestId: "f22a-r1" });
  assert.ok(discovery, "authorized discovery for A still runs");
  assert.equal(discovery.workspace_id, A, "discovery belongs to A's workspace");

  for (const table of ["project_discovery", "raid_items", "vault_documents", "recommended_actions"]) {
    const { data: leaked } = await fx.admin.from(table).select("id").eq("workspace_id", B).eq("project_id", fx.projects.A);
    assert.deepEqual(leaked, [], `${table}: nothing for A's project may be written into B`);
    const { data: visible } = await viewer.from(table).select("id").eq("project_id", fx.projects.A);
    assert.deepEqual(visible, [], `${table}: B's viewer reads nothing of A's project`);
  }
  const { data: aDiscovery } = await fx.admin.from("project_discovery").select("workspace_id").eq("project_id", fx.projects.A);
  assert.ok(aDiscovery.length >= 1 && aDiscovery.every((row) => row.workspace_id === A), "A keeps its discovery");
  const { data: aRaid } = await aOwner.from("raid_items").select("title").eq("project_id", fx.projects.A);
  assert.ok(aRaid.some((row) => /Northwind/.test(row.title)), "A's own RAID items were materialized from A's evidence");
});

test("R1: authorized writers keep the evidence workflow (pm insert/update/delete in their own project)", async () => {
  const { B } = fx.workspaces;
  // Upload paths live under the uploader's own prefix (<user id>/<project id>/<file>, F22-B).
  const created = await pm.from("project_evidence").insert({ ...evidenceRow(B, fx.projects.B, "pm"), storage_path: `${fx.users.bPm.id}/${fx.projects.B}/pm-${randomBytes(6).toString("hex")}.txt`, uploaded_by: fx.users.bPm.id, status: "processing" }).select("id").single();
  assert.equal(created.error, null, created.error?.message);
  const content = await pm.from("project_evidence_content").insert(contentRow(created.data.id, B, fx.projects.B, "Risk: pm evidence.")).select("id").single();
  assert.equal(content.error, null, content.error?.message);
  const updated = await pm.from("project_evidence").update({ status: "processed" }).eq("id", created.data.id).select("id");
  assert.equal(updated.data?.length, 1, updated.error?.message);
  const removed = await pm.from("project_evidence").delete().eq("id", created.data.id).select("id");
  assert.equal(removed.data?.length, 1, removed.error?.message);
});

// ── R2 ──────────────────────────────────────────────────────────────────────

const inviteRow = (overrides = {}) => ({
  workspace_id: fx.workspaces.B,
  company_id: fx.users.bOwner.id,
  email: `sec-invitee-${randomBytes(4).toString("hex")}-${fx.tag}@example.test`,
  role: "viewer",
  status: "pending",
  invited_by_user_id: fx.users.bAdmin.id,
  token_hash: sha256(`attacker-chosen-${randomBytes(4).toString("hex")}`),
  expires_at: inAWeek(),
  ...overrides,
});

const memberRole = async (workspaceId, userId) =>
  (await must(fx.admin.from("workspace_memberships").select("role").eq("workspace_id", workspaceId).eq("user_id", userId).maybeSingle(), "membership role"))?.role ?? null;

const acceptAs = async (user, token) => {
  try {
    return { ok: true, result: await acceptWorkspaceInvite({ token, userId: user.id, userEmail: user.email }) };
  } catch (error) {
    return { ok: false, error };
  }
};

test("R2: an admin cannot create, or turn an invitation into, an owner invitation through PostgREST", async () => {
  const pending = await seed("workspace_invitations", inviteRow({ role: "viewer" }), "pending viewer invite");
  const revokedInvite = await seed("workspace_invitations", inviteRow({ role: "viewer", status: "revoked", revoked_at: new Date().toISOString() }), "revoked invite");
  await assertRefusedWithoutChange("B admin", [
    ["insert owner invitation", () => admin.from("workspace_invitations").insert(inviteRow({ role: "owner" })).select("id")],
    ["insert owner invitation to self", () => admin.from("workspace_invitations").insert(inviteRow({ role: "owner", email: fx.users.bAdmin.email })).select("id")],
    ["edit pending invite to owner", () => admin.from("workspace_invitations").update({ role: "owner" }).eq("id", pending).select("id")],
    ["re-target pending invite to self", () => admin.from("workspace_invitations").update({ email: fx.users.bAdmin.email }).eq("id", pending).select("id")],
    ["swap the token", () => admin.from("workspace_invitations").update({ token_hash: sha256("mine") }).eq("id", pending).select("id")],
    ["issue in the owner's name", () => admin.from("workspace_invitations").insert(inviteRow({ invited_by_user_id: fx.users.bOwner.id })).select("id")],
    ["issue pre-accepted", () => admin.from("workspace_invitations").insert(inviteRow({ status: "accepted", accepted_by_user_id: fx.users.bAdmin.id })).select("id")],
    ["reopen a revoked invite", () => admin.from("workspace_invitations").update({ status: "pending" }).eq("id", revokedInvite).select("id")],
    ["mark an invite accepted", () => admin.from("workspace_invitations").update({ status: "accepted", accepted_by_user_id: fx.users.bAdmin.id }).eq("id", pending).select("id")],
  ]);
  await assertRefusedWithoutChange("B owner", [
    ["insert owner invitation", () => owner.from("workspace_invitations").insert(inviteRow({ role: "owner", invited_by_user_id: fx.users.bOwner.id })).select("id")],
  ]);
  await assertRefusedWithoutChange("B pm / viewer", [
    ["pm issues", () => pm.from("workspace_invitations").insert(inviteRow({ invited_by_user_id: fx.users.bPm.id })).select("id")],
    ["viewer issues", () => viewer.from("workspace_invitations").insert(inviteRow({ invited_by_user_id: fx.users.bViewer.id })).select("id")],
  ]);
  await assertRefusedWithoutChange("service role", [
    ["insert owner invitation", () => fx.admin.from("workspace_invitations").insert(inviteRow({ role: "owner" })).select("id")],
  ]);
});

test("R2: an admin cannot promote themselves to owner (or anything) by accepting their own invitation", async () => {
  const token = `f22a-self-${randomBytes(8).toString("hex")}`;
  const issued = await admin.from("workspace_invitations").insert(inviteRow({ role: "admin", email: fx.users.bAdmin.email, token_hash: sha256(token) })).select("id").single();
  assert.equal(issued.error, null, "an admin may still issue an admin invitation");
  const before = await state();
  const outcome = await acceptAs(fx.users.bAdmin, token);
  assert.equal(outcome.ok, false);
  assert.ok(outcome.error instanceof WorkspaceInviteError);
  assert.equal(outcome.error.reason, "already_member");
  assert.deepEqual(await state(), before, "refused acceptance leaves memberships and the invite unchanged");
  assert.equal(await memberRole(fx.workspaces.B, fx.users.bAdmin.id), "admin");
});

test("R2: accepting an invitation never upgrades an existing membership", async () => {
  const token = `f22a-upgrade-${randomBytes(8).toString("hex")}`;
  await seed("workspace_invitations", inviteRow({ role: "admin", email: fx.users.bViewer.email, token_hash: sha256(token) }), "admin invite for the viewer");
  const before = await state();
  const outcome = await acceptAs(fx.users.bViewer, token);
  assert.equal(outcome.ok, false);
  assert.equal(outcome.error.reason, "already_member");
  assert.deepEqual(await state(), before);
  assert.equal(await memberRole(fx.workspaces.B, fx.users.bViewer.id), "viewer");
});

test("R2: acceptance re-validates the inviter — a demoted inviter's invitation is void", async () => {
  const invitee = await fx.createUser("invitee-demoted");
  const demoted = await fx.createUser("demoted-admin");
  await must(fx.admin.from("workspace_memberships").insert({ workspace_id: fx.workspaces.B, user_id: demoted.id, role: "admin" }), "temporary admin");
  const token = `f22a-demoted-${randomBytes(8).toString("hex")}`;
  await seed("workspace_invitations", inviteRow({ role: "admin", email: invitee.email, invited_by_user_id: demoted.id, token_hash: sha256(token) }), "invite by temporary admin");
  await must(fx.admin.from("workspace_memberships").update({ role: "viewer" }).eq("workspace_id", fx.workspaces.B).eq("user_id", demoted.id), "demote");
  const before = await state();
  const outcome = await acceptAs(invitee, token);
  assert.equal(outcome.ok, false);
  assert.equal(outcome.error.reason, "inviter_not_authorized");
  assert.deepEqual(await state(), before);
  assert.equal(await memberRole(fx.workspaces.B, invitee.id), null);
});

test("R2: legitimate admin and owner invitations still work end to end, and admins can still revoke", async () => {
  const pmInvitee = await fx.createUser("invitee-pm");
  const viewerInvitee = await fx.createUser("invitee-viewer");
  const adminInvitee = await fx.createUser("invitee-admin");
  const issue = (client, inviter, actorRole, email, role) =>
    createWorkspaceInvitationRecord(
      { workspaceId: fx.workspaces.B, companyId: fx.users.bOwner.id, inviterUserId: inviter.id, actorRole, email, role },
      async () => client,
    );
  const tokenOf = (acceptPath) => decodeURIComponent(acceptPath.split("/").pop());

  const forPm = await issue(admin, fx.users.bAdmin, "admin", pmInvitee.email, "pm");
  const forViewer = await issue(owner, fx.users.bOwner, "owner", viewerInvitee.email, "viewer");
  const forAdmin = await issue(owner, fx.users.bOwner, "owner", adminInvitee.email, "admin");
  for (const [user, issued, role] of [[pmInvitee, forPm, "pm"], [viewerInvitee, forViewer, "viewer"], [adminInvitee, forAdmin, "admin"]]) {
    const outcome = await acceptAs(user, tokenOf(issued.acceptPath));
    assert.equal(outcome.ok, true, outcome.error?.message);
    assert.equal(outcome.result.role, role);
    assert.equal(await memberRole(fx.workspaces.B, user.id), role);
  }

  const revocable = await seed("workspace_invitations", inviteRow({ role: "pm" }), "revocable invite");
  const revoked = await admin.from("workspace_invitations").update({ status: "revoked", revoked_at: new Date().toISOString() }).eq("id", revocable).select("id,status");
  assert.equal(revoked.data?.[0]?.status, "revoked", revoked.error?.message);
});

// ── R3 ──────────────────────────────────────────────────────────────────────

const decisionRow = (overrides = {}) => ({
  workspace_id: fx.workspaces.B,
  project_id: fx.projects.B,
  decision_type: "scope_change",
  decision_status: "draft",
  title: `Harness decision ${randomBytes(3).toString("hex")}`,
  summary: "harness",
  created_by: fx.users.bPm.id,
  ...overrides,
});
const now = () => new Date().toISOString();

test("R3: a viewer cannot create, submit, approve or attribute project decisions", async () => {
  const pendingId = await seed("project_decisions", decisionRow({ decision_status: "pending_review" }), "pending decision");
  await assertRefusedWithoutChange("B viewer", [
    ["approve with forged approver", () => viewer.from("project_decisions").update({ decision_status: "approved", approved_by: fx.users.bOwner.id, approved_at: now() }).eq("id", pendingId).select("id")],
    ["approve as self", () => viewer.from("project_decisions").update({ decision_status: "approved", approved_by: fx.users.bViewer.id, approved_at: now() }).eq("id", pendingId).select("id")],
    ["reject", () => viewer.from("project_decisions").update({ decision_status: "rejected", rejected_by: fx.users.bViewer.id, rejected_at: now() }).eq("id", pendingId).select("id")],
    ["edit text", () => viewer.from("project_decisions").update({ summary: "viewer" }).eq("id", pendingId).select("id")],
    ["insert pre-approved in the owner's name", () => viewer.from("project_decisions").insert(decisionRow({ decision_status: "approved", created_by: fx.users.bOwner.id, approved_by: fx.users.bOwner.id })).select("id")],
    ["insert draft as self", () => viewer.from("project_decisions").insert(decisionRow({ created_by: fx.users.bViewer.id })).select("id")],
  ]);
});

test("R3: writers act only as themselves — no impersonated creator, approver, rejecter or implementer", async () => {
  const pendingId = await seed("project_decisions", decisionRow({ decision_status: "pending_review" }), "pending decision");
  const approvedId = await seed("project_decisions", decisionRow({ decision_status: "approved", approved_by: fx.users.bOwner.id, approved_at: now() }), "approved decision");
  const draftId = await seed("project_decisions", decisionRow(), "draft decision");
  await assertRefusedWithoutChange("B pm / admin", [
    ["pm creates in the owner's name", () => pm.from("project_decisions").insert(decisionRow({ created_by: fx.users.bOwner.id })).select("id")],
    ["pm creates already approved", () => pm.from("project_decisions").insert(decisionRow({ decision_status: "approved", approved_by: fx.users.bPm.id, approved_at: now() })).select("id")],
    ["pm approves naming the owner", () => pm.from("project_decisions").update({ decision_status: "approved", approved_by: fx.users.bOwner.id, approved_at: now() }).eq("id", pendingId).select("id")],
    ["pm approves without an approver", () => pm.from("project_decisions").update({ decision_status: "approved" }).eq("id", pendingId).select("id")],
    ["admin rejects naming the pm", () => admin.from("project_decisions").update({ decision_status: "rejected", rejected_by: fx.users.bPm.id, rejected_at: now() }).eq("id", pendingId).select("id")],
    ["admin re-attributes an approval to self", () => admin.from("project_decisions").update({ approved_by: fx.users.bAdmin.id }).eq("id", approvedId).select("id")],
    ["admin clears an approval", () => admin.from("project_decisions").update({ approved_by: null, approved_at: null }).eq("id", approvedId).select("id")],
    ["pm implements naming the owner", () => pm.from("project_decisions").update({ decision_status: "implemented", implemented_by: fx.users.bOwner.id, implemented_at: now() }).eq("id", approvedId).select("id")],
    ["pm skips review (draft → approved)", () => pm.from("project_decisions").update({ decision_status: "approved", approved_by: fx.users.bPm.id, approved_at: now() }).eq("id", draftId).select("id")],
    ["pm reassigns the creator", () => pm.from("project_decisions").update({ created_by: fx.users.bAdmin.id }).eq("id", draftId).select("id")],
    ["pm moves the decision to A's project", () => pm.from("project_decisions").update({ workspace_id: fx.workspaces.A, project_id: fx.projects.A }).eq("id", draftId).select("id")],
  ]);
});

test("R3: the decision lifecycle still works for writers acting as themselves", async () => {
  const created = await pm.from("project_decisions").insert(decisionRow()).select("id,decision_status,created_by").single();
  assert.equal(created.error, null, created.error?.message);
  assert.equal(created.data.created_by, fx.users.bPm.id);
  const id = created.data.id;
  const step = async (client, patch, expected) => {
    const result = await client.from("project_decisions").update(patch).eq("id", id).select("decision_status").single();
    assert.equal(result.error, null, `${expected}: ${result.error?.message}`);
    assert.equal(result.data.decision_status, expected);
  };
  await step(pm, { summary: "pm edits the draft" }, "draft");
  await step(pm, { decision_status: "pending_review" }, "pending_review");
  await step(admin, { decision_status: "approved", approved_by: fx.users.bAdmin.id, approved_at: now(), decision_rationale: "ok" }, "approved");
  await step(pm, { decision_status: "implemented", implemented_by: fx.users.bPm.id, implemented_at: now(), closed_at: now(), implementation_notes: "done" }, "implemented");

  const toReject = await seed("project_decisions", decisionRow({ decision_status: "pending_review" }), "decision to reject");
  const rejected = await owner.from("project_decisions").update({ decision_status: "rejected", rejected_by: fx.users.bOwner.id, rejected_at: now(), closed_at: now() }).eq("id", toReject).select("decision_status,rejected_by").single();
  assert.equal(rejected.error, null, rejected.error?.message);
  assert.equal(rejected.data.rejected_by, fx.users.bOwner.id);
});
