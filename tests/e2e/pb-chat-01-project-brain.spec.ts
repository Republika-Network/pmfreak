/**
 * PB-CHAT-01 — authenticated browser scenario for the unified Project Brain conversation.
 *
 * Real sign-in through /login, the real Command Center, the real turn route, the real
 * context builder and provider router, against a DISPOSABLE LOCAL Supabase stack. The
 * service-role client only seeds tenants and reads counts for assertions; every
 * conversation write under test is made by the signed-in PM through the UI.
 *
 * The model: this environment has no OpenAI key, so the dev server is started with the
 * verification-only preload scripts/pb-chat-01/openai-stub.mjs, which replaces ONLY the
 * HTTP call to api.openai.com. Everything else — including strict output parsing and
 * citation validation — is the product. Stub replies are prefixed "[stub model]".
 *
 * Run (disposable stack + dev server on the same env):
 *   OPERATIONAL_FLOW_TEST_SUPABASE_URL=... OPERATIONAL_FLOW_TEST_SERVICE_ROLE_KEY=...
 *   OPERATIONAL_FLOW_TEST_BASE_URL=http://localhost:3417 PB_CHAT_STUB_LOG=<file> \
 *   npx playwright test tests/e2e/pb-chat-01-project-brain.spec.ts
 */
import { expect, test, type Page } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";

const supabaseUrl = process.env.OPERATIONAL_FLOW_TEST_SUPABASE_URL ?? "";
const serviceRoleKey = process.env.OPERATIONAL_FLOW_TEST_SERVICE_ROLE_KEY ?? "";
const stubLog = process.env.PB_CHAT_STUB_LOG ?? "";
const SHOTS = "artifacts/pb-chat-01/screenshots";
const password = `PB-CHAT-01-${randomUUID()}!`;
const suffix = `${Date.now()}-${randomUUID().slice(0, 6)}`;

const admin = createClient(supabaseUrl || "http://127.0.0.1:54321", serviceRoleKey || "missing", { auth: { persistSession: false, autoRefreshToken: false } });

type Tenant = { workspaceId: string; projectA: string; projectB: string; email: string; userId: string };
const t: { main: Tenant; other: Tenant } = {} as never;

function must<T>(result: { data: T; error: { message: string } | null }, label: string): NonNullable<T> {
  if (result.error || result.data === null || result.data === undefined) throw new Error(`${label}: ${result.error?.message ?? "no data"}`);
  return result.data as NonNullable<T>;
}

function ok(result: { error: { message: string } | null }, label: string): void {
  if (result.error) throw new Error(`${label}: ${result.error.message}`);
}

async function seedTenant(label: string): Promise<Tenant> {
  const email = `pb-chat-01-${label}-${suffix}@example.test`;
  const created = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (created.error) throw new Error(created.error.message);
  const userId = created.data.user!.id;
  const workspaceId = randomUUID();
  ok(await admin.from("workspaces").insert({ id: workspaceId, name: `PB-CHAT-01 ${label} ${suffix}`, created_by_user_id: userId }), "workspace");
  ok(await admin.from("workspace_memberships").insert({ workspace_id: workspaceId, user_id: userId, role: "owner" }), "membership");
  // The protected layout gates on an active trial (same seed shape as the P2-16 scenario).
  const inviteId = randomUUID();
  const trialEnd = new Date(Date.now() + 365 * 86_400_000).toISOString();
  ok(await admin.from("early_access_invites").insert({
    id: inviteId, invite_email: email, invite_token_hash: createHash("sha256").update(`pb-chat-01-consumed:${inviteId}`).digest("hex"),
    invite_note: "PB-CHAT-01 browser scenario", inviter_user_id: userId, expires_at: trialEnd, accepted_at: new Date().toISOString(),
    requires_approval: false, workspace_id: workspaceId,
  }), "invite");
  ok(await admin.from("trial_licenses").insert({ id: randomUUID(), invite_id: inviteId, workspace_id: workspaceId, trial_start_at: new Date().toISOString(), trial_end_at: trialEnd, trial_status: "active" }), "trial");

  // Project A: the canonical evidence → signal → risk/issue → recommendation → decision chain,
  // seeded by the repository's own demo seeder.
  const seeded = spawnSync(process.execPath, ["scripts/seed-operational-flow-demo.mjs", workspaceId, userId], {
    encoding: "utf8",
    env: { ...process.env, NEXT_PUBLIC_SUPABASE_URL: supabaseUrl, SUPABASE_SERVICE_ROLE_KEY: serviceRoleKey },
  });
  if (seeded.status !== 0) throw new Error(`seed failed: ${seeded.stderr}`);
  const projectA = must(await admin.from("projects").select("id").eq("workspace_id", workspaceId).limit(1).single(), "project A").id as string;
  // Past the guided first run, so the Command Center opens on its canvas.
  ok(await admin.from("projects").update({ name: `MPP ${label}`, onboarding_payload: { demoScenarioKey: "client_scope_alignment_v1", demo: true, initialIngestion: { status: "completed" } } }).eq("id", projectA), "project A payload");

  // Project B: a second project in the SAME workspace, with its own distinct records.
  const projectB = randomUUID();
  ok(await admin.from("projects").insert({ id: projectB, workspace_id: workspaceId, user_id: userId, name: `Bravo ${label}`, onboarding_payload: { initialIngestion: { status: "completed" } } }), "project B");
  ok(await admin.from("execution_tasks").insert({ workspace_id: workspaceId, project_id: projectB, title: `BRAVO-ONLY vendor exit task ${label}`, description: "Only project Bravo has this.", status: "blocked", priority: "high" }), "B task");
  ok(await admin.from("project_milestones").insert({ workspace_id: workspaceId, project_id: projectB, title: `Bravo launch ${label}`, status: "planned", milestone_type: "go_live" }), "B milestone");
  return { workspaceId, projectA, projectB, email, userId };
}

const PROJECT_STATE_TABLES = [
  "operational_raw_inputs", "operational_normalized_events", "evidence_items", "risk_issue_records", "recommended_actions",
  "operational_decision_records", "material_action_proposals", "execution_tasks", "canonical_task_outcomes",
];
const MEMORY_TABLES = ["project_memories", "operational_memory_entries", "vault_nutrients", "intervention_memory"];

async function stateCounts(workspaceId: string) {
  const counts: Record<string, number | string> = {};
  for (const table of PROJECT_STATE_TABLES) {
    const { count, error } = await admin.from(table).select("id", { count: "exact", head: true }).eq("workspace_id", workspaceId);
    counts[table] = error ? `error:${error.message}` : count ?? 0;
  }
  for (const table of MEMORY_TABLES) {
    // Memory stores are keyed by company or workspace; count the whole table (disposable DB).
    const { count, error } = await admin.from(table).select("*", { count: "exact", head: true });
    counts[table] = error ? `unavailable` : count ?? 0;
  }
  return counts;
}

const stubCalls = () => (stubLog && existsSync(stubLog) ? readFileSync(stubLog, "utf8").trim().split("\n").filter(Boolean).length : 0);

async function signIn(page: Page, email: string) {
  await page.goto("/login");
  await page.getByPlaceholder("Email").fill(email);
  await page.getByPlaceholder("Password").fill(password);
  await Promise.all([
    page.waitForURL((url) => !url.pathname.startsWith("/login"), { timeout: 45_000 }),
    page.getByRole("button", { name: "Continue" }).click(),
  ]);
  expect(page.url()).not.toContain("/login");
}

const commandCenter = (projectId: string) => `/workspaces/${t.main.workspaceId}/command-center?projectId=${projectId}`;
const brain = (page: Page) => page.getByTestId("project-brain-conversation").first();

async function openBrain(page: Page, projectId: string) {
  await page.goto(commandCenter(projectId));
  await expect(page.getByTestId("cc-section-project-brain")).toBeVisible();
  await expect(brain(page)).toHaveAttribute("data-project-id", projectId);
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
  t.main = await seedTenant("main");
  t.other = await seedTenant("other");
});

test("SIT-A: a project status question gets a grounded answer with validated source chips, and writes no project state", async ({ page }) => {
  await signIn(page, t.main.email);
  await openBrain(page, t.main.projectA);
  // Open by default and first-class: the composer is visible without clicking anything.
  await expect(brain(page).getByTestId("project-brain-input")).toBeVisible();
  await expect(page.getByTestId("chat-determinism-disclosure")).toHaveCount(0);
  await shot(page, "01-project-brain-open-by-default");

  const baseline = await stateCounts(t.main.workspaceId);
  const reply = await ask(page, "What is the current status of this project?");
  await expect(reply).toHaveAttribute("data-mode", "generative");
  await expect(reply).toContainText("[stub model]");
  const chips = reply.locator("[data-source-id]");
  expect(await chips.count()).toBeGreaterThan(0);
  const ids = await chips.evaluateAll((nodes) => nodes.map((n) => n.getAttribute("data-source-id") ?? ""));
  // The stub also cited an invented "S999": it must never render as a source.
  expect(ids.some((id) => id.includes("S999"))).toBe(false);
  for (const id of ids) {
    const [table, recordId] = id.split(":");
    const row = must(await admin.from(table).select(table === "projects" ? "id, workspace_id" : "project_id, workspace_id").eq(table === "projects" ? "id" : "id", recordId).single(), `chip ${id}`) as Record<string, string>;
    expect(row.workspace_id).toBe(t.main.workspaceId);
    expect(table === "projects" ? row.id : row.project_id).toBe(t.main.projectA);
  }
  await expect(reply.getByTestId("project-brain-statements")).toBeVisible();
  await shot(page, "02-grounded-answer-with-sources");
  expect(await stateCounts(t.main.workspaceId)).toEqual(baseline);
});

test("SIT-I: refresh keeps the same transcript — no duplicate conversation, no duplicate messages", async ({ page }) => {
  await signIn(page, t.main.email);
  await openBrain(page, t.main.projectA);
  await expect(brain(page).getByTestId("project-brain-user-message")).toHaveCount(1);
  await page.reload();
  await expect(brain(page).getByTestId("project-brain-user-message")).toHaveCount(1, { timeout: 45_000 });
  await expect(brain(page).getByTestId("project-brain-assistant-message")).toHaveCount(1);
  const conversations = must(await admin.from("context_conversations").select("id").eq("project_id", t.main.projectA).eq("context_type", "project"), "conversations");
  expect(conversations.length).toBe(1);
  const messages = must(await admin.from("context_messages").select("id").eq("conversation_id", conversations[0].id), "messages");
  expect(messages.length).toBe(2);
  await shot(page, "03-after-refresh");
});

test("SIT-H: project switching isolates threads and records; another tenant's project is refused", async ({ page }) => {
  await signIn(page, t.main.email);
  await openBrain(page, t.main.projectB);
  await expect(brain(page).getByTestId("project-brain-user-message")).toHaveCount(0);
  await expect(brain(page).getByText(/Ask Project Brain about Bravo/)).toBeVisible();
  const reply = await ask(page, "Which risks are open?");
  const ids = await reply.locator("[data-source-id]").evaluateAll((nodes) => nodes.map((n) => n.getAttribute("data-source-id") ?? ""));
  for (const id of ids) {
    const [table, recordId] = id.split(":");
    const row = must(await admin.from(table).select(table === "projects" ? "id" : "project_id").eq("id", recordId).single(), `chip ${id}`) as Record<string, string>;
    expect(table === "projects" ? row.id : row.project_id).toBe(t.main.projectB);
  }
  await expect(reply).not.toContainText("Out-of-scope client request");
  await shot(page, "04-project-b-isolated-thread");

  await openBrain(page, t.main.projectA);
  await expect(brain(page).getByTestId("project-brain-user-message")).toHaveCount(1);
  await expect(brain(page).getByText("What is the current status of this project?")).toBeVisible();
  await expect(brain(page).getByText("Which risks are open?")).toHaveCount(0);

  for (const method of ["GET", "POST"] as const) {
    const res = await page.request.fetch(`/api/projects/${t.other.projectA}/brain/turns`, {
      method,
      data: method === "POST" ? { clientMessageId: randomUUID(), text: "leak?" } : undefined,
    });
    expect([403, 404]).toContain(res.status());
    expect(await res.text()).not.toContain("Out-of-scope");
  }
  const anonymous = await (await import("@playwright/test")).request.newContext({ baseURL: page.url().split("/workspaces")[0] });
  const anon = await anonymous.get(`/api/projects/${t.main.projectA}/brain/turns`, { maxRedirects: 0 });
  expect([401, 403, 307, 308]).toContain(anon.status());
  expect(await anon.text()).not.toContain("current status");
  await anonymous.dispose();
});

test("SIT-G: replaying the same clientMessageId returns the same turn without calling the model again", async ({ page }) => {
  await signIn(page, t.main.email);
  const transcript = await (await page.request.get(`/api/projects/${t.main.projectA}/brain/turns`)).json();
  const first = transcript.messages.find((m: { role: string }) => m.role === "user");
  const callsBefore = stubCalls();
  const replay = await page.request.post(`/api/projects/${t.main.projectA}/brain/turns`, { data: { clientMessageId: first.clientMessageId, text: first.content } });
  expect(replay.status()).toBe(200);
  const body = await replay.json();
  expect(body.replayed).toBe(true);
  expect(body.messages[0].id).toBe(first.id);
  if (stubLog) expect(stubCalls()).toBe(callsBefore);
  const after = await (await page.request.get(`/api/projects/${t.main.projectA}/brain/turns`)).json();
  expect(after.messages.length).toBe(transcript.messages.length);
  // Caller-supplied scope is refused outright.
  const scoped = await page.request.post(`/api/projects/${t.main.projectA}/brain/turns`, { data: { clientMessageId: randomUUID(), text: "x", workspaceId: t.other.workspaceId } });
  expect(scoped.status()).toBe(400);
});

test("SIT-B: an off-topic question is answered without project sources and writes no project state", async ({ page }) => {
  await signIn(page, t.main.email);
  await openBrain(page, t.main.projectA);
  const baseline = await stateCounts(t.main.workspaceId);
  const reply = await ask(page, "Why are my boogers green?");
  await expect(reply).toHaveAttribute("data-mode", "generative");
  await expect(reply.locator("[data-source-id]")).toHaveCount(0);
  await expect(reply.getByTestId("project-brain-statements")).toHaveCount(0);
  expect(await stateCounts(t.main.workspaceId)).toEqual(baseline);
  await page.reload();
  await expect(brain(page).getByText("Why are my boogers green?")).toBeVisible({ timeout: 45_000 });
  await shot(page, "05-off-topic");
});

test("Degraded: a provider failure is answered honestly in limited mode, never as a generative answer", async ({ page }) => {
  await signIn(page, t.main.email);
  await openBrain(page, t.main.projectA);
  const reply = await ask(page, "[simulate-provider-failure] What is the status?");
  await expect(reply).toHaveAttribute("data-mode", "degraded");
  await expect(reply).toContainText("limited mode");
  await expect(reply).not.toContainText("[stub model]");
  await expect(reply.getByText("Try again with Project Brain")).toBeVisible();
  await shot(page, "06-degraded-limited-mode");
});

test("Legacy: /projects/[id]/chat redirects to the canonical Project Command Center with the same thread", async ({ page }) => {
  await signIn(page, t.main.email);
  await page.goto(`/projects/${t.main.projectA}/chat`);
  await page.waitForURL((url) => url.pathname === `/workspaces/${t.main.workspaceId}/projects/${t.main.projectA}/command-center`, { timeout: 45_000 });
  await expect(page.getByRole("heading", { name: "Project Brain" })).toBeVisible();
  await expect(brain(page).getByText("What is the current status of this project?")).toBeVisible({ timeout: 45_000 });
  await expect(page.getByRole("link", { name: "Chat", exact: true })).toHaveCount(0);
  await shot(page, "07-legacy-redirect-canonical");
});
