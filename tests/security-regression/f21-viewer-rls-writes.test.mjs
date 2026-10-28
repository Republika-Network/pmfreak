/**
 * F21 (and the RLS half of F5) — viewer writes allowed by membership-only RLS. Both halves are
 * remediated: workspace_governance by PR-3, core project data by
 * 20261024000000_project_data_role_aware_rls.sql.
 *
 * The browser holds the user's JWT, so whatever RLS permits is reachable directly through
 * PostgREST regardless of application-layer role checks. The write policies on projects,
 * execution_tasks, project_milestones, raid_items and execution_task_dependencies used to test
 * workspace membership only, and their project / task / milestone / document references were
 * independent foreign keys (which ignore RLS), so a viewer could write and any writer could
 * attach rows to another tenant's project.
 *
 * Role model (src/lib/security/rbac.ts): owner/admin/pm write, owner/admin delete, viewer reads.
 * Every request here is a real authenticated PostgREST call with the user's own session; every
 * refusal is checked against a snapshot of all five tables for both tenants.
 */
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { createTenantFixtures, requireHarnessEnv } from "./support/harness.mjs";

const env = requireHarnessEnv();

const CORE_TABLES = ["projects", "execution_tasks", "project_milestones", "raid_items", "execution_task_dependencies"];

let fx;
let viewer;
let pm;
let admin;
let owner;
let dual;
let dualUser;
let sacrificialProjectId;
const rows = {};

const must = async (promise, what) => {
  const { data, error } = await promise;
  if (error) throw new Error(`[security-regression] fixture step failed (${what}): ${error.message}`);
  return data;
};

const seed = async (table, row, what) => (await must(fx.admin.from(table).insert(row).select("id").single(), what)).id;

before(async () => {
  fx = await createTenantFixtures(env, { label: "f21" });
  const { A, B } = fx.workspaces;
  sacrificialProjectId = await fx.createProject(B, fx.users.bOwner.id, `Harness sacrificial ${fx.tag}`);

  // A user who writes in tenant A (pm) but only reads in tenant B (viewer).
  dualUser = await fx.createUser("dual");
  await must(fx.admin.from("workspace_memberships").insert([
    { workspace_id: A, user_id: dualUser.id, role: "pm" },
    { workspace_id: B, user_id: dualUser.id, role: "viewer" },
  ]), "dual memberships");

  for (const [key, workspaceId, projectId, ownerId] of [["A", A, fx.projects.A, fx.users.aOwner.id], ["B", B, fx.projects.B, fx.users.bOwner.id]]) {
    const doc = await seed("vault_documents", { workspace_id: workspaceId, title: `Harness doc ${key} ${fx.tag}`, raw_content: "harness", normalized_content: "harness" }, `vault doc ${key}`);
    const milestone = await seed("project_milestones", { workspace_id: workspaceId, project_id: projectId, title: `Harness milestone ${key} ${fx.tag}` }, `milestone ${key}`);
    const raid = await seed("raid_items", { workspace_id: workspaceId, project_id: projectId, source_document_id: doc, category: "risk", title: `Harness risk ${key}`, description: "harness", fingerprint: `f21-${key}-${fx.tag}` }, `raid ${key}`);
    const task1 = await seed("execution_tasks", { workspace_id: workspaceId, project_id: projectId, title: `Harness task ${key}1 ${fx.tag}`, description: "harness", created_by: ownerId }, `task ${key}1`);
    const task2 = await seed("execution_tasks", { workspace_id: workspaceId, project_id: projectId, title: `Harness task ${key}2 ${fx.tag}`, description: "harness", created_by: ownerId }, `task ${key}2`);
    const dependency = await seed("execution_task_dependencies", { workspace_id: workspaceId, project_id: projectId, predecessor_task_id: task1, successor_task_id: task2 }, `dependency ${key}`);
    rows[key] = { workspaceId, projectId, doc, milestone, raid, task1, task2, dependency };
  }

  viewer = await fx.signIn(fx.users.bViewer);
  pm = await fx.signIn(fx.users.bPm);
  admin = await fx.signIn(fx.users.bAdmin);
  owner = await fx.signIn(fx.users.bOwner);
  dual = await fx.signIn(dualUser);
});

after(async () => {
  if (fx) await fx.teardown();
});

const rejectedOrNoRows = (result) => result.error !== null || (Array.isArray(result.data) && result.data.length === 0);

/** Every row of the five core tables in both tenants, ordered — the "nothing changed" oracle. */
const coreState = async () => {
  const state = {};
  for (const table of CORE_TABLES) {
    const { data, error } = await fx.admin.from(table).select("*").in("workspace_id", [fx.workspaces.A, fx.workspaces.B]).order("id");
    if (error) throw new Error(`[security-regression] snapshot ${table}: ${error.message}`);
    state[table] = data;
  }
  return state;
};

const assertRefusedWithoutChange = async (label, attempts) => {
  const snapshot = await coreState();
  for (const [what, run] of attempts) {
    const result = await run();
    assert.ok(rejectedOrNoRows(result), `${label}: ${what} was accepted`);
  }
  assert.deepEqual(await coreState(), snapshot, `${label}: a refused write changed project data`);
};

const taskRow = (title) => ({ workspace_id: fx.workspaces.B, project_id: fx.projects.B, title, description: "harness" });

test("control: a viewer can read their workspace's project", async () => {
  const { data, error } = await viewer.from("projects").select("id").eq("id", fx.projects.B);
  assert.equal(error, null);
  assert.equal(data.length, 1);
});

test("control: role-aware RLS already blocks a viewer from creating a PMO", async () => {
  const result = await viewer.from("pmos").insert({ workspace_id: fx.workspaces.B, name: `viewer pmo ${fx.tag}` }).select("id");
  assert.ok(rejectedOrNoRows(result), "viewer created a PMO — role-aware baseline broken");
});

test("control: a viewer cannot create a project in another tenant's workspace", async () => {
  const result = await viewer.from("projects").insert({ workspace_id: fx.workspaces.A, user_id: fx.users.bViewer.id, name: `cross ${fx.tag}` }).select("id");
  assert.ok(rejectedOrNoRows(result), "cross-tenant project insert accepted");
});

test("control: a pm can create an execution task in their workspace", async () => {
  const { data, error } = await pm.from("execution_tasks").insert(taskRow(`pm task ${fx.tag}`)).select("id");
  assert.equal(error, null, `pm task insert failed: ${error?.message}`);
  assert.equal(data.length, 1);
});

// The five formerly registered F21 cases — assertions unchanged.
test("a viewer cannot create projects", async () => {
  const result = await viewer.from("projects").insert({ workspace_id: fx.workspaces.B, user_id: fx.users.bViewer.id, name: `viewer project ${fx.tag}` }).select("id");
  assert.ok(rejectedOrNoRows(result), "viewer created a project");
});

test("a viewer cannot modify a project", async () => {
  const result = await viewer.from("projects").update({ name: `viewer renamed ${fx.tag}` }).eq("id", fx.projects.B).select("id");
  assert.ok(rejectedOrNoRows(result), "viewer renamed a project");
});

test("a viewer cannot delete a project", async () => {
  await viewer.from("projects").delete().eq("id", sacrificialProjectId);
  const { data } = await fx.admin.from("projects").select("id").eq("id", sacrificialProjectId);
  assert.equal(data.length, 1, "viewer deleted a project");
});

test("a viewer cannot create execution tasks", async () => {
  const result = await viewer.from("execution_tasks").insert(taskRow(`viewer task ${fx.tag}`)).select("id");
  assert.ok(rejectedOrNoRows(result), "viewer created an execution task");
});

test("a viewer cannot create project milestones", async () => {
  const result = await viewer
    .from("project_milestones")
    .insert({ workspace_id: fx.workspaces.B, project_id: fx.projects.B, title: `viewer milestone ${fx.tag}` })
    .select("id");
  assert.ok(rejectedOrNoRows(result), "viewer created a milestone");
});

test("a viewer cannot insert, update, upsert or delete any core project data, and nothing changes", async () => {
  const B = rows.B;
  await assertRefusedWithoutChange("viewer", [
    ["project upsert over an existing row", () => viewer.from("projects").upsert({ id: B.projectId, workspace_id: B.workspaceId, user_id: fx.users.bViewer.id, name: "viewer upsert" }).select("id")],
    ["task update", () => viewer.from("execution_tasks").update({ title: "viewer edit" }).eq("id", B.task1).select("id")],
    ["task upsert", () => viewer.from("execution_tasks").upsert({ id: B.task1, ...taskRow("viewer upsert") }).select("id")],
    ["task delete", () => viewer.from("execution_tasks").delete().eq("id", B.task1).select("id")],
    ["milestone update", () => viewer.from("project_milestones").update({ title: "viewer edit" }).eq("id", B.milestone).select("id")],
    ["milestone delete", () => viewer.from("project_milestones").delete().eq("id", B.milestone).select("id")],
    ["RAID insert", () => viewer.from("raid_items").insert({ workspace_id: B.workspaceId, project_id: B.projectId, source_document_id: B.doc, category: "issue", title: "viewer", description: "viewer", fingerprint: `viewer-${fx.tag}` }).select("id")],
    ["RAID update", () => viewer.from("raid_items").update({ status: "closed" }).eq("id", B.raid).select("id")],
    ["RAID delete", () => viewer.from("raid_items").delete().eq("id", B.raid).select("id")],
    ["dependency insert", () => viewer.from("execution_task_dependencies").insert({ workspace_id: B.workspaceId, project_id: B.projectId, predecessor_task_id: B.task2, successor_task_id: B.task1 }).select("id")],
    ["dependency update", () => viewer.from("execution_task_dependencies").update({ status: "invalidated" }).eq("id", B.dependency).select("id")],
    ["dependency delete", () => viewer.from("execution_task_dependencies").delete().eq("id", B.dependency).select("id")],
  ]);
});

test("changed workspace ids cannot launder a write: a pm-in-A / viewer-in-B user can neither write into B nor move A's rows into B", async () => {
  const { A, B } = rows;
  await assertRefusedWithoutChange("dual-membership user", [
    ["project insert into B", () => dual.from("projects").insert({ workspace_id: B.workspaceId, user_id: dualUser.id, name: `dual ${fx.tag}` }).select("id")],
    ["moving A's project into B", () => dual.from("projects").update({ workspace_id: B.workspaceId }).eq("id", A.projectId).select("id")],
    ["moving A's task into B's workspace and project", () => dual.from("execution_tasks").update({ workspace_id: B.workspaceId, project_id: B.projectId }).eq("id", A.task1).select("id")],
    ["moving A's milestone into B", () => dual.from("project_milestones").update({ workspace_id: B.workspaceId, project_id: B.projectId }).eq("id", A.milestone).select("id")],
    ["moving A's RAID item into B", () => dual.from("raid_items").update({ workspace_id: B.workspaceId, project_id: B.projectId, source_document_id: B.doc }).eq("id", A.raid).select("id")],
    ["task insert into B", () => dual.from("execution_tasks").insert(taskRow(`dual task ${fx.tag}`)).select("id")],
  ]);
});

test("foreign keys cannot attach a writer's rows to another tenant's project, task, milestone, RAID item or document", async () => {
  const { A, B } = rows;
  await assertRefusedWithoutChange("tenant-B pm", [
    ["task in B pointing at A's project", () => pm.from("execution_tasks").insert({ ...taskRow("fk"), project_id: A.projectId }).select("id")],
    ["task in B pointing at A's milestone", () => pm.from("execution_tasks").insert({ ...taskRow("fk"), milestone_id: A.milestone }).select("id")],
    ["task in B pointing at A's RAID item", () => pm.from("execution_tasks").insert({ ...taskRow("fk"), raid_item_id: A.raid }).select("id")],
    ["re-pointing B's task at A's project", () => pm.from("execution_tasks").update({ project_id: A.projectId }).eq("id", B.task1).select("id")],
    ["re-pointing B's task at A's milestone", () => pm.from("execution_tasks").update({ milestone_id: A.milestone }).eq("id", B.task1).select("id")],
    ["milestone in B for A's project", () => pm.from("project_milestones").insert({ workspace_id: B.workspaceId, project_id: A.projectId, title: "fk" }).select("id")],
    ["RAID item in B for A's project", () => pm.from("raid_items").insert({ workspace_id: B.workspaceId, project_id: A.projectId, source_document_id: B.doc, category: "risk", title: "fk", description: "fk", fingerprint: `fk1-${fx.tag}` }).select("id")],
    ["RAID item in B citing A's document", () => pm.from("raid_items").insert({ workspace_id: B.workspaceId, project_id: B.projectId, source_document_id: A.doc, category: "risk", title: "fk", description: "fk", fingerprint: `fk2-${fx.tag}` }).select("id")],
    ["dependency in B between A's tasks", () => pm.from("execution_task_dependencies").insert({ workspace_id: B.workspaceId, project_id: B.projectId, predecessor_task_id: A.task1, successor_task_id: A.task2 }).select("id")],
    ["dependency in B for A's project", () => pm.from("execution_task_dependencies").insert({ workspace_id: B.workspaceId, project_id: A.projectId, predecessor_task_id: B.task2, successor_task_id: B.task1 }).select("id")],
    ["re-pointing B's dependency at A's task", () => pm.from("execution_task_dependencies").update({ predecessor_task_id: A.task1 }).eq("id", B.dependency).select("id")],
  ]);
});

test("cross-tenant writes stay impossible for tenant B's owner and admin", async () => {
  const A = rows.A;
  for (const [label, client] of [["B owner", owner], ["B admin", admin]]) {
    await assertRefusedWithoutChange(label, [
      ["update A's project", () => client.from("projects").update({ name: "cross" }).eq("id", A.projectId).select("id")],
      ["delete A's project", () => client.from("projects").delete().eq("id", A.projectId).select("id")],
      ["update A's task", () => client.from("execution_tasks").update({ title: "cross" }).eq("id", A.task1).select("id")],
      ["delete A's milestone", () => client.from("project_milestones").delete().eq("id", A.milestone).select("id")],
      ["update A's RAID item", () => client.from("raid_items").update({ status: "closed" }).eq("id", A.raid).select("id")],
      ["delete A's dependency", () => client.from("execution_task_dependencies").delete().eq("id", A.dependency).select("id")],
      ["project insert into A", () => client.from("projects").insert({ workspace_id: A.workspaceId, user_id: fx.users.bOwner.id, name: "cross" }).select("id")],
    ]);
  }
});

let pmProjectId;
let pmMilestoneId;
let pmDependencyId;

test("a pm keeps the write workflows: create and update projects, tasks, milestones, RAID items and dependencies", async () => {
  const B = rows.B;
  const project = await pm.from("projects").insert({ workspace_id: B.workspaceId, user_id: fx.users.bPm.id, name: `pm project ${fx.tag}` }).select("id").single();
  assert.equal(project.error, null, `pm project insert: ${project.error?.message}`);
  pmProjectId = project.data.id;
  const renamed = await pm.from("projects").update({ name: `pm renamed ${fx.tag}` }).eq("id", pmProjectId).select("id");
  assert.equal(renamed.data?.length, 1, `pm project update: ${renamed.error?.message}`);

  const milestone = await pm.from("project_milestones").insert({ workspace_id: B.workspaceId, project_id: pmProjectId, title: `pm milestone ${fx.tag}` }).select("id").single();
  assert.equal(milestone.error, null, `pm milestone insert: ${milestone.error?.message}`);
  pmMilestoneId = milestone.data.id;
  const milestoneUpdate = await pm.from("project_milestones").update({ title: `pm milestone renamed ${fx.tag}` }).eq("id", pmMilestoneId).select("id");
  assert.equal(milestoneUpdate.data?.length, 1, `pm milestone update: ${milestoneUpdate.error?.message}`);

  const t1 = await pm.from("execution_tasks").insert({ workspace_id: B.workspaceId, project_id: pmProjectId, milestone_id: pmMilestoneId, raid_item_id: B.raid, title: `pm t1 ${fx.tag}`, description: "pm" }).select("id").single();
  assert.equal(t1.error, null, `pm task insert with same-workspace references: ${t1.error?.message}`);
  const t2 = await pm.from("execution_tasks").insert({ workspace_id: B.workspaceId, project_id: pmProjectId, title: `pm t2 ${fx.tag}`, description: "pm" }).select("id").single();
  assert.equal(t2.error, null);
  const taskUpdate = await pm.from("execution_tasks").update({ title: `pm t1 renamed ${fx.tag}` }).eq("id", t1.data.id).select("id");
  assert.equal(taskUpdate.data?.length, 1, `pm task update: ${taskUpdate.error?.message}`);

  const raid = await pm.from("raid_items").insert({ workspace_id: B.workspaceId, project_id: pmProjectId, source_document_id: B.doc, category: "issue", title: "pm issue", description: "pm", fingerprint: `pm-${fx.tag}` }).select("id").single();
  assert.equal(raid.error, null, `pm RAID insert: ${raid.error?.message}`);
  const raidUpdate = await pm.from("raid_items").update({ status: "monitoring" }).eq("id", raid.data.id).select("id");
  assert.equal(raidUpdate.data?.length, 1, `pm RAID update: ${raidUpdate.error?.message}`);

  const dependency = await pm.from("execution_task_dependencies").insert({ workspace_id: B.workspaceId, project_id: pmProjectId, predecessor_task_id: t1.data.id, successor_task_id: t2.data.id }).select("id").single();
  assert.equal(dependency.error, null, `pm dependency insert: ${dependency.error?.message}`);
  pmDependencyId = dependency.data.id;
  const dependencyUpdate = await pm.from("execution_task_dependencies").update({ status: "resolved" }).eq("id", pmDependencyId).select("id");
  assert.equal(dependencyUpdate.data?.length, 1, `pm dependency update: ${dependencyUpdate.error?.message}`);
});

test("a pm cannot delete projects, milestones or dependencies (delete is owner/admin)", async () => {
  await assertRefusedWithoutChange("pm", [
    ["delete own project", () => pm.from("projects").delete().eq("id", pmProjectId).select("id")],
    ["delete milestone", () => pm.from("project_milestones").delete().eq("id", pmMilestoneId).select("id")],
    ["delete dependency", () => pm.from("execution_task_dependencies").delete().eq("id", pmDependencyId).select("id")],
  ]);
});

test("owner and admin keep delete: admin removes a dependency and a milestone, owner removes a project", async () => {
  const dependency = await admin.from("execution_task_dependencies").delete().eq("id", pmDependencyId).select("id");
  assert.equal(dependency.data?.length, 1, `admin dependency delete: ${dependency.error?.message}`);
  const milestone = await admin.from("project_milestones").delete().eq("id", pmMilestoneId).select("id");
  assert.equal(milestone.data?.length, 1, `admin milestone delete: ${milestone.error?.message}`);
  const project = await owner.from("projects").delete().eq("id", sacrificialProjectId).select("id");
  assert.equal(project.data?.length, 1, `owner project delete: ${project.error?.message}`);
  const created = await admin.from("projects").insert({ workspace_id: fx.workspaces.B, user_id: fx.users.bAdmin.id, name: `admin project ${fx.tag}` }).select("id").single();
  assert.equal(created.error, null, `admin project insert: ${created.error?.message}`);
  const removed = await admin.from("projects").delete().eq("id", created.data.id).select("id");
  assert.equal(removed.data?.length, 1, `admin project delete: ${removed.error?.message}`);
});

// F5 (RLS half) — remediated by PR-3 (20261023000000_workspace_governance_role_aware_rls.sql):
// members read workspace_governance; only owners/admins write it.
const governanceRow = async () => {
  const { data } = await fx.admin.from("workspace_governance").select("governance_jsonb").eq("workspace_id", fx.workspaces.B).maybeSingle().throwOnError();
  return data;
};

test("F5: a viewer cannot write workspace governance configuration", async () => {
  const result = await viewer
    .from("workspace_governance")
    .upsert({ workspace_id: fx.workspaces.B, governance_jsonb: { injectedBy: "viewer" } })
    .select("workspace_id");
  assert.ok(rejectedOrNoRows(result), "viewer wrote workspace_governance");
});

test("control: a workspace admin can write governance directly (role-aware RLS)", async () => {
  const { data, error } = await admin
    .from("workspace_governance")
    .upsert({ workspace_id: fx.workspaces.B, governance_jsonb: { writtenBy: "admin", tag: fx.tag } })
    .select("workspace_id");
  assert.equal(error, null, `admin governance write failed: ${error?.message}`);
  assert.equal(data.length, 1);
});

test("control: a viewer can still read their workspace's governance", async () => {
  const { data, error } = await viewer.from("workspace_governance").select("governance_jsonb").eq("workspace_id", fx.workspaces.B);
  assert.equal(error, null);
  assert.deepEqual(data, [{ governance_jsonb: { writtenBy: "admin", tag: fx.tag } }]);
});

test("PR-3: neither a pm nor a viewer can rewrite or delete existing governance directly", async () => {
  const before = await governanceRow();
  for (const [label, client] of [["pm", pm], ["viewer", viewer]]) {
    const update = await client.from("workspace_governance").update({ governance_jsonb: { injectedBy: label } }).eq("workspace_id", fx.workspaces.B).select("workspace_id");
    assert.ok(rejectedOrNoRows(update), `${label} rewrote workspace_governance`);
    const upsert = await client.from("workspace_governance").upsert({ workspace_id: fx.workspaces.B, governance_jsonb: { injectedBy: label } }).select("workspace_id");
    assert.ok(rejectedOrNoRows(upsert), `${label} upserted workspace_governance`);
    const removed = await client.from("workspace_governance").delete().eq("workspace_id", fx.workspaces.B).select("workspace_id");
    assert.ok(rejectedOrNoRows(removed), `${label} deleted workspace_governance`);
  }
  assert.deepEqual(await governanceRow(), before, "a refused direct write changed workspace_governance");
});
