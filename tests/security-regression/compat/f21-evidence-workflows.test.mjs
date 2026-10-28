/**
 * F21 product compatibility — pm happy paths that run the operational evidence chain.
 *
 * MANUAL, NOT PART OF `npm run test:security-regression` (its glob does not descend into
 * compat/). The project wizard (saveProjectOnboarding) and the Command Center empty state
 * (activateContextAction) ingest setup context and derive append-only evidence_items, which
 * only a SQL session can remove — this PostgREST-only harness cannot tear them down. Run it
 * against a disposable stack and reset the stack afterwards:
 *
 *   SECURITY_HARNESS_SUPABASE_URL=... SECURITY_HARNESS_ANON_KEY=... SECURITY_HARNESS_SERVICE_ROLE_KEY=... \
 *     npx tsx --experimental-test-module-mocks --test tests/security-regression/compat/f21-evidence-workflows.test.mjs
 *   npx supabase db reset --local
 *
 * It proves that, under the role-aware RLS, a pm (not only an owner) completes both flows
 * through the user's own RLS client: project insert, vault ingestion, RAID materialization and
 * the evidence chain.
 */
import test, { before } from "node:test";
import assert from "node:assert/strict";
import { bindAppEnvToHarness, createTenantFixtures, requireHarnessEnv } from "../support/harness.mjs";
import { actAs, installAppRouteMocks } from "../support/app-route-mocks.mjs";

const env = requireHarnessEnv();
bindAppEnvToHarness(env);
installAppRouteMocks();

const { saveProjectOnboarding } = await import("../../../src/lib/projects/save-project-onboarding.ts");
const { activateContextAction } = await import("../../../src/app/(protected)/command-center/actions.ts");

let fx;
let pm;

before(async () => {
  fx = await createTenantFixtures(env, { label: "f21compat" });
  pm = await fx.signIn(fx.users.bPm);
});

const onboardingPayload = (name) => ({
  identity: { projectName: name, clientOrganization: "Harness Client", projectType: "implementation", pmAssigned: "Harness PM", technicalLead: "", targetDeliveryDate: "" },
  deliveryContext: { problemStatement: "Migrate the billing platform before the contract renewal.", mainDeliverable: "Migrated platform", externalDependencies: "Vendor API access is still pending." },
  discovery: { unknowns: "Data volume is unknown." },
});

const countFor = async (table, column, value) => {
  const { count, error } = await fx.admin.from(table).select("id", { count: "exact", head: true }).eq(column, value);
  if (error) throw new Error(`[f21-compat] count ${table}: ${error.message}`);
  return count;
};

test("pm completes the project wizard: project, vault ingestion, RAID items and evidence through the user client", async (t) => {
  actAs(pm);
  const result = await saveProjectOnboarding(onboardingPayload(`pm wizard project ${fx.tag}`), `f21c-${fx.tag}`, { workspaceId: fx.workspaces.B });
  assert.equal(result.status, "success", JSON.stringify(result));
  assert.equal(result.workspaceId, fx.workspaces.B);
  const docs = await countFor("vault_documents", "project_id", result.projectId);
  const raid = await countFor("raid_items", "project_id", result.projectId);
  const evidence = await countFor("evidence_items", "project_id", result.projectId);
  assert.ok(docs >= 1, "setup context was ingested into the vault");
  t.diagnostic(`wizard as pm: vault_documents=${docs} raid_items=${raid} evidence_items=${evidence} brief=${result.briefStatus}`);
});

test("pm activates a project from the Command Center empty state", async (t) => {
  const data = new FormData();
  data.set("name", `pm command center ${fx.tag}`);
  data.set("description", "harness");
  data.set("risk", "The vendor may miss the API delivery date.");
  actAs(pm);
  let target = null;
  try {
    await activateContextAction(fx.workspaces.B, data);
  } catch (error) {
    const digest = String(error?.digest ?? "");
    if (!digest.startsWith("NEXT_REDIRECT")) throw error;
    target = digest.split(";")[2];
  }
  assert.ok(target, "the action redirects on completion");
  assert.doesNotMatch(decodeURIComponent(target.replace(/\+/g, " ")), /error=/, `activation reported an error: ${target}`);
  const { data: rows } = await fx.admin.from("projects").select("id").eq("user_id", fx.users.bPm.id).eq("name", `pm command center ${fx.tag}`);
  assert.equal(rows.length, 1, "pm project was created");
  t.diagnostic(`command center as pm → ${target}`);
});
