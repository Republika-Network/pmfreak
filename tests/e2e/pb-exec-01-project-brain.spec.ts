/**
 * PB-EXEC-01 — authenticated browser scenario: Recommendation → Prepare execution brief →
 * renderer → copy. Nothing is executed.
 *
 * Real sign-in, the real conversation surface, the real turn route (governance, entitlement,
 * operation identity, target resolution), the real context builder, grounding, assembly and
 * persistence, against the DISPOSABLE LOCAL Supabase stack. The model is the verification-only
 * stub scripts/pb-exec-01/openai-stub.mjs (replaces only the HTTP call to api.openai.com).
 *
 *   NODE_OPTIONS="--import ./scripts/pb-exec-01/openai-stub.mjs" OPENAI_API_KEY=sk-local-stub-not-a-key \
 *   PB_CHAT_STUB_LOG=<file> PMFREAK_OPERATING_PROFILE=closed-free-beta npx next dev -p 3417
 *   OPERATIONAL_FLOW_TEST_BASE_URL=http://localhost:3417 PB_CHAT_STUB_LOG=<file> \
 *   npx playwright test tests/e2e/pb-exec-01-project-brain.spec.ts
 */
import { expect, test, type Page } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";

const supabaseUrl = process.env.OPERATIONAL_FLOW_TEST_SUPABASE_URL ?? "";
const serviceRoleKey = process.env.OPERATIONAL_FLOW_TEST_SERVICE_ROLE_KEY ?? "";
const stubLog = process.env.PB_CHAT_STUB_LOG ?? "";
const SHOTS = process.env.PB_SHOTS_DIR ?? "artifacts/pb-exec-01/screenshots";
const password = `PB-EXEC-01-${randomUUID()}!`;
const suffix = `${Date.now()}-${randomUUID().slice(0, 6)}`;
const admin = createClient(supabaseUrl || "http://127.0.0.1:54321", serviceRoleKey || "missing", { auth: { persistSession: false, autoRefreshToken: false } });

const t: { workspaceId: string; projectId: string; email: string; userId: string } = {} as never;

function must<T>(result: { data: T; error: { message: string } | null }, label: string): NonNullable<T> {
  if (result.error || result.data === null || result.data === undefined) throw new Error(`${label}: ${result.error?.message ?? "no data"}`);
  return result.data as NonNullable<T>;
}
function ok(result: { error: { message: string } | null }, label: string) {
  if (result.error) throw new Error(`${label}: ${result.error.message}`);
}

/** Same tenant shape as the PB-CHAT-01 scenario (seeded demo chain + active trial). */
async function seedTenant() {
  const email = `pb-exec-01-${suffix}@example.test`;
  const created = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (created.error) throw new Error(created.error.message);
  const userId = created.data.user!.id;
  const workspaceId = randomUUID();
  ok(await admin.from("workspaces").insert({ id: workspaceId, name: `PB-EXEC-01 ${suffix}`, created_by_user_id: userId }), "workspace");
  ok(await admin.from("workspace_memberships").insert({ workspace_id: workspaceId, user_id: userId, role: "owner" }), "membership");
  const inviteId = randomUUID();
  const trialEnd = new Date(Date.now() + 365 * 86_400_000).toISOString();
  ok(await admin.from("early_access_invites").insert({
    id: inviteId, invite_email: email, invite_token_hash: createHash("sha256").update(`pb-exec-01-consumed:${inviteId}`).digest("hex"),
    invite_note: "PB-EXEC-01 browser scenario", inviter_user_id: userId, expires_at: trialEnd, accepted_at: new Date().toISOString(),
    requires_approval: false, workspace_id: workspaceId,
  }), "invite");
  ok(await admin.from("trial_licenses").insert({ id: randomUUID(), invite_id: inviteId, workspace_id: workspaceId, trial_start_at: new Date().toISOString(), trial_end_at: trialEnd, trial_status: "active" }), "trial");
  const seeded = spawnSync(process.execPath, ["scripts/seed-operational-flow-demo.mjs", workspaceId, userId], {
    encoding: "utf8",
    env: { ...process.env, NEXT_PUBLIC_SUPABASE_URL: supabaseUrl, SUPABASE_SERVICE_ROLE_KEY: serviceRoleKey },
  });
  if (seeded.status !== 0) throw new Error(`seed failed: ${seeded.stderr}`);
  const projectId = must(await admin.from("projects").select("id").eq("workspace_id", workspaceId).limit(1).single(), "project").id as string;
  ok(await admin.from("projects").update({ name: `Exec ${suffix}`, onboarding_payload: { demoScenarioKey: "client_scope_alignment_v1", demo: true, initialIngestion: { status: "completed" } } }).eq("id", projectId), "project payload");
  return { workspaceId, projectId, email, userId };
}

const PROJECT_STATE_TABLES = [
  "operational_sources", "operational_raw_inputs", "operational_normalized_events", "evidence_items", "operational_signals", "risk_issue_records", "governance_events",
  "recommended_actions", "operational_decision_records", "material_action_proposals", "execution_tasks", "canonical_task_outcomes", "canonical_outcome_observations", "raid_items",
];
const EXECUTION_TABLES = ["agent_execution_requests", "agent_execution_events", "governance_execution_grants"];
async function stateCounts() {
  const counts: Record<string, number | string> = {};
  for (const table of [...PROJECT_STATE_TABLES, ...EXECUTION_TABLES]) {
    const { count, error } = await admin.from(table).select("*", { count: "exact", head: true }).eq("workspace_id", t.workspaceId);
    counts[table] = error ? "unavailable" : count ?? 0;
  }
  const { count } = await admin.from("project_memories").select("*", { count: "exact", head: true });
  counts.project_memories = count ?? "unavailable";
  counts.projects = JSON.stringify(must(await admin.from("projects").select("id, status, updated_at").eq("workspace_id", t.workspaceId), "projects"));
  return counts;
}
async function messageCount() {
  const conversations = (await admin.from("context_conversations").select("id").eq("project_id", t.projectId).eq("context_type", "project")).data ?? [];
  if (conversations.length === 0) return { conversations: 0, messages: 0 };
  const { count } = await admin.from("context_messages").select("*", { count: "exact", head: true }).eq("conversation_id", conversations[0].id);
  return { conversations: conversations.length, messages: count ?? 0 };
}
async function usage(operation: string) {
  const { count } = await admin.from("ai_usage_events").select("*", { count: "exact", head: true }).eq("workspace_id", t.workspaceId).eq("operation", operation);
  return count ?? 0;
}
const stubCalls = () => (stubLog && existsSync(stubLog) ? readFileSync(stubLog, "utf8").trim().split("\n").filter(Boolean).length : 0);

async function signIn(page: Page) {
  await page.goto("/login");
  await page.getByPlaceholder("Email").fill(t.email);
  await page.getByPlaceholder("Password").fill(password);
  await Promise.all([page.waitForURL((url) => !url.pathname.startsWith("/login"), { timeout: 45_000 }), page.getByRole("button", { name: "Continue" }).click()]);
}
const brain = (page: Page) => page.getByTestId("project-brain-conversation").first();
async function openBrain(page: Page) {
  await page.goto(`/workspaces/${t.workspaceId}/projects/${t.projectId}`);
  await expect(brain(page)).toHaveAttribute("data-project-id", t.projectId);
  await expect(brain(page).getByText(/Loading this project/)).toHaveCount(0, { timeout: 45_000 });
}
async function ask(page: Page, text: string) {
  const before = await brain(page).getByTestId("project-brain-assistant-message").count();
  await brain(page).getByTestId("project-brain-input").fill(text);
  await brain(page).getByTestId("project-brain-input").press("Enter");
  await expect(brain(page).getByTestId("project-brain-assistant-message")).toHaveCount(before + 1, { timeout: 60_000 });
  return brain(page).getByTestId("project-brain-assistant-message").last();
}
async function shot(page: Page, name: string) {
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: false });
}

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  test.skip(!supabaseUrl || !serviceRoleKey, "requires the disposable local stack");
  Object.assign(t, await seedTenant());
});

test("EX-A: Recommendation → Prepare execution brief → card → Claude/Codex → copy; nothing executed, nothing written but the conversation", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await signIn(page);
  await openBrain(page);
  const baseline = await stateCounts();
  const answer = await ask(page, "What should I work on next? [recommend-one]");
  await expect(answer).toContainText("I recommend");
  const prepare = answer.getByTestId("project-brain-prepare-brief");
  await expect(prepare).toHaveCount(1);
  await shot(page, "ex-a-01-recommendation");

  const callsBefore = stubCalls();
  const turnsRequests: string[] = [];
  page.on("request", (r) => { if (r.url().includes("/brain/turns") && r.method() === "POST") turnsRequests.push(r.postData() ?? ""); });
  const before = await brain(page).getByTestId("project-brain-assistant-message").count();
  await prepare.click();
  await expect(brain(page).getByTestId("project-brain-assistant-message")).toHaveCount(before + 1, { timeout: 60_000 });
  const reply = brain(page).getByTestId("project-brain-assistant-message").last();
  const card = reply.getByTestId("execution-brief-card");
  await expect(card).toBeVisible();
  await expect(card.getByTestId("execution-brief-banner")).toHaveText(/AI-generated · manual handoff · not an authorization to execute, merge or deploy/);
  await expect(card.getByTestId("execution-brief-readiness")).toHaveText(/Handoff ready|Needs input/);
  // The stub invented a file path in "out of scope": removed whole, and the customer is told.
  await expect(card.getByTestId("execution-brief-grounding-notice")).toBeVisible();
  await expect(card).not.toContainText("src/stub-invented");
  // No control executes, sends, delegates, opens a PR, merges or deploys.
  await expect(brain(page).getByRole("button", { name: /Run with|Send to|^Execute|Delegate|Open PR|^Merge|^Deploy/ })).toHaveCount(0);
  expect(JSON.parse(turnsRequests[0])).toMatchObject({ intent: "execution_brief", targetRef: { kind: "project_brain_recommendation" } });
  expect(turnsRequests[0]).not.toContain("renderFor");
  if (stubLog) expect(stubCalls()).toBe(callsBefore + 1);
  await shot(page, "ex-a-02-brief-card");

  // Renderer switch and copy: no request, no inference, no write.
  const writesBefore = await messageCount();
  const requestsBefore = turnsRequests.length;
  for (const label of ["Claude Code", "Codex", "Generic"]) {
    await card.getByText(label, { exact: true }).click();
    await card.getByTestId("execution-brief-copy").click();
    await expect(card.getByTestId("execution-brief-copy-status")).toContainText(`Copied — formatted for ${label}`);
    const clip = await page.evaluate(() => navigator.clipboard.readText());
    expect(clip).toMatch(/AI-generated by PMFreak Project Brain · manual handoff · NOT an authorization to execute, merge or deploy/);
    expect(clip).toMatch(/DO NOT MERGE\. DO NOT DEPLOY\./);
    expect(clip).not.toContain("npm test"); // a model-authored command never survives
    expect(clip).not.toContain("src/stub-invented");
  }
  expect(turnsRequests.length).toBe(requestsBefore);
  expect(await messageCount()).toEqual(writesBefore);
  if (stubLog) expect(stubCalls()).toBe(callsBefore + 1);
  await shot(page, "ex-a-03-copied");

  // Sources & verification still opens natively.
  await reply.getByTestId("project-brain-answer-details-summary").click();
  await expect(reply.getByTestId("project-brain-answer-details-panel")).toBeVisible();

  // Persistence: one brief, stable ids, no alias, unauthorized; usage attributed to the brief operation.
  const transcript = await (await page.request.get(`/api/projects/${t.projectId}/brain/turns`)).json();
  const last = transcript.messages[transcript.messages.length - 1];
  const brief = last.brain.executionBrief;
  expect(brief.handoff).toMatchObject({ mode: "manual", executionAuthorized: false, delegationEligible: false });
  expect(JSON.stringify(brief)).not.toMatch(/"[SR]\d+"/);
  expect(brief.identity.generator.operation).toBe("project_brain.execution_brief");
  expect(JSON.stringify(last)).not.toContain('"metadata"');
  expect(await usage("project_brain.execution_brief")).toBe(1);
  expect(await stateCounts()).toEqual(baseline);
});

test("EX-B: several recommendations → each control targets exactly its own statement", async ({ page }) => {
  await signIn(page);
  await openBrain(page);
  const answer = await ask(page, "What should I work on next? [recommend]");
  const controls = answer.getByTestId("project-brain-prepare-brief");
  await expect(controls).toHaveCount(2);
  const wanted = await controls.nth(1).getAttribute("data-statement-id");
  const before = await brain(page).getByTestId("project-brain-assistant-message").count();
  await controls.nth(1).click();
  await expect(brain(page).getByTestId("project-brain-assistant-message")).toHaveCount(before + 1, { timeout: 60_000 });
  const transcript = await (await page.request.get(`/api/projects/${t.projectId}/brain/turns`)).json();
  const brief = transcript.messages[transcript.messages.length - 1].brain.executionBrief;
  expect(brief.targetRef).toMatchObject({ kind: "project_brain_recommendation", statementId: wanted, resolvedBy: "explicit" });
});

test("EX-C: 'prepare it for Claude' with two candidates → choose one; nothing persisted until the choice", async ({ page }) => {
  await signIn(page);
  await openBrain(page);
  await ask(page, "Anything else to work on? [recommend]");
  const callsBefore = stubCalls();
  const writesBefore = await messageCount();
  const usageBefore = await usage("project_brain.execution_brief");
  await brain(page).getByTestId("project-brain-input").fill("prepare it for Claude");
  await brain(page).getByTestId("project-brain-input").press("Enter");
  const chooser = brain(page).getByTestId("project-brain-needs-target");
  await expect(chooser).toBeVisible({ timeout: 30_000 });
  await expect(chooser).toContainText("You asked: “prepare it for Claude”");
  await expect(chooser.getByTestId("project-brain-needs-target-choice")).toHaveCount(2);
  expect(await messageCount()).toEqual(writesBefore);
  expect(await usage("project_brain.execution_brief")).toBe(usageBefore);
  if (stubLog) expect(stubCalls()).toBe(callsBefore);
  await shot(page, "ex-c-01-needs-target");
  const before = await brain(page).getByTestId("project-brain-assistant-message").count();
  await chooser.getByTestId("project-brain-needs-target-choice").first().click();
  await expect(brain(page).getByTestId("project-brain-assistant-message")).toHaveCount(before + 1, { timeout: 60_000 });
  const card = brain(page).getByTestId("project-brain-assistant-message").last().getByTestId("execution-brief-card");
  await expect(card).toBeVisible();
  await expect(card.getByTestId("execution-brief-renderer-claude_code")).toBeChecked(); // phrase preference, local only
  if (stubLog) expect(stubCalls()).toBe(callsBefore + 1);
});

test("EX-D: on a phone-width viewport the brief card fits and stays operable", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await signIn(page);
  await openBrain(page);
  const card = brain(page).getByTestId("execution-brief-card").last();
  await card.scrollIntoViewIfNeeded();
  await expect(card).toBeVisible();
  await card.getByTestId("execution-brief-preview").locator("summary").click();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  await expect(card.getByTestId("execution-brief-copy")).toBeVisible();
  await card.getByTestId("execution-brief-renderer-codex").focus();
  await page.keyboard.press("Space");
  await expect(card.getByTestId("execution-brief-renderer-codex")).toBeChecked();
  await shot(page, "ex-d-01-mobile");
});

test("EX-E: the API refuses an invalid target (400) and a reused id with another operation (409), writing nothing", async ({ page }) => {
  await signIn(page);
  await openBrain(page);
  const writesBefore = await messageCount();
  const invalid = await page.request.post(`/api/projects/${t.projectId}/brain/turns`, {
    data: { clientMessageId: randomUUID(), text: "Prepare an execution brief for the selected recommendation.", intent: "execution_brief", targetRef: { kind: "project_brain_recommendation", assistantTurnId: randomUUID(), statementId: "x:0" } },
  });
  expect(invalid.status()).toBe(400);
  expect((await invalid.json()).code).toBe("invalid_execution_target");
  for (const extra of [{ renderFor: "codex" }, { metadata: { projectBrainRequest: {} } }, { workspaceId: t.workspaceId }]) {
    const res = await page.request.post(`/api/projects/${t.projectId}/brain/turns`, { data: { clientMessageId: randomUUID(), text: "hi", ...extra } });
    expect(res.status()).toBe(400);
  }
  expect(await messageCount()).toEqual(writesBefore);
  const id = randomUUID();
  const first = await page.request.post(`/api/projects/${t.projectId}/brain/turns`, { data: { clientMessageId: id, text: "Where are we?" } });
  expect(first.status()).toBe(200);
  const reuse = await page.request.post(`/api/projects/${t.projectId}/brain/turns`, { data: { clientMessageId: id, text: "Where are we?", intent: "execution_brief" } });
  expect(reuse.status()).toBe(409);
  expect((await reuse.json()).code).toBe("client_message_id_reused_with_different_operation");
});
