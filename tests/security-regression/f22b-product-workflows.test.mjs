/**
 * F22-B product compatibility — the real routes behind the hardened tables, under real sessions:
 * vault intake, task draft materialization / status / conversion (which writes the draft, the
 * decision audit row and the task-created event), recommended-action decisions, and evidence
 * deletion with the storage-path check (including an unverifiable legacy path).
 */
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { bindAppEnvToHarness, createTenantFixtures, requireHarnessEnv } from "./support/harness.mjs";
import { actAs, installAppRouteMocks } from "./support/app-route-mocks.mjs";

const env = requireHarnessEnv();
bindAppEnvToHarness(env);
installAppRouteMocks();

const { POST: vaultIntakePost } = await import("../../src/app/api/vault/intake/route.ts");
const { POST: draftFromActionPost } = await import("../../src/app/api/task-drafts/from-recommended-action/route.ts");
const { POST: draftStatusPost } = await import("../../src/app/api/task-drafts/status/route.ts");
const { POST: convertPost } = await import("../../src/app/api/execution-tasks/convert/route.ts");
const { POST: decisionPost } = await import("../../src/app/api/recommended-actions/decision/route.ts");
const { POST: uploadPost } = await import("../../src/app/api/upload/route.ts");
const { DELETE: evidenceDelete } = await import("../../src/app/api/project-evidence/route.ts");

const BUCKET = "pmfreak-documents";
let fx;
const sessions = {};
const plantedObjects = [];

const must = async (promise, what) => {
  const { data, error } = await promise;
  if (error) throw new Error(`[f22b-product] ${what}: ${error.message}`);
  return data;
};
const json = (path, body, method = "POST") => new Request(`http://localhost${path}`, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const countWhere = async (table, filters) => {
  let query = fx.admin.from(table).select("id", { count: "exact", head: true });
  for (const [column, value] of Object.entries(filters)) query = query.eq(column, value);
  const { count, error } = await query;
  if (error) throw new Error(`[f22b-product] count ${table}: ${error.message}`);
  return count;
};
const newAction = async (label) =>
  (await must(fx.admin.from("recommended_actions").insert({ workspace_id: fx.workspaces.B, project_id: fx.projects.B, title: `Escalate ${label}`, description: "The vendor API delivery is at risk.", recommended_action_type: "escalate_issue", fingerprint: `f22b-prod-${label}-${fx.tag}` }).select("id").single(), `action ${label}`)).id;

before(async () => {
  fx = await createTenantFixtures(env, { label: "f22bprod" });
  for (const [key, user] of Object.entries({ owner: fx.users.bOwner, admin: fx.users.bAdmin, pm: fx.users.bPm, viewer: fx.users.bViewer, aOwner: fx.users.aOwner })) {
    sessions[key] = await fx.signIn(user);
  }
});

after(async () => {
  if (!fx) return;
  const workspaces = [fx.workspaces.A, fx.workspaces.B];
  const { data: leftovers } = await fx.admin.from("project_evidence").select("storage_path").in("workspace_id", workspaces);
  const paths = [...plantedObjects, ...(leftovers ?? []).map((row) => row.storage_path)].filter(Boolean);
  if (paths.length) await fx.admin.storage.from(BUCKET).remove(paths);
  for (const table of ["execution_task_events", "recommended_actions", "raid_items"]) await fx.admin.from(table).delete().in("workspace_id", workspaces);
  await fx.teardown();
});

test("vault intake: owner, admin and pm ingest; a viewer and another tenant's owner are refused and store nothing", async () => {
  const content = "Risk: the vendor may miss the API delivery date.\nIssue: production access is still blocked.";
  for (const role of ["pm", "admin", "owner"]) {
    actAs(sessions[role]);
    const response = await vaultIntakePost(json("/api/vault/intake", { workspaceId: fx.workspaces.B, projectId: fx.projects.B, rawContent: `${content}\nAssumption: ${role}`, title: `${role} intake ${fx.tag}` }));
    assert.ok(response.status < 300, `${role}: ${await response.clone().text()}`);
    const userId = fx.users[{ pm: "bPm", admin: "bAdmin", owner: "bOwner" }[role]].id;
    assert.ok((await countWhere("vault_documents", { workspace_id: fx.workspaces.B, created_by: userId })) >= 1, `${role}: document stored`);
  }
  const signals = await countWhere("vault_operational_signals", { workspace_id: fx.workspaces.B });
  assert.ok(signals >= 1, "signals stored through the user client");

  for (const [who, workspaceId, userId] of [["viewer", fx.workspaces.B, fx.users.bViewer.id], ["aOwner", fx.workspaces.B, fx.users.aOwner.id]]) {
    const documentsBefore = await countWhere("vault_documents", { workspace_id: fx.workspaces.B });
    actAs(sessions[who]);
    const response = await vaultIntakePost(json("/api/vault/intake", { workspaceId, rawContent: `${content}\nAssumption: ${who}`, title: `${who} intake` }));
    assert.equal(response.status, 403, `${who}: ${await response.clone().text()}`);
    assert.equal(await countWhere("vault_documents", { workspace_id: fx.workspaces.B, created_by: userId }), 0, `${who}: nothing stored`);
    assert.equal(await countWhere("vault_documents", { workspace_id: fx.workspaces.B }), documentsBefore);
  }
});

test("task drafts: pm materializes, reviews, approves and converts a draft (draft, decision row, task-created event as the pm); a viewer cannot change it", async () => {
  const actionId = await newAction("draft");
  actAs(sessions.pm);
  const materialized = await draftFromActionPost(json("/api/task-drafts/from-recommended-action", { recommendedActionId: actionId }));
  const materializedBody = await materialized.json();
  assert.ok(materialized.status < 300, JSON.stringify(materializedBody));
  const draftId = materializedBody.draft?.id ?? materializedBody.taskDraft?.id;
  assert.ok(draftId, JSON.stringify(materializedBody));
  const { data: draft } = await fx.admin.from("task_drafts").select("created_by,workspace_id,draft_status").eq("id", draftId).single();
  assert.equal(draft.created_by, fx.users.bPm.id);
  const { data: decisionRows } = await fx.admin.from("recommended_action_decisions").select("decided_by").eq("recommended_action_id", actionId);
  assert.ok(decisionRows.every((row) => row.decided_by === fx.users.bPm.id), "decision audit rows are the pm's own");

  actAs(sessions.viewer);
  const refused = await draftStatusPost(json("/api/task-drafts/status", { draftId, status: "approved" }));
  assert.equal(refused.status, 403, await refused.clone().text());
  assert.equal((await fx.admin.from("task_drafts").select("draft_status").eq("id", draftId).single()).data.draft_status, draft.draft_status, "viewer changed nothing");

  actAs(sessions.pm);
  const reviewed = await draftStatusPost(json("/api/task-drafts/status", { draftId, status: "reviewed" }));
  assert.equal(reviewed.status, 200, await reviewed.clone().text());
  // Conversion requires an approved draft (convert-task-draft.ts).
  const approved = await draftStatusPost(json("/api/task-drafts/status", { draftId, status: "approved" }));
  assert.equal(approved.status, 200, await approved.clone().text());

  const converted = await convertPost(json("/api/execution-tasks/convert", { taskDraftId: draftId }));
  const convertedBody = await converted.json();
  assert.equal(converted.status, 201, JSON.stringify(convertedBody));
  const { data: events } = await fx.admin.from("execution_task_events").select("actor_user_id,event_type,workspace_id,project_id").eq("task_id", convertedBody.task.id);
  assert.ok(events.length >= 1, "task-created event written");
  assert.ok(events.every((event) => event.actor_user_id === fx.users.bPm.id && event.workspace_id === fx.workspaces.B && event.project_id === fx.projects.B));
});

test("recommended-action decisions: pm decides (audit row as the pm); a viewer is refused and writes nothing", async () => {
  const actionId = await newAction("decision");
  actAs(sessions.viewer);
  const refused = await decisionPost(json("/api/recommended-actions/decision", { actionId, decision: "accepted", reason: "viewer" }));
  assert.equal(refused.status, 403, await refused.clone().text());
  assert.equal(await countWhere("recommended_action_decisions", { recommended_action_id: actionId }), 0);

  actAs(sessions.pm);
  const accepted = await decisionPost(json("/api/recommended-actions/decision", { actionId, decision: "accepted", reason: "pm" }));
  assert.ok(accepted.status < 300, await accepted.clone().text());
  const { data: rowsAfter } = await fx.admin.from("recommended_action_decisions").select("decided_by,new_status").eq("recommended_action_id", actionId);
  assert.deepEqual(rowsAfter, [{ decided_by: fx.users.bPm.id, new_status: "accepted" }]);
});

test("evidence deletion removes a verified upload's object, and never a foreign object behind an unverifiable path", async () => {
  // A real pm upload, deleted by an admin: the uploader-prefixed path is verified and removed.
  actAs(sessions.pm);
  const form = new FormData();
  form.set("projectId", fx.projects.B);
  form.append("documents", new File(["Risk: vendor delay."], `notes-${randomBytes(3).toString("hex")}.txt`, { type: "text/plain" }));
  const uploaded = await uploadPost(new Request("http://localhost/api/upload", { method: "POST", body: form }));
  assert.equal(uploaded.status, 200, await uploaded.clone().text());
  const { data: upload } = await fx.admin.from("project_evidence").select("id,storage_path,uploaded_by").eq("project_id", fx.projects.B).order("uploaded_at", { ascending: false }).limit(1).single();
  assert.ok(upload.storage_path.startsWith(`${fx.users.bPm.id}/${fx.projects.B}/`), upload.storage_path);
  actAs(sessions.admin);
  const removed = await evidenceDelete(json("/api/project-evidence", { id: upload.id, projectId: fx.projects.B }, "DELETE"));
  assert.equal(removed.status, 200, await removed.clone().text());
  const folder = `${fx.users.bPm.id}/${fx.projects.B}`;
  const { data: afterUpload } = await fx.admin.storage.from(BUCKET).list(folder);
  assert.ok(!(afterUpload ?? []).some((object) => `${folder}/${object.name}` === upload.storage_path), "verified object removed");

  // A legacy row (pre-F22-B) whose path points at tenant A's object: the row goes, A's object stays.
  const victimFolder = `${fx.users.aOwner.id}/${fx.projects.A}`;
  const victimPath = `${victimFolder}/${randomBytes(8).toString("hex")}-board.txt`;
  await must(fx.admin.storage.from(BUCKET).upload(victimPath, Buffer.from("tenant A board minutes"), { contentType: "text/plain" }), "victim object");
  plantedObjects.push(victimPath);
  const legacy = await must(fx.admin.from("project_evidence").insert({ workspace_id: fx.workspaces.B, project_id: fx.projects.B, file_name: "legacy.txt", file_type: "TXT", storage_path: victimPath, uploaded_by: fx.users.bPm.id, status: "processed" }).select("id").single(), "legacy evidence row");
  actAs(sessions.pm);
  const legacyDelete = await evidenceDelete(json("/api/project-evidence", { id: legacy.id, projectId: fx.projects.B }, "DELETE"));
  assert.equal(legacyDelete.status, 200, await legacyDelete.clone().text());
  assert.equal(await countWhere("project_evidence", { id: legacy.id }), 0, "legacy row removed");
  const { data: victimObjects } = await fx.admin.storage.from(BUCKET).list(victimFolder);
  assert.ok((victimObjects ?? []).some((object) => `${victimFolder}/${object.name}` === victimPath), "tenant A's object was not deleted");
});
