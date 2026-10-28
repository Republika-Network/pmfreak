/**
 * F5 — "use server" actions that wrote with the service role and never checked the
 * caller's workspace role (remediated by PR-3).
 *
 * `savePmoTenant` (src/lib/pmo/save-pmo-tenant.ts) upserts workspace_governance, renames the
 * workspace and records `data_owner`; `saveTeamInvites` (src/lib/pmo/save-team-invites.ts)
 * inserts pmo_team_invites; `saveWorkspaceGovernance` (src/lib/pmo/save-workspace-governance.ts)
 * upserts workspace_governance. Each now requires an owner/admin membership in the resolved
 * workspace (requireWorkspaceRole, read from workspace_memberships) BEFORE its service-role
 * write; savePmoTenant only records data_owner while it is unset, and saveTeamInvites only
 * accepts roles / domain foci from the closed PMO sets.
 *
 * Every export of a "use server" module is directly invocable by any signed-in client, so
 * these run exactly as Next would run them: real code, real service-role client, real local
 * database; only the cookie transport is replaced. Each B-tenant user (owner, admin, pm,
 * viewer) has a single membership, so workspace resolution lands on B.
 *
 * Denials are checked against a full snapshot of everything the actions can write, so a
 * refused call can never pass while leaving a partial write behind.
 */
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { bindAppEnvToHarness, createTenantFixtures, requireHarnessEnv } from "./support/harness.mjs";
import { actAs, installAppRouteMocks } from "./support/app-route-mocks.mjs";

const env = requireHarnessEnv();
bindAppEnvToHarness(env);
installAppRouteMocks();

const { savePmoTenant } = await import("../../src/lib/pmo/save-pmo-tenant.ts");
const { saveTeamInvites } = await import("../../src/lib/pmo/save-team-invites.ts");
const { saveWorkspaceGovernance } = await import("../../src/lib/pmo/save-workspace-governance.ts");

let fx;
let viewer;
let pm;
let admin;
let owner;
let originalWorkspace;

const tenantPayload = (pmoName) => {
  const now = new Date().toISOString();
  return {
    identity: { pmoName, organizationName: "Harness Org", pmoType: "company_pmo", operatingModel: "centralized" },
    vault: { provider: "pmfreak-cloud", label: "Harness vault" },
    governance: { methodology: "hybrid", reportingCadence: "weekly", projectScale: "small", approvalGovernance: "lightweight" },
    agents: [{ agentId: "scope", enabled: true }],
    contextSeed: { strategicObjective: "harness", deliveryChallenges: [], successDefinition: "harness" },
    createdAt: now,
    updatedAt: now,
  };
};

const workspaceB = async () => {
  const { data } = await fx.admin.from("workspaces").select("name, data_owner").eq("id", fx.workspaces.B).single().throwOnError();
  return data;
};

// Everything savePmoTenant / saveTeamInvites / saveWorkspaceGovernance can write for tenant B.
const tenantBState = async () => {
  const { data: workspace } = await fx.admin
    .from("workspaces")
    .select("name, data_owner, command_center_type, owner_type, source_context")
    .eq("id", fx.workspaces.B)
    .single()
    .throwOnError();
  const { data: governance } = await fx.admin
    .from("workspace_governance")
    .select("schema_version, governance_jsonb, status, updated_at")
    .eq("workspace_id", fx.workspaces.B)
    .throwOnError();
  const { data: invites } = await fx.admin.from("pmo_team_invites").select("id, email, role").eq("workspace_id", fx.workspaces.B).order("id").throwOnError();
  const { data: pmos } = await fx.admin.from("pmos").select("id, name").eq("workspace_id", fx.workspaces.B).order("id").throwOnError();
  return { workspace, governance, invites, pmos };
};

before(async () => {
  fx = await createTenantFixtures(env, { label: "f5" });
  viewer = await fx.signIn(fx.users.bViewer);
  pm = await fx.signIn(fx.users.bPm);
  admin = await fx.signIn(fx.users.bAdmin);
  owner = await fx.signIn(fx.users.bOwner);
  originalWorkspace = await workspaceB();
});

after(async () => {
  if (fx) await fx.teardown();
});

test("F5: a viewer cannot reconfigure, rename or take data ownership of the workspace via savePmoTenant", async () => {
  actAs(viewer);
  const result = await savePmoTenant(tenantPayload(`viewer-takeover-${fx.tag}`));
  const current = await workspaceB();
  const { data: governance } = await fx.admin.from("workspace_governance").select("workspace_id").eq("workspace_id", fx.workspaces.B);
  assert.notEqual(result.status, "success", "savePmoTenant succeeded for a viewer");
  assert.equal(current.name, originalWorkspace.name, "viewer renamed the workspace");
  assert.notEqual(current.data_owner, fx.users.bViewer.id, "viewer became the workspace data_owner");
  assert.equal(governance.length, 0, "viewer wrote workspace_governance");
});

test("F5: a viewer cannot create PMO team invites via saveTeamInvites", async () => {
  actAs(viewer);
  const invitee = `sec-invitee-${fx.tag}@example.test`;
  const result = await saveTeamInvites([{ email: invitee, role: "PMO_ADMIN", domainFocus: [] }]);
  const { data: rows } = await fx.admin.from("pmo_team_invites").select("id").eq("email", invitee);
  assert.equal(result.ok, false, "saveTeamInvites succeeded for a viewer");
  assert.equal(rows.length, 0, "viewer inserted a pmo_team_invites row");
});

test("PR-3: a pm cannot activate the PMO before it exists, and nothing is written", async () => {
  const snapshot = await tenantBState();
  actAs(pm);
  const result = await savePmoTenant(tenantPayload(`pm-takeover-${fx.tag}`));
  assert.equal(result.status, "fatal_failure");
  assert.equal(result.failureClass, "forbidden");
  assert.deepEqual(await tenantBState(), snapshot, "a refused pm activation changed tenant B");
});

test("control: the workspace owner can still activate the PMO via savePmoTenant", async () => {
  actAs(owner);
  const result = await savePmoTenant(tenantPayload(`owner-activation-${fx.tag}`));
  assert.equal(result.status, "success", `owner activation failed: ${result.status}`);
  const { data: governance } = await fx.admin.from("workspace_governance").select("workspace_id").eq("workspace_id", fx.workspaces.B);
  assert.equal(governance.length, 1);
  const current = await workspaceB();
  assert.equal(current.name, `owner-activation-${fx.tag}`);
  assert.equal(current.data_owner, fx.users.bOwner.id, "first activation did not record the activating owner as data_owner");
});

test("PR-3: neither a viewer nor a pm can re-activate, rename or reconfigure an activated workspace", async () => {
  const snapshot = await tenantBState();
  for (const [label, client] of [["viewer", viewer], ["pm", pm]]) {
    actAs(client);
    const result = await savePmoTenant(tenantPayload(`${label}-rename-${fx.tag}`));
    assert.equal(result.status, "fatal_failure", `${label} re-activation was not refused`);
    assert.equal(result.failureClass, "forbidden");
  }
  assert.deepEqual(await tenantBState(), snapshot, "a refused re-activation changed tenant B");
});

test("PR-3: neither a viewer nor a pm can create PMO team invites, and nothing is written", async () => {
  const snapshot = await tenantBState();
  for (const [label, client] of [["viewer", viewer], ["pm", pm]]) {
    actAs(client);
    const result = await saveTeamInvites([{ email: `${label}-invitee-${fx.tag}@example.test`, role: "PMO_OWNER", domainFocus: ["scope"] }]);
    assert.equal(result.ok, false, `saveTeamInvites succeeded for a ${label}`);
  }
  assert.deepEqual(await tenantBState(), snapshot, "a refused invite changed tenant B");
});

test("PR-3: neither a viewer nor a pm can change workspace governance via saveWorkspaceGovernance", async () => {
  const snapshot = await tenantBState();
  for (const [label, client] of [["viewer", viewer], ["pm", pm]]) {
    actAs(client);
    const result = await saveWorkspaceGovernance({ injectedBy: label });
    assert.equal(result.ok, false, `saveWorkspaceGovernance succeeded for a ${label}`);
  }
  assert.deepEqual(await tenantBState(), snapshot, "a refused governance write changed tenant B");
});

test("control: an admin can re-activate and rename the PMO; data_owner is not transferred", async () => {
  actAs(admin);
  const result = await savePmoTenant(tenantPayload(`admin-reactivation-${fx.tag}`));
  assert.equal(result.status, "success", `admin re-activation failed: ${result.status}`);
  const current = await workspaceB();
  assert.equal(current.name, `admin-reactivation-${fx.tag}`);
  assert.equal(current.data_owner, fx.users.bOwner.id, "re-activation transferred data_owner to the admin");
});

test("control: an admin can create PMO team invites with valid roles", async () => {
  actAs(admin);
  const invitee = `admin-invitee-${fx.tag}@example.test`;
  const result = await saveTeamInvites([{ email: invitee, role: "PROJECT_MANAGER", domainFocus: ["scope", "timeline"] }]);
  assert.deepEqual(result, { ok: true, savedCount: 1 });
  const { data: rows } = await fx.admin.from("pmo_team_invites").select("role, invited_by_user_id, workspace_id").eq("email", invitee).throwOnError();
  assert.deepEqual(rows, [{ role: "PROJECT_MANAGER", invited_by_user_id: fx.users.bAdmin.id, workspace_id: fx.workspaces.B }]);
});

test("PR-3: invite roles and domain foci outside the closed PMO sets are rejected, even for an admin", async () => {
  const snapshot = await tenantBState();
  actAs(admin);
  const badRole = await saveTeamInvites([{ email: `bad-role-${fx.tag}@example.test`, role: "SUPERUSER", domainFocus: [] }]);
  assert.equal(badRole.ok, false, "an unknown invite role was accepted");
  const badFocus = await saveTeamInvites([{ email: `bad-focus-${fx.tag}@example.test`, role: "VIEWER", domainFocus: ["billing"] }]);
  assert.equal(badFocus.ok, false, "an unknown domain focus was accepted");
  assert.deepEqual(await tenantBState(), snapshot, "a rejected invite batch changed tenant B");
});

test("control: an admin can save workspace governance via saveWorkspaceGovernance", async () => {
  actAs(admin);
  const result = await saveWorkspaceGovernance({ savedBy: "admin", tag: fx.tag });
  assert.deepEqual(result, { ok: true });
  const { data } = await fx.admin.from("workspace_governance").select("governance_jsonb").eq("workspace_id", fx.workspaces.B).single().throwOnError();
  assert.deepEqual(data.governance_jsonb, { savedBy: "admin", tag: fx.tag });
});
