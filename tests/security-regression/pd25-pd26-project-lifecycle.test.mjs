/**
 * PD-25 / PD-26 (five-persona QA, Wave 3) — project lifecycle: archive is read-only, delete
 * leaves nothing behind.
 *
 * PD-25: after `status=archived` the project still accepted uploads, vault intake, Brain turns and
 * operational captures (LC-01). Now every content mutation is refused with 409 `project_archived`
 * — by the project-permission adapter, by the routes that authorize another way, and by the
 * database gate `can_write_operational_project` — while reads, reactivation (writers only),
 * duplication and permanent deletion keep working.
 *
 * PD-26: a hard delete cascaded `project_evidence` but left the bucket objects forever and
 * orphaned the project's vault documents at workspace level (LC-02). Now a BEFORE DELETE trigger
 * removes the project's own vault documents, signals and digestion runs and enqueues a Storage
 * cleanup job in the deleting transaction; the route drains it (idempotent, retryable). A project
 * with retained history (tasks, audit, provenance) cannot be hard-deleted: 409, nothing deleted.
 *
 * Real GoTrue sessions, the real routes, the real bucket, the real trigger and RPCs.
 */
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { bindAppEnvToHarness, createTenantFixtures, requireHarnessEnv } from "./support/harness.mjs";
import { actAs, installAppRouteMocks } from "./support/app-route-mocks.mjs";

const env = requireHarnessEnv();
bindAppEnvToHarness(env);
installAppRouteMocks();

const { POST: uploadPost } = await import("../../src/app/api/upload/route.ts");
const { POST: vaultIntakePost } = await import("../../src/app/api/vault/intake/route.ts");
const { POST: brainTurnPost } = await import("../../src/app/api/projects/[id]/brain/turns/route.ts");
const { POST: operationalFlowPost } = await import("../../src/app/api/operational-flow/route.ts");
const { GET: projectGet, PATCH: projectPatch, DELETE: projectDelete } = await import("../../src/app/api/projects/[id]/route.ts");
const { GET: evidenceGet } = await import("../../src/app/api/project-evidence/route.ts");
const { POST: duplicatePost } = await import("../../src/app/api/projects/[id]/duplicate/route.ts");
const { drainDeletedProjectStorage } = await import("../../src/lib/project-evidence/deleted-project-storage-cleanup.ts");

const BUCKET = "pmfreak-documents";
const json = (path, body, method = "POST") => new Request(`http://localhost${path}`, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const params = (id) => ({ params: Promise.resolve({ id }) });

let fx;
const sessions = {};
let deleteProjectId; // PD-26 delete target
let retainedProjectId; // PD-26 retained-history target
let duplicateIds = [];

before(async () => {
  fx = await createTenantFixtures(env, { label: "pd2526" });
  for (const who of ["bOwner", "bPm", "bViewer", "aOwner"]) sessions[who] = await fx.signIn(fx.users[who]);
  deleteProjectId = await fx.createProject(fx.workspaces.B, fx.users.bOwner.id, `Harness Delete ${fx.tag}`);
  retainedProjectId = await fx.createProject(fx.workspaces.B, fx.users.bOwner.id, `Harness Retained ${fx.tag}`);
});

after(async () => {
  if (!fx) return;
  const workspaces = [fx.workspaces.A, fx.workspaces.B];
  const { data: leftovers } = await fx.admin.from("project_evidence").select("storage_path").in("workspace_id", workspaces);
  const paths = (leftovers ?? []).map((row) => row.storage_path).filter(Boolean);
  if (paths.length) await fx.admin.storage.from(BUCKET).remove(paths);
  for (const table of ["recommended_actions", "raid_items"]) await fx.admin.from(table).delete().in("workspace_id", workspaces);
  await fx.teardown();
  // The teardown's workspace cascade deletes projects, so the trigger enqueues jobs with no FK.
  await fx.admin.from("storage_cleanup_jobs").delete().in("workspace_id", workspaces);
});

const uploadText = (projectId, name, text) => {
  const form = new FormData();
  form.set("projectId", projectId);
  form.append("documents", new File([text], name, { type: "text/plain" }));
  return uploadPost(new Request("http://localhost/api/upload", { method: "POST", body: form }));
};
const intake = (projectId, rawContent) => vaultIntakePost(json("/api/vault/intake", { workspaceId: fx.workspaces.B, projectId, rawContent, title: `intake ${fx.tag}` }));
const brainTurn = (projectId, text) => brainTurnPost(json(`/api/projects/${projectId}/brain/turns`, { clientMessageId: randomUUID(), text }), params(projectId));
const capture = (projectId, content) =>
  operationalFlowPost(json("/api/operational-flow", { workspaceId: fx.workspaces.B, projectId, operation: "capture_input", title: "Harness capture", content, occurredAt: new Date().toISOString(), idempotencyKey: randomUUID(), correlationId: randomUUID() }));
const patchProject = (projectId, body) => projectPatch(json(`/api/projects/${projectId}`, body, "PATCH"), params(projectId));
const deleteProject = (projectId) => projectDelete(new Request(`http://localhost/api/projects/${projectId}`, { method: "DELETE" }), params(projectId));

const countWhere = async (table, filters) => {
  let query = fx.admin.from(table).select("id", { count: "exact", head: true });
  for (const [column, value] of Object.entries(filters)) query = value === null ? query.is(column, null) : query.eq(column, value);
  const { count, error } = await query;
  assert.equal(error, null, `${table}: ${error?.message}`);
  return count ?? 0;
};
const projectStatus = async (projectId) => (await fx.admin.from("projects").select("status").eq("id", projectId).maybeSingle()).data?.status ?? null;
const objectsIn = async (folder) => ((await fx.admin.storage.from(BUCKET).list(folder, { limit: 1000 })).data ?? []).filter((o) => o.id);
const expectArchived = async (response, label) => {
  assert.equal(response.status, 409, `${label}: status ${response.status} ${await response.clone().text()}`);
  const body = await response.json();
  assert.ok(["project_archived", "PROJECT_ARCHIVED"].includes(body.code), `${label}: ${JSON.stringify(body)}`);
};

// ── PD-25 ──────────────────────────────────────────────────────────────────────────────────────

// Successful operational captures are NOT exercised here: the operational chain writes append-only
// platform_events / evidence_items that the PostgREST-only teardown cannot remove (see README,
// "Harness cleanup"). The QA browser harness (personas that are never torn down) covers the 201
// path before and after reactivation; here captures are only ever REFUSED (nothing written), and
// the database gate is read directly.
test("control: the active project accepts an upload and vault intake", async () => {
  actAs(sessions.bPm);
  const upload = await uploadText(fx.projects.B, "before-archive.txt", "Kickoff notes: phased cutover from the legacy ledger.");
  assert.equal(upload.status, 200, await upload.clone().text());
  const vault = await intake(fx.projects.B, `Risk: vendor access is blocked until the firewall change lands. ${fx.tag}`);
  assert.equal(vault.status, 200, await vault.clone().text());
});

test("PD-25: a pm archives the project; upload, vault intake, Brain turn, capture and rename are refused with 409 project_archived and nothing is written", async () => {
  actAs(sessions.bPm);
  const archive = await patchProject(fx.projects.B, { status: "archived" });
  assert.equal(archive.status, 200, await archive.clone().text());
  assert.equal(await projectStatus(fx.projects.B), "archived");

  const before = {
    evidence: await countWhere("project_evidence", { project_id: fx.projects.B }),
    vault: await countWhere("vault_documents", { project_id: fx.projects.B }),
    rawInputs: await countWhere("operational_raw_inputs", { project_id: fx.projects.B }),
    name: (await fx.admin.from("projects").select("name").eq("id", fx.projects.B).single()).data.name,
  };

  actAs(sessions.bOwner);
  await expectArchived(await uploadText(fx.projects.B, "after-archive.txt", "This must not be stored."), "upload");
  await expectArchived(await intake(fx.projects.B, `Risk: an archived project still receives notes. ${fx.tag}`), "vault intake");
  await expectArchived(await brainTurn(fx.projects.B, "Anything new on this project?"), "brain turn");
  await expectArchived(await capture(fx.projects.B, "Blocked: a capture on an archived project."), "operational capture");
  await expectArchived(await patchProject(fx.projects.B, { name: "Renamed while archived" }), "rename");

  assert.equal(await countWhere("project_evidence", { project_id: fx.projects.B }), before.evidence);
  assert.equal(await countWhere("vault_documents", { project_id: fx.projects.B }), before.vault);
  assert.equal(await countWhere("operational_raw_inputs", { project_id: fx.projects.B }), before.rawInputs);
  assert.equal((await fx.admin.from("projects").select("name").eq("id", fx.projects.B).single()).data.name, before.name);
});

test("PD-25: the database gate refuses operational writes on the archived project for a writer, reads unchanged", async () => {
  const pm = sessions.bPm;
  const writeArchived = await pm.rpc("can_write_operational_project", { p_workspace_id: fx.workspaces.B, p_project_id: fx.projects.B });
  assert.equal(writeArchived.error, null, writeArchived.error?.message);
  assert.equal(writeArchived.data, false);
  const readArchived = await pm.rpc("can_access_operational_project", { p_workspace_id: fx.workspaces.B, p_project_id: fx.projects.B });
  assert.equal(readArchived.data, true);
  const writeActive = await pm.rpc("can_write_operational_project", { p_workspace_id: fx.workspaces.B, p_project_id: deleteProjectId });
  assert.equal(writeActive.data, true);
  // And straight through PostgREST, under RLS, the same writer cannot insert operational rows.
  const direct = await pm.from("operational_raw_inputs").insert({ workspace_id: fx.workspaces.B, project_id: fx.projects.B, source_id: randomUUID(), idempotency_key: randomUUID(), title: "direct", content: "direct", occurred_at: new Date().toISOString(), correlation_id: randomUUID() }).select("id");
  assert.ok(direct.error || (direct.data ?? []).length === 0, "a direct insert on an archived project was stored");
});

test("PD-25: the archived project stays readable for members (project, evidence list), and a viewer still reads", async () => {
  actAs(sessions.bViewer);
  const project = await projectGet(new Request(`http://localhost/api/projects/${fx.projects.B}`), params(fx.projects.B));
  assert.equal(project.status, 200, await project.clone().text());
  const evidence = await evidenceGet(new Request(`http://localhost/api/project-evidence?projectId=${fx.projects.B}`));
  assert.equal(evidence.status, 200, await evidence.clone().text());
  const body = await evidence.json();
  const rows = Array.isArray(body) ? body : body.evidence ?? body.data ?? [];
  assert.ok(rows.some((row) => row.file_name === "before-archive.txt" || row.fileName === "before-archive.txt"), "the pre-archive evidence is still listed");
});

test("PD-25: an archived project can still be duplicated by a writer (the copy is active and separate)", async () => {
  actAs(sessions.bPm);
  const before = await countWhere("projects", { workspace_id: fx.workspaces.B });
  const response = await duplicatePost(new Request(`http://localhost/api/projects/${fx.projects.B}/duplicate`, { method: "POST" }), params(fx.projects.B));
  assert.ok(response.status < 300, `duplicate: ${response.status} ${await response.clone().text()}`);
  assert.equal(await countWhere("projects", { workspace_id: fx.workspaces.B }), before + 1);
  const { data: copies } = await fx.admin.from("projects").select("id, status").eq("workspace_id", fx.workspaces.B).neq("id", fx.projects.B).neq("id", deleteProjectId).neq("id", retainedProjectId);
  duplicateIds = (copies ?? []).map((row) => row.id);
  assert.equal(duplicateIds.length, 1);
  assert.notEqual(copies[0].status, "archived");
  assert.equal(await projectStatus(fx.projects.B), "archived", "the source stays archived");
});

test("PD-25: a viewer and another tenant cannot reactivate; a pm can, and writes resume", async () => {
  actAs(sessions.bViewer);
  const viewer = await patchProject(fx.projects.B, { status: "active" });
  assert.equal(viewer.status, 403, await viewer.clone().text());
  actAs(sessions.aOwner);
  const other = await patchProject(fx.projects.B, { status: "active" });
  assert.ok([403, 404].includes(other.status), `other tenant: ${other.status}`);
  assert.equal(await projectStatus(fx.projects.B), "archived");

  actAs(sessions.bPm);
  const reactivate = await patchProject(fx.projects.B, { status: "active" });
  assert.equal(reactivate.status, 200, await reactivate.clone().text());
  assert.equal(await projectStatus(fx.projects.B), "active");
  const upload = await uploadText(fx.projects.B, "after-reactivation.txt", "Writes resume after reactivation.");
  assert.equal(upload.status, 200, await upload.clone().text());
  const gate = await sessions.bPm.rpc("can_write_operational_project", { p_workspace_id: fx.workspaces.B, p_project_id: fx.projects.B });
  assert.equal(gate.data, true);
});

// ── PD-26 ──────────────────────────────────────────────────────────────────────────────────────

test("PD-26: the object lister returns nothing for a live project and is not executable by a member", async () => {
  actAs(sessions.bOwner);
  const upload = await uploadText(deleteProjectId, "owner-file.txt", "Owner's file on the project to be deleted.");
  assert.equal(upload.status, 200, await upload.clone().text());
  actAs(sessions.bPm);
  const upload2 = await uploadText(deleteProjectId, "pm-file.txt", "The pm's file on the project to be deleted.");
  assert.equal(upload2.status, 200, await upload2.clone().text());
  assert.equal((await objectsIn(`${fx.users.bOwner.id}/${deleteProjectId}`)).length, 1);
  assert.equal((await objectsIn(`${fx.users.bPm.id}/${deleteProjectId}`)).length, 1);

  const live = await fx.admin.rpc("list_deleted_project_storage_objects", { p_project_id: deleteProjectId, p_limit: 100 });
  assert.equal(live.error, null, live.error?.message);
  assert.deepEqual(live.data, [], "a live project's objects are never listed for cleanup");
  const asMember = await sessions.bPm.rpc("list_deleted_project_storage_objects", { p_project_id: deleteProjectId, p_limit: 100 });
  assert.ok(asMember.error, "a member could execute the lister");
  const jobsAsMember = await sessions.bPm.from("storage_cleanup_jobs").select("id");
  assert.ok(jobsAsMember.error || (jobsAsMember.data ?? []).length === 0, "a member could read the job table");
});

test("PD-26: deleting a project removes its evidence rows, stored objects, vault documents and digestion runs; another project's objects stay; the job completes", async () => {
  actAs(sessions.bOwner);
  const vault = await intake(deleteProjectId, `Blocker: cutover rehearsal waiting on finance sign-off. ${fx.tag}`);
  assert.equal(vault.status, 200, await vault.clone().text());
  // Conversation-derived content that the copilot's continuity retrieval reads workspace-wide.
  const runId = randomUUID();
  const now = new Date().toISOString();
  const run = await fx.admin.from("vault_digestion_runs").insert({ id: runId, workspace_id: fx.workspaces.B, project_id: deleteProjectId, nutrient_count: 1, started_at: now, completed_at: now });
  assert.equal(run.error, null, run.error?.message);
  const nutrient = await fx.admin.from("vault_nutrients").insert({ id: randomUUID(), digestion_run_id: runId, workspace_id: fx.workspaces.B, project_id: deleteProjectId, nutrient_type: "risk_signal", summary: `Deleted-project nutrient ${fx.tag}` });
  assert.equal(nutrient.error, null, nutrient.error?.message);

  const folders = [`${fx.users.bOwner.id}/${deleteProjectId}`, `${fx.users.bPm.id}/${deleteProjectId}`];
  const controlFolder = `${fx.users.bPm.id}/${fx.projects.B}`;
  const before = {
    evidence: await countWhere("project_evidence", { project_id: deleteProjectId }),
    content: await countWhere("project_evidence_content", { project_id: deleteProjectId }),
    vault: await countWhere("vault_documents", { project_id: deleteProjectId }),
    orphanVault: await countWhere("vault_documents", { workspace_id: fx.workspaces.B, project_id: null }),
    runs: await countWhere("vault_digestion_runs", { project_id: deleteProjectId }),
    nutrients: await countWhere("vault_nutrients", { project_id: deleteProjectId }),
    orphanNutrients: await countWhere("vault_nutrients", { workspace_id: fx.workspaces.B, project_id: null }),
    control: (await objectsIn(controlFolder)).length,
  };
  assert.ok(before.evidence >= 2 && before.vault >= 1 && before.runs === 1 && before.nutrients === 1 && before.control >= 1, JSON.stringify(before));

  const response = await deleteProject(deleteProjectId);
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  assert.equal(body.deleted, true);
  assert.equal(body.storageCleanup, "completed");

  assert.equal((await fx.admin.from("projects").select("id").eq("id", deleteProjectId)).data.length, 0);
  assert.equal(await countWhere("project_evidence", { project_id: deleteProjectId }), 0);
  assert.equal(await countWhere("project_evidence_content", { project_id: deleteProjectId }), 0);
  for (const folder of folders) assert.deepEqual(await objectsIn(folder), [], `${folder} still holds objects`);
  assert.equal(await countWhere("vault_documents", { project_id: deleteProjectId }), 0);
  assert.equal(await countWhere("vault_documents", { workspace_id: fx.workspaces.B, project_id: null }), before.orphanVault, "no vault document was orphaned at workspace level");
  assert.equal(await countWhere("vault_digestion_runs", { project_id: deleteProjectId }), 0);
  assert.equal(await countWhere("vault_nutrients", { workspace_id: fx.workspaces.B, project_id: null }), before.orphanNutrients, "no nutrient was orphaned at workspace level");
  assert.equal((await objectsIn(controlFolder)).length, before.control, "another project's objects are untouched");

  const { data: job } = await fx.admin.from("storage_cleanup_jobs").select("attempts, completed_at, removed_objects, last_error").eq("project_id", deleteProjectId).single();
  assert.ok(job.completed_at, JSON.stringify(job));
  assert.equal(job.removed_objects, 2);
  assert.equal(job.last_error, null);
});

test("PD-26: the drain is idempotent and retryable — a completed job is not re-run, a job with nothing left to remove completes with zero removals", async () => {
  const again = await drainDeletedProjectStorage({ projectId: deleteProjectId });
  assert.deepEqual(again, { jobs: 0, completed: 0, pending: 0, removedObjects: 0 });
  // A job that outlived its objects (e.g. a retry after a partial failure) completes as a no-op.
  const ghostProject = randomUUID();
  const inserted = await fx.admin.from("storage_cleanup_jobs").insert({ project_id: ghostProject, workspace_id: fx.workspaces.B, attempts: 1, last_error: "remove: simulated transient failure" });
  assert.equal(inserted.error, null, inserted.error?.message);
  const retried = await drainDeletedProjectStorage({ projectId: ghostProject });
  assert.deepEqual(retried, { jobs: 1, completed: 1, pending: 0, removedObjects: 0 });
  const { data: job } = await fx.admin.from("storage_cleanup_jobs").select("attempts, completed_at, last_error").eq("project_id", ghostProject).single();
  assert.equal(job.attempts, 2);
  assert.ok(job.completed_at);
  assert.equal(job.last_error, null);
});

test("PD-26: a project with retained history (execution tasks) is refused with 409 project_has_retained_history and nothing is deleted", async () => {
  const task = await fx.admin.from("execution_tasks").insert({ workspace_id: fx.workspaces.B, project_id: retainedProjectId, title: `Retained task ${fx.tag}`, description: "harness" }).select("id").single();
  assert.equal(task.error, null, task.error?.message);
  actAs(sessions.bOwner);
  const upload = await uploadText(retainedProjectId, "retained.txt", "A file on a project with retained history.");
  assert.equal(upload.status, 200, await upload.clone().text());

  const response = await deleteProject(retainedProjectId);
  const body = await response.json();
  assert.equal(response.status, 409, JSON.stringify(body));
  assert.equal(body.code, "project_has_retained_history");
  assert.equal((await fx.admin.from("projects").select("id").eq("id", retainedProjectId)).data.length, 1);
  assert.equal((await fx.admin.from("execution_tasks").select("id").eq("id", task.data.id)).data.length, 1);
  assert.equal(await countWhere("project_evidence", { project_id: retainedProjectId }), 1);
  assert.equal((await objectsIn(`${fx.users.bOwner.id}/${retainedProjectId}`)).length, 1);
  assert.equal(await countWhere("storage_cleanup_jobs", { project_id: retainedProjectId }), 0, "the refused delete enqueued nothing");

  // Archival is that project's end state — and it still works for a writer.
  const archive = await patchProject(retainedProjectId, { status: "archived" });
  assert.equal(archive.status, 200, await archive.clone().text());
});

test("PD-26: a viewer and another tenant cannot delete a project", async () => {
  actAs(sessions.bViewer);
  const viewer = await deleteProject(fx.projects.B);
  assert.equal(viewer.status, 403, await viewer.clone().text());
  actAs(sessions.aOwner);
  const other = await deleteProject(fx.projects.B);
  assert.ok([403, 404].includes(other.status), `other tenant: ${other.status}`);
  assert.equal((await fx.admin.from("projects").select("id").eq("id", fx.projects.B)).data.length, 1);
});
