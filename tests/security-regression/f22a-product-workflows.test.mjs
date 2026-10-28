/**
 * F22-A product compatibility — the real upload → extraction → discovery chain and the
 * evidence / discovery routes, run under real sessions against the role-aware evidence RLS,
 * the composite evidence/discovery foreign keys and the projects-derived discovery workspace.
 *
 * POST /api/upload (user RLS client) stores the file in the local Storage bucket, inserts
 * project_evidence and schedules the privileged EvidenceProcessor, which upserts
 * project_evidence_content and regenerates discovery (project_discovery, RAID items, discovery
 * source document, recommended actions) — all of which must stay in the project's workspace.
 */
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { bindAppEnvToHarness, createTenantFixtures, requireHarnessEnv } from "./support/harness.mjs";
import { actAs, installAppRouteMocks } from "./support/app-route-mocks.mjs";

const env = requireHarnessEnv();
bindAppEnvToHarness(env);
installAppRouteMocks();

const { POST: uploadPost } = await import("../../src/app/api/upload/route.ts");
const { GET: evidenceGet, DELETE: evidenceDelete } = await import("../../src/app/api/project-evidence/route.ts");
const { GET: discoveryGet } = await import("../../src/app/api/project-discovery/route.ts");

let fx;
let pm;
let admin;
let viewer;

const UPLOAD_TEXT = [
  "Stakeholder: Paula Sponsor, VP Operations and executive sponsor.",
  "Risk: the data migration may slip because the vendor API access is still pending.",
  "Dependency: vendor API credentials must be issued before integration testing.",
  "Milestone: cutover rehearsal on 2026-11-15.",
].join("\n");

before(async () => {
  fx = await createTenantFixtures(env, { label: "f22aprod" });
  pm = await fx.signIn(fx.users.bPm);
  admin = await fx.signIn(fx.users.bAdmin);
  viewer = await fx.signIn(fx.users.bViewer);
});

after(async () => {
  if (!fx) return;
  const workspaces = [fx.workspaces.A, fx.workspaces.B];
  const { data: leftovers } = await fx.admin.from("project_evidence").select("storage_path").in("workspace_id", workspaces);
  const paths = (leftovers ?? []).map((row) => row.storage_path).filter(Boolean);
  if (paths.length) await fx.admin.storage.from("pmfreak-documents").remove(paths);
  for (const table of ["recommended_actions", "raid_items"]) await fx.admin.from(table).delete().in("workspace_id", workspaces);
  await fx.teardown();
});

const upload = (projectId, name, text) => {
  const form = new FormData();
  form.set("projectId", projectId);
  form.append("documents", new File([text], name, { type: "text/plain" }));
  return uploadPost(new Request("http://localhost/api/upload", { method: "POST", body: form }));
};

const waitFor = async (what, probe, timeoutMs = 30000) => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`[f22a-product] timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
};

const rowsFor = async (table, projectId) => {
  const { data, error } = await fx.admin.from(table).select("id,workspace_id").eq("project_id", projectId);
  if (error) throw new Error(`[f22a-product] ${table}: ${error.message}`);
  return data;
};

test("pm upload → evidence → extraction → discovery → RAID items, all inside the project's workspace", async () => {
  actAs(pm);
  const response = await upload(fx.projects.B, `kickoff-${randomBytes(3).toString("hex")}.txt`, UPLOAD_TEXT);
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));

  const content = await waitFor("canonical evidence", async () => (await rowsFor("project_evidence_content", fx.projects.B)).length > 0);
  assert.ok(content);
  const discovery = await waitFor("discovery", async () => (await rowsFor("project_discovery", fx.projects.B))[0]);
  assert.equal(discovery.workspace_id, fx.workspaces.B);
  const raid = await waitFor("RAID items", async () => {
    const found = await rowsFor("raid_items", fx.projects.B);
    return found.length ? found : null;
  });
  for (const table of ["project_evidence", "project_evidence_content", "project_discovery", "raid_items", "vault_documents", "recommended_actions"]) {
    const found = await rowsFor(table, fx.projects.B);
    assert.ok(found.every((row) => row.workspace_id === fx.workspaces.B), `${table}: every row in B`);
  }
  assert.ok(raid.length > 0);
  for (const table of ["project_discovery", "raid_items", "project_evidence"]) {
    assert.deepEqual((await fx.admin.from(table).select("id").eq("workspace_id", fx.workspaces.A)).data, [], `${table}: nothing in A`);
  }
});

test("members read evidence and discovery through the routes; a viewer cannot upload or delete", async () => {
  actAs(viewer);
  const listed = await evidenceGet(new Request(`http://localhost/api/project-evidence?projectId=${fx.projects.B}`));
  assert.equal(listed.status, 200);
  const evidence = (await listed.json()).evidence ?? [];
  assert.ok(evidence.length >= 1, "viewer still reads evidence");
  const discovered = await discoveryGet(new Request(`http://localhost/api/project-discovery?projectId=${fx.projects.B}`));
  assert.equal(discovered.status, 200, "viewer still reads discovery");

  const before = (await rowsFor("project_evidence", fx.projects.B)).length;
  const refusedUpload = await upload(fx.projects.B, "viewer.txt", "Risk: viewer upload.");
  assert.equal(refusedUpload.status, 403);
  const refusedDelete = await evidenceDelete(new Request("http://localhost/api/project-evidence", { method: "DELETE", body: JSON.stringify({ id: evidence[0].id, projectId: fx.projects.B }) }));
  assert.equal(refusedDelete.status, 403);
  assert.equal((await rowsFor("project_evidence", fx.projects.B)).length, before, "viewer changed nothing");
});

test("admin deletes evidence through the route (row and stored object)", async () => {
  const { data: target } = await fx.admin.from("project_evidence").select("id,storage_path").eq("project_id", fx.projects.B).limit(1).single();
  actAs(admin);
  const response = await evidenceDelete(new Request("http://localhost/api/project-evidence", { method: "DELETE", body: JSON.stringify({ id: target.id, projectId: fx.projects.B }) }));
  assert.equal(response.status, 200, JSON.stringify(await response.clone().json()));
  assert.deepEqual((await fx.admin.from("project_evidence").select("id").eq("id", target.id)).data, []);
  const folder = target.storage_path.split("/").slice(0, -1).join("/");
  const { data: objects } = await fx.admin.storage.from("pmfreak-documents").list(folder);
  assert.ok(!(objects ?? []).some((object) => `${folder}/${object.name}` === target.storage_path), "stored object removed");
});
