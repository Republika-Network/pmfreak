/**
 * F21 product compatibility — the real application write paths for core project data, run as
 * real signed-in owner / admin / pm / viewer sessions after the role-aware RLS
 * (20261024000000_project_data_role_aware_rls.sql). Every one of these paths writes with the
 * user's own RLS-scoped client, so the policies — not only the app checks — decide them.
 *
 * Covered: project creation through POST /api/projects (createMinimalProject), the project
 * wizard's viewer refusal and its privileged compensating rollback (saveProjectOnboarding), the
 * Command Center empty state's viewer refusal (activateContextAction), project edit
 * and delete (PATCH / DELETE /api/projects/[id]), task, milestone and dependency creation and
 * updates through their API routes, and vault intake. Viewers are refused with an honest
 * message and leave no project data behind.
 *
 * The pm happy paths of the wizard and the Command Center run the operational evidence chain,
 * whose append-only evidence rows this PostgREST-only harness cannot remove; they live in
 * compat/f21-evidence-workflows.test.mjs (manual, disposable stack, reset afterwards).
 */
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { bindAppEnvToHarness, createTenantFixtures, requireHarnessEnv } from "./support/harness.mjs";
import { actAs, installAppRouteMocks } from "./support/app-route-mocks.mjs";

const env = requireHarnessEnv();
bindAppEnvToHarness(env);
installAppRouteMocks();

const { POST: createProjectPost } = await import("../../src/app/api/projects/route.ts");
const { PATCH: projectPatch, DELETE: projectDelete } = await import("../../src/app/api/projects/[id]/route.ts");
const { POST: createTaskPost } = await import("../../src/app/api/execution-tasks/route.ts");
const { POST: updateTaskPost } = await import("../../src/app/api/execution-tasks/update/route.ts");
const { POST: createMilestonePost } = await import("../../src/app/api/schedule/milestones/route.ts");
const { POST: updateMilestonePost } = await import("../../src/app/api/schedule/milestones/update/route.ts");
const { POST: createDependencyPost } = await import("../../src/app/api/execution-task-dependencies/route.ts");
const { POST: vaultIntakePost } = await import("../../src/app/api/vault/intake/route.ts");
const { saveProjectOnboarding } = await import("../../src/lib/projects/save-project-onboarding.ts");
const { activateContextAction } = await import("../../src/app/(protected)/command-center/actions.ts");

let fx;
const sessions = {};

before(async () => {
  fx = await createTenantFixtures(env, { label: "f21wf" });
  sessions.owner = await fx.signIn(fx.users.bOwner);
  sessions.admin = await fx.signIn(fx.users.bAdmin);
  sessions.pm = await fx.signIn(fx.users.bPm);
  sessions.viewer = await fx.signIn(fx.users.bViewer);
});

after(async () => {
  if (!fx) return;
  // The task API records execution_task_events, which do not cascade from tasks.
  const { data: tasks } = await fx.admin.from("execution_tasks").select("id").eq("workspace_id", fx.workspaces.B);
  const taskIds = (tasks ?? []).map((row) => row.id);
  if (taskIds.length) {
    const { error } = await fx.admin.from("execution_task_events").delete().in("task_id", taskIds);
    if (error) throw new Error(`[security-regression] f21 workflow cleanup: ${error.message}`);
  }
  await fx.teardown();
});

const json = (path, body, method = "POST") =>
  new Request(`http://127.0.0.1:3000${path}`, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

const params = (id) => ({ params: Promise.resolve({ id }) });

const projectsOf = async (userId) => {
  const { data, error } = await fx.admin.from("projects").select("id, workspace_id, name").eq("user_id", userId).order("created_at");
  if (error) throw new Error(`[security-regression] read projects: ${error.message}`);
  return data;
};

const coreRowCounts = async () => {
  const counts = {};
  for (const table of ["projects", "execution_tasks", "project_milestones", "raid_items", "execution_task_dependencies"]) {
    const { count, error } = await fx.admin.from(table).select("id", { count: "exact", head: true }).eq("workspace_id", fx.workspaces.B);
    if (error) throw new Error(`[security-regression] count ${table}: ${error.message}`);
    counts[table] = count;
  }
  return counts;
};

const onboardingPayload = (name, overrides = {}) => ({
  identity: { projectName: name, clientOrganization: "Harness Client", projectType: "implementation", pmAssigned: "Harness PM", technicalLead: "", targetDeliveryDate: "" },
  deliveryContext: { problemStatement: "Migrate the billing platform before the contract renewal.", mainDeliverable: "Migrated platform", externalDependencies: "Vendor API access is still pending." },
  discovery: { unknowns: "Data volume is unknown." },
  ...overrides,
});

/** Runs a server action that ends in redirect(); returns the redirect target. */
const redirectTarget = async (run) => {
  try {
    await run();
  } catch (error) {
    const digest = String(error?.digest ?? "");
    if (digest.startsWith("NEXT_REDIRECT")) return digest.split(";")[2];
    throw error;
  }
  assert.fail("expected the server action to redirect");
};

const captureEvents = async (run) => {
  const events = [];
  const original = console.info;
  console.info = (line, ...rest) => {
    try {
      events.push(JSON.parse(line).event);
    } catch {
      original(line, ...rest);
    }
  };
  try {
    return { result: await run(), events };
  } finally {
    console.info = original;
  }
};

test("pm creates a project through POST /api/projects", async () => {
  actAs(sessions.pm);
  const response = await createProjectPost(json("/api/projects", { name: `pm api project ${fx.tag}` }));
  assert.equal(response.status, 201, JSON.stringify(await response.clone().json()));
  const body = await response.json();
  assert.equal(body.data.project.workspace_id, fx.workspaces.B);
});

test("viewer is refused by POST /api/projects with 403 insufficient_role and nothing is written", async () => {
  const before = await coreRowCounts();
  actAs(sessions.viewer);
  const response = await createProjectPost(json("/api/projects", { name: `viewer api project ${fx.tag}` }));
  assert.equal(response.status, 403);
  assert.equal((await response.json()).failureClass, "insufficient_role");
  assert.deepEqual(await coreRowCounts(), before);
});

test("viewer is refused by the project wizard before any write", async () => {
  const before = await coreRowCounts();
  actAs(sessions.viewer);
  const result = await saveProjectOnboarding(onboardingPayload(`viewer wizard project ${fx.tag}`), `f21v-${fx.tag}`, { workspaceId: fx.workspaces.B });
  assert.equal(result.status, "fatal_failure");
  assert.equal(result.failureClass, "insufficient_role");
  assert.deepEqual(await coreRowCounts(), before);
});

test("pm wizard failure after the insert is rolled back by the narrow privileged compensating delete", async () => {
  const before = await projectsOf(fx.users.bPm.id);
  // Fault injection: `discovery` is read once while the insert serializes the payload, and
  // again right after the insert — the second read throws, as any downstream failure would.
  let reads = 0;
  const payload = onboardingPayload(`pm rollback project ${fx.tag}`);
  const discovery = payload.discovery;
  delete payload.discovery;
  Object.defineProperty(payload, "discovery", {
    enumerable: true,
    get() {
      reads += 1;
      if (reads > 1) throw new Error("injected downstream failure");
      return discovery;
    },
  });
  actAs(sessions.pm);
  const { result, events } = await captureEvents(() => saveProjectOnboarding(payload, `f21rb-${fx.tag}`, { workspaceId: fx.workspaces.B }));
  assert.equal(result.status, "recoverable_failure", JSON.stringify(result));
  assert.ok(events.includes("project.create.rollback.started"), "the project row was inserted before the failure");
  assert.ok(events.includes("project.create.rollback.completed"), `rollback did not complete: ${events.join(",")}`);
  assert.deepEqual(await projectsOf(fx.users.bPm.id), before, "the half-created project was left behind");
});

test("viewer is redirected from the Command Center empty state with an error and writes nothing", async () => {
  const data = new FormData();
  data.set("name", `viewer command center ${fx.tag}`);
  data.set("description", "harness");
  const before = await coreRowCounts();
  actAs(sessions.viewer);
  const target = await redirectTarget(() => activateContextAction(fx.workspaces.B, data));
  assert.match(decodeURIComponent(target.replace(/\+/g, " ")), /can't create projects/);
  assert.deepEqual(await coreRowCounts(), before);
});

test("pm edits a project through PATCH; pm cannot delete it (403); admin can", async () => {
  const [project] = await projectsOf(fx.users.bPm.id);
  actAs(sessions.pm);
  const patched = await projectPatch(json(`/api/projects/${project.id}`, { name: `pm renamed ${fx.tag}` }, "PATCH"), params(project.id));
  assert.equal(patched.status, 200, await patched.clone().text());

  const refused = await projectDelete(new Request(`http://127.0.0.1:3000/api/projects/${project.id}`, { method: "DELETE" }), params(project.id));
  assert.equal(refused.status, 403);
  assert.equal((await projectsOf(fx.users.bPm.id)).some((row) => row.id === project.id), true);

  actAs(sessions.admin);
  const removed = await projectDelete(new Request(`http://127.0.0.1:3000/api/projects/${project.id}`, { method: "DELETE" }), params(project.id));
  assert.ok(removed.status < 300, await removed.clone().text());
  assert.equal((await projectsOf(fx.users.bPm.id)).some((row) => row.id === project.id), false);
});

test("pm runs the delivery workflows through the API: tasks, milestones, dependencies", async () => {
  actAs(sessions.pm);
  const t1 = await createTaskPost(json("/api/execution-tasks", { projectId: fx.projects.B, title: `pm api task 1 ${fx.tag}` }));
  assert.equal(t1.status, 201, await t1.clone().text());
  const t2 = await createTaskPost(json("/api/execution-tasks", { projectId: fx.projects.B, title: `pm api task 2 ${fx.tag}` }));
  assert.equal(t2.status, 201);
  const task1 = (await t1.json()).task;
  const task2 = (await t2.json()).task;

  const updated = await updateTaskPost(json("/api/execution-tasks/update", { taskId: task1.id, title: `pm api task 1 renamed ${fx.tag}` }));
  assert.ok(updated.status < 300, await updated.clone().text());

  const milestone = await createMilestonePost(json("/api/schedule/milestones", { projectId: fx.projects.B, title: `pm milestone ${fx.tag}` }));
  assert.ok(milestone.status < 300, await milestone.clone().text());
  const milestoneBody = await milestone.json();
  const milestoneId = milestoneBody.milestone?.id ?? milestoneBody.data?.milestone?.id ?? milestoneBody.id;
  assert.ok(milestoneId, JSON.stringify(milestoneBody));
  const milestoneUpdate = await updateMilestonePost(json("/api/schedule/milestones/update", { milestoneId, title: `pm milestone renamed ${fx.tag}` }));
  assert.ok(milestoneUpdate.status < 300, await milestoneUpdate.clone().text());

  const dependency = await createDependencyPost(json("/api/execution-task-dependencies", { predecessorTaskId: task1.id, successorTaskId: task2.id }));
  assert.ok(dependency.status < 300, await dependency.clone().text());
});

test("viewer is refused by the delivery APIs and nothing is written", async () => {
  const before = await coreRowCounts();
  actAs(sessions.viewer);
  const task = await createTaskPost(json("/api/execution-tasks", { projectId: fx.projects.B, title: `viewer api task ${fx.tag}` }));
  assert.ok(task.status >= 400, "viewer created a task through the API");
  const milestone = await createMilestonePost(json("/api/schedule/milestones", { projectId: fx.projects.B, title: `viewer milestone ${fx.tag}` }));
  assert.ok(milestone.status >= 400, "viewer created a milestone through the API");
  assert.deepEqual(await coreRowCounts(), before);
});

// F21 made the RAID write role-aware; F22-B made the intake itself an owner/admin/pm capability
// (route gate + vault_documents RLS), so a viewer's call now stores nothing at all.
test("vault intake: pm intake succeeds; a viewer's intake creates no RAID item", async (t) => {
  const content = "Risk: the vendor may miss the API delivery date.\nIssue: production access is still blocked.";
  const raidBeforePm = (await coreRowCounts()).raid_items;
  actAs(sessions.pm);
  const pmResponse = await vaultIntakePost(json("/api/vault/intake", { workspaceId: fx.workspaces.B, projectId: fx.projects.B, rawContent: content, title: `pm intake ${fx.tag}` }));
  assert.ok(pmResponse.status < 300, await pmResponse.clone().text());
  assert.ok((await coreRowCounts()).raid_items > raidBeforePm, "a pm's vault intake materialized no RAID item through the user client");

  const raidBefore = (await coreRowCounts()).raid_items;
  actAs(sessions.viewer);
  const viewerResponse = await vaultIntakePost(json("/api/vault/intake", { workspaceId: fx.workspaces.B, projectId: fx.projects.B, rawContent: `${content}\nAssumption: viewer ${fx.tag}`, title: `viewer intake ${fx.tag}` }));
  const { count: viewerDocs } = await fx.admin.from("vault_documents").select("id", { count: "exact", head: true }).eq("workspace_id", fx.workspaces.B).eq("created_by", fx.users.bViewer.id);
  t.diagnostic(`viewer vault intake → HTTP ${viewerResponse.status}; vault_documents stored by the viewer: ${viewerDocs ?? "n/a"}`);
  assert.equal((await coreRowCounts()).raid_items, raidBefore, "a viewer's vault intake created RAID items");
  assert.equal(viewerResponse.status, 403, "a viewer's vault intake is refused (F22-B)");
  assert.equal(viewerDocs, 0, "a viewer's vault intake stores no document (F22-B)");
});
