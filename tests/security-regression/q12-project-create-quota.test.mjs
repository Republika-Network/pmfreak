/**
 * Q12 — creating a project obeys the plan's project limit, atomically, on every create path.
 *
 * Before 20261028000000_q12_project_create_quota.sql each create path checked
 * canCreateMoreProjects() and inserted in a separate statement, so parallel creates by one
 * Free user (limit 3) all passed the check: 2 projects + 3 parallel creates = 5. Every path —
 * createMinimalProject (POST /api/projects, the /projects inline form), saveProjectOnboarding
 * (the setup wizard) and the Command Center activateContextAction — now inserts through
 * src/lib/quota/project-quota.ts → the service-role-only create_project_within_limit(), which
 * shares duplicate_project_within_limit's per-actor lock, re-checks the writer role and the
 * PMO workspace, and counts + inserts in one transaction.
 *
 * Covered with real sessions, the real handlers and the real engine: no client role can call
 * the RPC; concurrent creates (engine and route) stop exactly at the limit; creates and
 * duplicates racing each other share one limit; the three entry points racing each other
 * never exceed it; refused, failed and rolled-back creates consume nothing; viewers and other
 * tenants are refused with nothing written; a paid plan keeps creating in parallel.
 *
 * The wizard runs here only with an injected downstream failure (its success path writes
 * append-only evidence this PostgREST-only harness cannot tear down — see compat/), and the
 * Command Center with an empty description, which skips setup-context ingestion.
 */
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { bindAppEnvToHarness, createTenantFixtures, requireHarnessEnv } from "./support/harness.mjs";
import { actAs, installAppRouteMocks } from "./support/app-route-mocks.mjs";

const env = requireHarnessEnv();
bindAppEnvToHarness(env);
installAppRouteMocks();

const { POST: createProjectPost } = await import("../../src/app/api/projects/route.ts");
const { saveProjectOnboarding } = await import("../../src/lib/projects/save-project-onboarding.ts");
const { activateContextAction } = await import("../../src/app/(protected)/command-center/actions.ts");
const { createProjectWithinLimit, duplicateProjectWithinLimit } = await import("../../src/lib/quota/project-quota.ts");

const INSUFFICIENT_PRIVILEGE = "42501";
const FREE_PROJECT_LIMIT = 3;

let fx;
const sessions = {};

before(async () => {
  fx = await createTenantFixtures(env, { label: "q12" });
  sessions.owner = await fx.signIn(fx.users.bOwner);
  sessions.viewer = await fx.signIn(fx.users.bViewer);
  sessions.aOwner = await fx.signIn(fx.users.aOwner);
});

after(async () => {
  if (fx) await fx.teardown();
});

/** A fresh Free pm of tenant B with no projects, so every test starts from a known count. */
const freshPm = async (name) => {
  const user = await fx.createUser(name);
  const { error } = await fx.admin.from("workspace_memberships").insert({ workspace_id: fx.workspaces.B, user_id: user.id, role: "pm" });
  if (error) throw new Error(`[security-regression] membership for ${name}: ${error.message}`);
  return { user, session: await fx.signIn(user) };
};

const ownedCount = async (userId) => {
  const { count, error } = await fx.admin.from("projects").select("id", { head: true, count: "exact" }).eq("user_id", userId);
  if (error) throw new Error(`[security-regression] count projects: ${error.message}`);
  return count;
};
const workspaceCount = async (workspaceId) => {
  const { count, error } = await fx.admin.from("projects").select("id", { head: true, count: "exact" }).eq("workspace_id", workspaceId);
  if (error) throw new Error(`[security-regression] count workspace projects: ${error.message}`);
  return count;
};
const seedProjects = async (userId, n) => {
  for (let i = 0; i < n; i += 1) await fx.createProject(fx.workspaces.B, userId, `q12 seed ${i} ${fx.tag}`);
};

const createViaApi = (name) =>
  createProjectPost(new Request("http://127.0.0.1:3000/api/projects", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name }) }));

const engineCreate = (userId, name, overrides = {}) =>
  createProjectWithinLimit({ actorUserId: userId, workspaceId: fx.workspaces.B, pmoId: null, name, description: null, onboardingPayload: null, ...overrides });

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

const commandCenterCreate = (workspaceId, name) => {
  const data = new FormData();
  data.set("name", name);
  return redirectTarget(() => activateContextAction(workspaceId, data));
};

/**
 * A wizard payload whose second read of `discovery` throws: the first read serialises the
 * payload into the create RPC, the second happens right after the insert — so the project
 * row exists and must be removed by the wizard's compensating rollback.
 */
const failingWizardPayload = (name) => {
  const discovery = { unknowns: "Data volume is unknown." };
  const payload = {
    identity: { projectName: name, clientOrganization: "Harness Client", projectType: "implementation", pmAssigned: "Harness PM", technicalLead: "", targetDeliveryDate: "" },
    deliveryContext: { problemStatement: "Migrate the billing platform before the contract renewal.", mainDeliverable: "Migrated platform", externalDependencies: "" },
  };
  let reads = 0;
  Object.defineProperty(payload, "discovery", {
    enumerable: true,
    get() {
      reads += 1;
      if (reads > 1) throw new Error("injected downstream failure");
      return discovery;
    },
  });
  return payload;
};

/** The wizard's console.info event lines, kept out of the test output. */
const quietly = async (run) => {
  const original = console.info;
  console.info = () => {};
  try {
    return await run();
  } finally {
    console.info = original;
  }
};

test("Q12: no client role can call create_project_within_limit, so nobody supplies their own limit", async () => {
  const before = await workspaceCount(fx.workspaces.B);
  const args = { p_actor_user_id: fx.users.bOwner.id, p_workspace_id: fx.workspaces.B, p_pmo_id: null, p_name: `q12 rpc ${fx.tag}`, p_description: null, p_onboarding_payload: null, p_project_limit: null };
  const signedIn = await sessions.owner.rpc("create_project_within_limit", args);
  assert.equal(signedIn.error?.code, INSUFFICIENT_PRIVILEGE, `owner session: ${JSON.stringify(signedIn.error)}`);
  const anon = createClient(env.url, env.anonKey, { auth: { persistSession: false } });
  const anonymous = await anon.rpc("create_project_within_limit", args);
  assert.equal(anonymous.error?.code, INSUFFICIENT_PRIVILEGE, `anon: ${JSON.stringify(anonymous.error)}`);
  assert.equal(await workspaceCount(fx.workspaces.B), before);
});

test("Q12: eight concurrent creates by one Free user starting at 0 — exactly 3 succeed", async () => {
  const { user } = await freshPm("q12-engine");
  const results = await Promise.all(Array.from({ length: 8 }, (_, i) => engineCreate(user.id, `q12 engine ${i} ${fx.tag}`)));
  assert.equal(results.filter((r) => r.ok).length, FREE_PROJECT_LIMIT);
  assert.ok(results.filter((r) => !r.ok).every((r) => r.reason === "project_limit_reached"));
  assert.equal(await ownedCount(user.id), FREE_PROJECT_LIMIT);
});

test("Q12: three creates racing three duplicates from 2 projects — exactly 1 succeeds", async () => {
  const { user } = await freshPm("q12-mixed");
  await seedProjects(user.id, 2);
  const results = await Promise.all([
    ...Array.from({ length: 3 }, (_, i) => engineCreate(user.id, `q12 mixed create ${i} ${fx.tag}`)),
    ...Array.from({ length: 3 }, () => duplicateProjectWithinLimit({ actorUserId: user.id, workspaceId: fx.workspaces.B, sourceProjectId: fx.projects.B, targetPmoId: null })),
  ]);
  assert.equal(results.filter((r) => r.ok).length, 1, JSON.stringify(results.map((r) => r.ok || r.reason)));
  assert.ok(results.filter((r) => !r.ok).every((r) => r.reason === "project_limit_reached"));
  assert.equal(await ownedCount(user.id), FREE_PROJECT_LIMIT);
});

test("Q12: eight concurrent POST /api/projects from 0 — three 201, five 402 upgrade_required", async () => {
  const { user, session } = await freshPm("q12-route");
  actAs(session);
  const responses = await Promise.all(Array.from({ length: 8 }, (_, i) => createViaApi(`q12 route ${i} ${fx.tag}`)));
  const statuses = responses.map((r) => r.status).sort();
  assert.deepEqual(statuses, [201, 201, 201, 402, 402, 402, 402, 402]);
  for (const response of responses.filter((r) => r.status === 402)) {
    const body = await response.json();
    assert.equal(body.failureClass, "upgrade_required");
    assert.equal(body.error, "Project limit reached for your plan.");
  }
  assert.equal(await ownedCount(user.id), FREE_PROJECT_LIMIT);
});

test("Q12: the three create entry points racing each other never exceed the limit, and rolled-back wizard rows free their slot", async (t) => {
  const { user, session } = await freshPm("q12-entry");
  await seedProjects(user.id, 1);
  actAs(session);
  const outcomes = await quietly(() =>
    Promise.all([
      ...Array.from({ length: 3 }, (_, i) => createViaApi(`q12 entry api ${i} ${fx.tag}`).then((r) => ({ path: "api", ok: r.status === 201, refusal: r.status === 402 }))),
      ...Array.from({ length: 3 }, (_, i) =>
        commandCenterCreate(fx.workspaces.B, `q12 entry cc ${i} ${fx.tag}`).then((target) => ({
          path: "command_center",
          ok: target.includes("projectId="),
          refusal: target.startsWith("/projects?error=upgrade_required"),
          target,
        })),
      ),
      ...Array.from({ length: 3 }, (_, i) =>
        saveProjectOnboarding(failingWizardPayload(`q12 entry wizard ${i} ${fx.tag}`), `q12w-${i}-${fx.tag}`, { workspaceId: fx.workspaces.B }).then((r) => ({
          path: "wizard",
          ok: false,
          rolledBack: r.failureClass === "downstream_failure",
          refusal: r.failureClass === "upgrade_required",
          result: r,
        })),
      ),
    ]),
  );
  const created = outcomes.filter((o) => o.ok);
  const tally = (path) => outcomes.filter((o) => o.path === path).map((o) => (o.ok ? "created" : o.refusal ? "refused" : "rolled_back")).join(",");
  t.diagnostic(`from 1 project: api=${tally("api")} command_center=${tally("command_center")} wizard=${tally("wizard")}`);
  // Every outcome is a success, a limit refusal, or (wizard) an insert that was rolled back.
  for (const o of outcomes) assert.ok(o.ok || o.refusal || o.rolledBack, `unexpected outcome ${JSON.stringify(o)}`);
  assert.ok(created.length <= FREE_PROJECT_LIMIT - 1, `created ${created.length}`);
  const owned = await ownedCount(user.id);
  assert.equal(owned, 1 + created.length, "only the committed creates remain; rolled-back wizard rows are gone");
  assert.ok(owned <= FREE_PROJECT_LIMIT);
  // Rolled-back rows consumed nothing: the user can still fill exactly the remaining slots.
  const topUp = [];
  for (let i = owned; i < FREE_PROJECT_LIMIT; i += 1) topUp.push((await createViaApi(`q12 entry top-up ${i} ${fx.tag}`)).status);
  assert.ok(topUp.every((status) => status === 201), JSON.stringify(topUp));
  assert.equal((await createViaApi(`q12 entry over ${fx.tag}`)).status, 402);
  assert.equal(await ownedCount(user.id), FREE_PROJECT_LIMIT);
});

test("Q12: a rolled-back wizard create and a failed create consume no quota", async () => {
  const { user, session } = await freshPm("q12-recover");
  await seedProjects(user.id, 2);
  actAs(session);
  const rolledBack = await quietly(() => saveProjectOnboarding(failingWizardPayload(`q12 rollback ${fx.tag}`), `q12rb-${fx.tag}`, { workspaceId: fx.workspaces.B }));
  assert.equal(rolledBack.status, "recoverable_failure", JSON.stringify(rolledBack));
  assert.equal(rolledBack.failureClass, "downstream_failure");
  assert.equal(await ownedCount(user.id), 2);

  // A PMO that is not in the workspace is refused inside the transaction; an invalid insert raises.
  assert.deepEqual(await engineCreate(user.id, `q12 foreign pmo ${fx.tag}`, { pmoId: randomUUID() }), { ok: false, reason: "pmo_not_found" });
  await assert.rejects(engineCreate(user.id, "   "), /Project create failed/);
  assert.equal(await ownedCount(user.id), 2);

  assert.equal((await createViaApi(`q12 after recovery ${fx.tag}`)).status, 201);
  assert.equal((await createViaApi(`q12 over the limit ${fx.tag}`)).status, 402);
  assert.equal(await ownedCount(user.id), FREE_PROJECT_LIMIT);
});

test("Q12: a viewer cannot create — refused by every entry point and inside the database, nothing written", async () => {
  const before = await workspaceCount(fx.workspaces.B);
  actAs(sessions.viewer);
  const api = await createViaApi(`q12 viewer api ${fx.tag}`);
  assert.equal(api.status, 403);
  assert.equal((await api.json()).failureClass, "insufficient_role");
  const wizard = await quietly(() => saveProjectOnboarding(failingWizardPayload(`q12 viewer wizard ${fx.tag}`), `q12v-${fx.tag}`, { workspaceId: fx.workspaces.B }));
  assert.equal(wizard.failureClass, "insufficient_role");
  const target = await commandCenterCreate(fx.workspaces.B, `q12 viewer cc ${fx.tag}`);
  assert.match(decodeURIComponent(target.replace(/\+/g, " ")), /can't create projects/);
  assert.deepEqual(await engineCreate(fx.users.bViewer.id, `q12 viewer engine ${fx.tag}`), { ok: false, reason: "insufficient_role" });
  assert.equal(await ownedCount(fx.users.bViewer.id), 0);
  assert.equal(await workspaceCount(fx.workspaces.B), before);
});

test("Q12: another tenant can neither create in A nor attach A's PMO to its own project", async () => {
  const beforeA = await workspaceCount(fx.workspaces.A);
  const beforeB = await workspaceCount(fx.workspaces.B);
  const { data: pmoA, error } = await fx.admin.from("pmos").insert({ workspace_id: fx.workspaces.A, name: `q12 A pmo ${fx.tag}`, created_by_user_id: fx.users.aOwner.id }).select("id").single();
  if (error) throw new Error(`[security-regression] pmo fixture: ${error.message}`);

  actAs(sessions.owner);
  const target = await commandCenterCreate(fx.workspaces.A, `q12 cross cc ${fx.tag}`);
  assert.ok(target.startsWith("/workspaces?error="), target);
  const wizard = await quietly(() => saveProjectOnboarding(failingWizardPayload(`q12 cross wizard ${fx.tag}`), `q12x-${fx.tag}`, { workspaceId: fx.workspaces.A }));
  assert.equal(wizard.failureClass, "target_workspace_not_writable");
  const api = await createProjectPost(
    new Request("http://127.0.0.1:3000/api/projects", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: `q12 cross api ${fx.tag}`, pmoId: pmoA.id }) }),
  );
  assert.equal(api.status, 400);

  assert.deepEqual(await engineCreate(fx.users.bOwner.id, `q12 into A ${fx.tag}`, { workspaceId: fx.workspaces.A }), { ok: false, reason: "insufficient_role" });
  assert.deepEqual(await engineCreate(fx.users.bOwner.id, `q12 A pmo in B ${fx.tag}`, { pmoId: pmoA.id }), { ok: false, reason: "pmo_not_found" });
  assert.equal(await workspaceCount(fx.workspaces.A), beforeA);
  assert.equal(await workspaceCount(fx.workspaces.B), beforeB);
});

test("Q12: a paid plan keeps creating and duplicating in parallel beyond the Free limit", async () => {
  // Tenant A's owner carries the fixture's simulated Pro subscription (limit 25).
  actAs(sessions.aOwner);
  const before = await ownedCount(fx.users.aOwner.id);
  const results = await Promise.all([
    ...Array.from({ length: 6 }, (_, i) => createViaApi(`q12 paid ${i} ${fx.tag}`).then((r) => r.status)),
    ...Array.from({ length: 2 }, () =>
      duplicateProjectWithinLimit({ actorUserId: fx.users.aOwner.id, workspaceId: fx.workspaces.A, sourceProjectId: fx.projects.A, targetPmoId: null }).then((r) => (r.ok ? 201 : r.reason)),
    ),
  ]);
  assert.deepEqual(results, Array(8).fill(201));
  assert.equal(await ownedCount(fx.users.aOwner.id), before + 8);
});
