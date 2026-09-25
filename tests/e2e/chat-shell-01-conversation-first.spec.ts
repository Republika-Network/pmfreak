/**
 * CHAT-SHELL-01 — the conversation-first product shell, in a real browser.
 *
 * Real sign-in through /login, the real protected layout and shell router, the real
 * context-tree endpoint, the real canonical project route and the real Project Brain
 * conversation, against a DISPOSABLE LOCAL Supabase stack. The service-role client only
 * seeds tenants; everything asserted is what the signed-in PM's browser renders.
 *
 * The project is named after the production project whose screenshot motivated
 * CHAT-SHELL-01 — "Frontera Governed Machine Payments" — and the desktop checks are the
 * acceptance criteria that screenshot failed: one left navigation, the conversation in
 * the centre with its composer visible, the tools on the right, no inner project sidebar,
 * no nested Command Center application, no horizontal overflow, no nested scroll prison.
 *
 * Run (disposable stack + dev server on the same env):
 *   OPERATIONAL_FLOW_TEST_SUPABASE_URL=... OPERATIONAL_FLOW_TEST_SERVICE_ROLE_KEY=...
 *   OPERATIONAL_FLOW_TEST_BASE_URL=http://localhost:3000 \
 *   npx playwright test tests/e2e/chat-shell-01-conversation-first.spec.ts
 */
import { expect, test, type Page } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";

const supabaseUrl = process.env.OPERATIONAL_FLOW_TEST_SUPABASE_URL ?? "";
const serviceRoleKey = process.env.OPERATIONAL_FLOW_TEST_SERVICE_ROLE_KEY ?? "";
const SHOTS = "artifacts/chat-shell-01/screenshots";
const password = `CHAT-SHELL-01-${randomUUID()}!`;
const suffix = `${Date.now()}-${randomUUID().slice(0, 6)}`;
const FRONTERA = "Frontera Governed Machine Payments";

const admin = createClient(supabaseUrl || "http://127.0.0.1:54321", serviceRoleKey || "missing", {
  auth: { persistSession: false, autoRefreshToken: false },
});

type Tenant = { email: string; userId: string; workspaceId: string; workspaceName: string; pmoId: string; frontera: string; second: string; direct: string };
/** One user in TWO workspaces: A (the preferred-workspace cookie) and B (what the route shows). */
type Multi = { email: string; userId: string; wsA: string; wsAName: string; wsB: string; wsBName: string; projectB: string };
const t: { main: Tenant; other: Tenant; multi: Multi } = {} as never;
let fronteraTaskTitle = "";

function ok(result: { error: { message: string } | null }, label: string): void {
  if (result.error) throw new Error(`${label}: ${result.error.message}`);
}

async function seedTenant(label: string): Promise<Tenant> {
  const email = `chat-shell-01-${label}-${suffix}@example.test`;
  const created = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (created.error) throw new Error(created.error.message);
  const userId = created.data.user!.id;
  const workspaceId = randomUUID();
  const workspaceName = `CS01 ${label} ${suffix}`;
  ok(await admin.from("workspaces").insert({ id: workspaceId, name: workspaceName, created_by_user_id: userId }), "workspace");
  ok(await admin.from("workspace_memberships").insert({ workspace_id: workspaceId, user_id: userId, role: "owner" }), "membership");
  // The protected layout gates on an active trial (same seed shape as PB-CHAT-01 / P2-16).
  const inviteId = randomUUID();
  const trialEnd = new Date(Date.now() + 365 * 86_400_000).toISOString();
  ok(await admin.from("early_access_invites").insert({
    id: inviteId, invite_email: email, invite_token_hash: createHash("sha256").update(`chat-shell-01-consumed:${inviteId}`).digest("hex"),
    invite_note: "CHAT-SHELL-01 browser scenario", inviter_user_id: userId, expires_at: trialEnd, accepted_at: new Date().toISOString(),
    requires_approval: false, workspace_id: workspaceId,
  }), "invite");
  ok(await admin.from("trial_licenses").insert({ id: randomUUID(), invite_id: inviteId, workspace_id: workspaceId, trial_start_at: new Date().toISOString(), trial_end_at: trialEnd, trial_status: "active" }), "trial");

  const pmoId = randomUUID();
  ok(await admin.from("pmos").insert({ id: pmoId, workspace_id: workspaceId, name: `Payments PMO ${label}`, created_by_user_id: userId }), "pmo");
  const done = { initialIngestion: { status: "completed" } };
  const frontera = randomUUID();
  const second = randomUUID();
  const direct = randomUUID();
  ok(await admin.from("projects").insert([
    { id: frontera, workspace_id: workspaceId, user_id: userId, pmo_id: pmoId, name: label === "main" ? FRONTERA : `Other tenant project ${suffix}`, onboarding_payload: done },
    { id: second, workspace_id: workspaceId, user_id: userId, pmo_id: pmoId, name: `Settlement Rails ${label}`, onboarding_payload: done },
    { id: direct, workspace_id: workspaceId, user_id: userId, pmo_id: null, name: `Direct Initiative ${label}`, onboarding_payload: done },
  ]), "projects");
  return { email, userId, workspaceId, workspaceName, pmoId, frontera, second, direct };
}

async function grantTrial(workspaceId: string, userId: string, email: string) {
  const inviteId = randomUUID();
  const trialEnd = new Date(Date.now() + 365 * 86_400_000).toISOString();
  ok(await admin.from("early_access_invites").insert({
    id: inviteId, invite_email: email, invite_token_hash: createHash("sha256").update(`chat-shell-01-multi:${inviteId}`).digest("hex"),
    invite_note: "CHAT-SHELL-01 multi-workspace scenario", inviter_user_id: userId, expires_at: trialEnd, accepted_at: new Date().toISOString(),
    requires_approval: false, workspace_id: workspaceId,
  }), "multi invite");
  ok(await admin.from("trial_licenses").insert({ id: randomUUID(), invite_id: inviteId, workspace_id: workspaceId, trial_start_at: new Date().toISOString(), trial_end_at: trialEnd, trial_status: "active" }), "multi trial");
}

async function seedMulti(): Promise<Multi> {
  const email = `chat-shell-01-multi-${suffix}@example.test`;
  const created = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (created.error) throw new Error(created.error.message);
  const userId = created.data.user!.id;
  const wsA = randomUUID();
  const wsB = randomUUID();
  const wsAName = `CS01 multi A ${suffix}`;
  const wsBName = `CS01 multi B ${suffix}`;
  ok(await admin.from("workspaces").insert({ id: wsA, name: wsAName, created_by_user_id: userId }), "ws A");
  ok(await admin.from("workspace_memberships").insert({ workspace_id: wsA, user_id: userId, role: "owner" }), "member A");
  await grantTrial(wsA, userId, email);
  ok(await admin.from("workspaces").insert({ id: wsB, name: wsBName, created_by_user_id: userId }), "ws B");
  ok(await admin.from("workspace_memberships").insert({ workspace_id: wsB, user_id: userId, role: "owner" }), "member B");
  await grantTrial(wsB, userId, email);
  // A has a project too, so neither workspace is sent to first-project onboarding.
  ok(await admin.from("projects").insert({ id: randomUUID(), workspace_id: wsA, user_id: userId, name: `Alpha Ops ${suffix}`, onboarding_payload: { initialIngestion: { status: "completed" } } }), "project A");
  const projectB = randomUUID();
  ok(await admin.from("projects").insert({ id: projectB, workspace_id: wsB, user_id: userId, name: `Beta Rails ${suffix}`, onboarding_payload: { initialIngestion: { status: "completed" } } }), "project B");
  return { email, userId, wsA, wsAName, wsB, wsBName, projectB };
}

/** Pin the preferred-workspace cookie to A — the state a canonical deep link into B never changes. */
async function preferWorkspaceA(page: Page) {
  const base = new URL(process.env.OPERATIONAL_FLOW_TEST_BASE_URL ?? "http://localhost:3000");
  await page.context().addCookies([{ name: "pmfreak.workspaceId", value: t.multi.wsA, domain: base.hostname, path: "/" }]);
}

async function signIn(page: Page, email: string) {
  await page.goto("/login");
  await page.getByPlaceholder("Email").fill(email);
  await page.getByPlaceholder("Password").fill(password);
  await Promise.all([
    page.waitForURL((url) => !url.pathname.startsWith("/login"), { timeout: 45_000 }),
    page.getByRole("button", { name: "Continue" }).click(),
  ]);
}

const projectPath = (tenant: Tenant, projectId: string) => `/workspaces/${tenant.workspaceId}/projects/${projectId}`;
const tree = (page: Page) => page.getByTestId("conversation-shell-navigator").getByRole("tree");
const conversation = (page: Page) => page.getByTestId("project-brain-conversation");

async function openProject(page: Page, tenant: Tenant, projectId: string) {
  await page.goto(projectPath(tenant, projectId));
  await expect(conversation(page)).toHaveAttribute("data-project-id", projectId, { timeout: 45_000 });
  await expect(conversation(page).getByText(/Loading this project/)).toHaveCount(0, { timeout: 45_000 });
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
  t.multi = await seedMulti();
  fronteraTaskTitle = `Confirm settlement cut-over ${suffix}`;
  ok(await admin.from("execution_tasks").insert({ workspace_id: t.main.workspaceId, project_id: t.main.frontera, title: fronteraTaskTitle, description: "Seeded for the nested-dialog check.", status: "not_started", priority: "high" }), "frontera task");
});

test("DESKTOP: Frontera opens as a conversation in ONE shell — no nested Command Center", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await signIn(page, t.main.email);
  await openProject(page, t.main, t.main.frontera);

  // Exactly one application shell, and exactly one primary left navigation.
  await expect(page.locator("[data-shell]")).toHaveCount(1);
  await expect(page.locator('[data-shell="pmfreak-conversation-shell"]')).toHaveCount(1);
  await expect(page.getByTestId("conversation-shell-navigator")).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Primary navigation" })).toHaveCount(0);
  // None of the nested application's chrome exists.
  for (const removed of ["command-center-canvas", "cc-section-project-brain", "cc-project-header"]) {
    await expect(page.getByTestId(removed)).toHaveCount(0);
  }
  await expect(page.getByRole("navigation", { name: "Projects", exact: true })).toHaveCount(0);
  await expect(page.locator('[data-shell="pmfreak-light-command-center"]')).toHaveCount(0);

  // The conversation is the centre and dominant; its composer is visible without searching.
  const center = page.getByTestId("project-conversation-center");
  const input = conversation(page).getByTestId("project-brain-input");
  await expect(input).toBeVisible();
  await expect(input).toBeInViewport();
  const viewport = page.viewportSize()!;
  const centerBox = (await center.boundingBox())!;
  const navBox = (await page.getByTestId("conversation-shell-navigator").boundingBox())!;
  const railBox = (await page.getByTestId("operational-rail").boundingBox())!;
  expect(centerBox.width, "the centre is the dominant zone").toBeGreaterThan(viewport.width * 0.6);
  expect(navBox.x + navBox.width).toBeLessThanOrEqual(centerBox.x + 1);
  expect(railBox.x).toBeGreaterThanOrEqual(centerBox.x + centerBox.width - 1);
  expect(railBox.width, "the rail is compact").toBeLessThanOrEqual(80);

  // The empty conversation invites typing.
  await expect(conversation(page).getByTestId("project-brain-empty")).toContainText("Ask Project Brain about this project");
  await expect(conversation(page).getByTestId("project-brain-empty")).toContainText(FRONTERA);

  // The tree says where we are: workspace → PMO → Frontera → Project Brain.
  await expect(tree(page).getByRole("treeitem", { name: new RegExp(t.main.workspaceName) })).toHaveAttribute("aria-expanded", "true");
  // F7: exactly one selected item — the open conversation; its ancestry is data-active only.
  await expect(tree(page).getByRole("treeitem", { name: FRONTERA })).toHaveAttribute("data-active", "true");
  await expect(tree(page).getByRole("treeitem", { name: FRONTERA })).not.toHaveAttribute("aria-selected", /.*/);
  await expect(tree(page).getByRole("treeitem", { name: "Project Brain" })).toHaveAttribute("aria-current", "page");
  await expect(tree(page).getByRole("treeitem", { name: "Project Brain" })).toHaveAttribute("aria-selected", "true");
  await expect(tree(page).locator('[role="treeitem"][aria-selected="true"]')).toHaveCount(1);

  // No horizontal page overflow, and no page-level scroll: the shell is one viewport.
  const overflow = await page.evaluate(() => ({
    x: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    y: document.documentElement.scrollHeight - document.documentElement.clientHeight,
  }));
  expect(overflow.x, "horizontal overflow").toBeLessThanOrEqual(1);
  expect(overflow.y, "the page itself does not scroll").toBeLessThanOrEqual(1);
  // No nested scroll prison: the only scrolling region in the centre is the transcript.
  const centreScrollers = await center.evaluate((root) =>
    [root, ...Array.from(root.querySelectorAll("*"))]
      // A textarea scrolls its own text by default; that is a control, not a region.
      .filter((el) => el.tagName !== "TEXTAREA" && ["auto", "scroll"].includes(getComputedStyle(el).overflowY))
      .map((el) => (el as HTMLElement).dataset.testid ?? el.tagName.toLowerCase()),
  );
  expect(centreScrollers).toEqual(["project-brain-transcript"]);
  await shot(page, "01-desktop-frontera-conversation");
});

test("DESKTOP: a tool opens beside the conversation, and the conversation keeps its draft", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await signIn(page, t.main.email);
  await openProject(page, t.main, t.main.frontera);
  const input = conversation(page).getByTestId("project-brain-input");
  await input.fill("Draft that must survive opening tools");

  const rail = page.getByRole("navigation", { name: "Project tools" });
  await rail.getByRole("button", { name: /Needs you/ }).click();
  const inspector = page.getByTestId("operational-inspector");
  await expect(inspector).toBeVisible();
  await expect(inspector).toHaveAttribute("data-tool", "attention");
  await expect(inspector.getByRole("heading", { name: "Needs your attention" })).toBeVisible({ timeout: 45_000 });
  // Beside, not instead: the conversation and its composer are still there and usable.
  await expect(input).toBeVisible();
  await expect(input).toHaveValue("Draft that must survive opening tools");
  const centerBox = (await page.getByTestId("project-conversation-center").boundingBox())!;
  const inspectorBox = (await inspector.boundingBox())!;
  expect(inspectorBox.width).toBeGreaterThanOrEqual(300);
  expect(inspectorBox.width).toBeLessThanOrEqual(440);
  expect(centerBox.width, "the conversation remains usable with the inspector open").toBeGreaterThan(640);
  await shot(page, "02-desktop-tool-open");

  // Switching tools does not reset the conversation; closing returns the space.
  await rail.getByRole("button", { name: /Tasks/ }).click();
  await expect(inspector).toHaveAttribute("data-tool", "tasks");
  await rail.getByRole("button", { name: /Evidence/ }).click();
  await expect(inspector).toHaveAttribute("data-tool", "repository");
  await expect(input).toHaveValue("Draft that must survive opening tools");
  await inspector.getByRole("button", { name: "Close project tool" }).click();
  await expect(inspector).toBeHidden();
  await expect(input).toHaveValue("Draft that must survive opening tools");
});

test("SWITCHING: one project selection in the tree changes the conversation, the URL and the history", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await signIn(page, t.main.email);
  await openProject(page, t.main, t.main.frontera);
  await tree(page).getByRole("treeitem", { name: `Settlement Rails main` }).click();
  await expect(page).toHaveURL(new RegExp(`${projectPath(t.main, t.main.second)}$`));
  await expect(conversation(page)).toHaveAttribute("data-project-id", t.main.second);
  await expect(tree(page).getByRole("treeitem", { name: `Settlement Rails main` })).toHaveAttribute("data-active", "true");
  await expect(tree(page).getByRole("treeitem", { name: FRONTERA })).not.toHaveAttribute("data-active", "true");
  await expect(tree(page).locator('[role="treeitem"][aria-selected="true"]')).toHaveCount(1);
  // A direct project (no PMO) sits under its workspace, not a fabricated PMO.
  await tree(page).getByRole("treeitem", { name: `Direct Initiative main` }).click();
  await expect(conversation(page)).toHaveAttribute("data-project-id", t.main.direct);
  await page.goBack();
  await expect(conversation(page)).toHaveAttribute("data-project-id", t.main.second);
  await shot(page, "03-switched-project");
});

test("KEYBOARD: the tree is operable without a pointer", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await signIn(page, t.main.email);
  await openProject(page, t.main, t.main.frontera);
  const current = tree(page).getByRole("treeitem", { name: "Project Brain" });
  await current.focus();
  await page.keyboard.press("ArrowLeft");
  await expect(tree(page).getByRole("treeitem", { name: FRONTERA })).toBeFocused();
  await page.keyboard.press("ArrowLeft");
  await expect(tree(page).getByRole("treeitem", { name: /Payments PMO main/ })).toBeFocused();
  await page.keyboard.press("ArrowLeft");
  await expect(tree(page).getByRole("treeitem", { name: /Payments PMO main/ })).toHaveAttribute("aria-expanded", "false");
  await page.keyboard.press("Enter");
  await expect(tree(page).getByRole("treeitem", { name: /Payments PMO main/ })).toHaveAttribute("aria-expanded", "true");
});

test("ISOLATION: the tree shows only the caller's workspaces, and another tenant's project is refused", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await signIn(page, t.main.email);
  await openProject(page, t.main, t.main.frontera);
  await expect(tree(page)).not.toContainText(t.other.workspaceName);
  await expect(tree(page)).not.toContainText("Other tenant project");
  const denied = await page.request.get(`/api/navigation/context-tree?workspaceId=${t.other.workspaceId}`);
  expect(denied.status()).toBe(403);
  // Another tenant's project, addressed directly, renders the one indistinguishable refusal.
  await page.goto(projectPath(t.other, t.other.frontera));
  await expect(page.getByText("This project isn't available to you")).toBeVisible();
  await expect(conversation(page)).toHaveCount(0);
  await expect(page.locator("body")).not.toContainText("Other tenant project");
});

test("LEGACY: the Workspace Command Center hands off to the conversation with Needs you open", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await signIn(page, t.main.email);
  await page.goto(`/workspaces/${t.main.workspaceId}/command-center?projectId=${t.main.frontera}`);
  await page.waitForURL((url) => url.pathname === projectPath(t.main, t.main.frontera) && url.searchParams.get("tool") === "attention", { timeout: 45_000 });
  await expect(page.getByTestId("operational-inspector")).toHaveAttribute("data-tool", "attention");
  await expect(conversation(page).getByTestId("project-brain-input")).toBeVisible();
  // The legacy project chat path lands on the same conversation.
  await page.goto(`/projects/${t.main.frontera}/chat`);
  await page.waitForURL((url) => url.pathname === projectPath(t.main, t.main.frontera), { timeout: 45_000 });
  // The details screen moved to /overview and is inside the same shell.
  await page.goto(`${projectPath(t.main, t.main.frontera)}/overview`);
  await expect(page.getByRole("heading", { name: FRONTERA })).toBeVisible();
  await expect(page.locator('[data-shell="pmfreak-conversation-shell"]')).toHaveCount(1);
});

test("MOBILE: the conversation owns the viewport; the tree and the tools open as sheets", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await signIn(page, t.main.email);
  await openProject(page, t.main, t.main.frontera);
  await expect(page.getByTestId("conversation-shell-navigator")).toBeHidden();
  await expect(page.getByTestId("operational-rail")).toBeHidden();
  await expect(conversation(page).getByTestId("project-brain-input")).toBeInViewport();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
  await shot(page, "04-mobile-conversation");

  await page.getByRole("button", { name: "Open navigation" }).click();
  const navSheet = page.getByRole("dialog", { name: "Navigation" });
  await expect(navSheet).toBeVisible();
  await expect(navSheet.getByRole("treeitem", { name: FRONTERA })).toHaveAttribute("data-active", "true");
  await shot(page, "05-mobile-navigation");
  await page.keyboard.press("Escape");
  await expect(navSheet).toBeHidden();

  await page.getByRole("button", { name: "Tools", exact: true }).click();
  const tools = page.getByRole("dialog", { name: /project tool/ });
  await expect(tools).toBeVisible();
  await expect(tools.getByRole("heading", { name: "Needs your attention" })).toBeVisible({ timeout: 45_000 });
  await shot(page, "06-mobile-tools");
  await page.keyboard.press("Escape");
  await expect(tools).toBeHidden();
  await expect(conversation(page).getByTestId("project-brain-input")).toBeVisible();
});

test("TABLET: with the tool sheet open over the rail, tools can still be switched from inside it", async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 800 });
  await signIn(page, t.main.email);
  await openProject(page, t.main, t.main.frontera);
  await expect(page.getByTestId("operational-rail")).toBeVisible();
  await page.getByRole("navigation", { name: "Project tools" }).getByRole("button", { name: /Needs you/ }).click();
  const sheet = page.getByRole("dialog", { name: /project tool/ });
  await expect(sheet).toHaveAttribute("data-tool", "attention");
  const switcher = sheet.getByRole("group", { name: "Switch project tool" });
  await expect(switcher).toBeVisible();
  await switcher.getByRole("button", { name: "Evidence" }).click();
  await expect(sheet).toHaveAttribute("data-tool", "repository");
  await expect(sheet.getByRole("button", { name: /Add project notes/i }).first()).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(sheet).toBeHidden();
  await expect(conversation(page).getByTestId("project-brain-input")).toBeVisible();
});

// ═══ Review remediation (F1–F7), in a real browser ════════════════════════════

test("F1: 'New project' from workspace B creates in B — never silently in the cookie's A", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await signIn(page, t.multi.email);
  await preferWorkspaceA(page);
  await page.goto(projectPath({ workspaceId: t.multi.wsB } as Tenant, t.multi.projectB));
  await expect(conversation(page)).toHaveAttribute("data-project-id", t.multi.projectB, { timeout: 45_000 });
  const beforeA = (await admin.from("projects").select("id").eq("workspace_id", t.multi.wsA)).data?.length ?? 0;

  await page.getByTestId("conversation-shell-navigator").getByTestId("shell-new-project").click();
  await page.waitForURL((url) => url.pathname === "/projects/new" && url.searchParams.get("workspaceId") === t.multi.wsB);
  await expect(page.getByTestId("create-project-target-workspace")).toHaveAttribute("data-workspace-id", t.multi.wsB);
  await expect(page.getByTestId("create-project-target-workspace")).toContainText(t.multi.wsBName);

  const name = `Created from B ${suffix}`;
  await page.getByPlaceholder("ERP Phase 2 Rollout").fill(name);
  await page.getByPlaceholder("Acme Corporation").fill("Frontera Payments");
  await page.getByPlaceholder("Jane Smith").fill("Ana PM");
  await page.getByRole("button", { name: /Software Delivery/ }).click();
  await page.getByRole("button", { name: "Continue →" }).click();
  await page.getByPlaceholder("Describe the core business or technical problem this project addresses.").fill("Settlement rails need a governed cut-over.");
  await page.getByPlaceholder("The primary outcome or artefact this project produces.").fill("A governed settlement service.");
  await page.getByRole("button", { name: /Closed Scope/ }).click();
  for (let step = 0; step < 3; step += 1) await page.getByRole("button", { name: "Continue →" }).click();
  await page.getByRole("button", { name: /Activate Project Brain/ }).click();

  // It lands in B's own Command Center (the guided view for the new project) — not A's.
  await page.waitForURL((url) => url.pathname.startsWith(`/workspaces/${t.multi.wsB}/`), { timeout: 90_000 });
  const created = (await admin.from("projects").select("id, workspace_id").eq("name", name)).data ?? [];
  expect(created).toHaveLength(1);
  expect(created[0].workspace_id, "created in the displayed workspace B").toBe(t.multi.wsB);
  const afterA = (await admin.from("projects").select("id").eq("workspace_id", t.multi.wsA)).data?.length ?? 0;
  expect(afterA, "nothing landed in the preferred workspace A").toBe(beforeA);

  // A workspace the caller does not belong to is refused on the page — no form, no fallback.
  await page.goto(`/projects/new?workspaceId=${t.other.workspaceId}`);
  await expect(page.getByTestId("create-project-target-refused")).toBeVisible();
  await expect(page.getByPlaceholder("ERP Phase 2 Rollout")).toHaveCount(0);
});

test("F2: a failed workspace branch recovers in place — Retry, and reopen — without a request loop", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await signIn(page, t.multi.email);
  await preferWorkspaceA(page);
  let branchRequests = 0;
  let failBranch = true;
  await page.route(`**/api/navigation/context-tree?workspaceId=${t.multi.wsB}`, async (route) => {
    branchRequests += 1;
    if (failBranch) await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "down" }) });
    else await route.continue();
  });
  await page.goto(`/workspaces/${t.multi.wsA}`);
  const bNode = tree(page).getByRole("treeitem", { name: new RegExp(t.multi.wsBName) });
  await expect(bNode).toHaveAttribute("aria-expanded", "false", { timeout: 45_000 });
  await bNode.click();
  await expect(tree(page).getByText("Projects couldn't be loaded.")).toBeVisible();
  // No loop: the failed branch is not re-requested on its own.
  await page.waitForTimeout(3_000);
  expect(branchRequests).toBe(1);
  // Explicit retry recovers it.
  failBranch = false;
  await tree(page).getByRole("treeitem", { name: "Retry loading projects" }).click();
  await expect(tree(page).getByRole("treeitem", { name: `Beta Rails ${suffix}` })).toBeVisible();
  expect(branchRequests).toBe(2);
  // Reopening a failed branch also retries it.
  failBranch = true;
  await page.reload();
  const bAgain = tree(page).getByRole("treeitem", { name: new RegExp(t.multi.wsBName) });
  await expect(tree(page).getByText("Projects couldn't be loaded.")).toBeVisible({ timeout: 45_000 });
  failBranch = false;
  await bAgain.click();
  await expect(bAgain).toHaveAttribute("aria-expanded", "false");
  await bAgain.click();
  await expect(tree(page).getByRole("treeitem", { name: `Beta Rails ${suffix}` })).toBeVisible();
});

test("F3: the navigation sheet closes when the desktop navigator takes over, and leaves no trap", async ({ page }) => {
  await page.setViewportSize({ width: 800, height: 900 });
  await signIn(page, t.main.email);
  await openProject(page, t.main, t.main.frontera);
  await page.getByRole("button", { name: "Open navigation" }).click();
  const sheet = page.getByRole("dialog", { name: "Navigation" });
  await expect(sheet).toBeVisible();
  await page.setViewportSize({ width: 1280, height: 900 });
  await expect(page.getByTestId("shell-drawer-left")).toBeHidden();
  await expect(page.getByTestId("conversation-shell-navigator")).toBeVisible();
  // The user's place moves to the permanent navigator's current item, not a hidden opener.
  await expect(page.getByTestId("conversation-shell-navigator").getByRole("treeitem", { name: "Project Brain" })).toBeFocused();
  // Tab moves through visible controls — focus is never held inside the hidden sheet.
  const trail: string[] = [];
  for (let i = 0; i < 6; i += 1) {
    await page.keyboard.press("Tab");
    const state = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null;
      return {
        describe: `${el?.tagName} ${el?.getAttribute("data-testid") ?? ""} ${el?.getAttribute("aria-label") ?? ""} ${(el?.textContent ?? "").slice(0, 25)} rects=${el?.getClientRects().length}`,
        inHiddenSheet: Boolean(el?.closest('[data-testid="shell-drawer-left"]')),
        visible: Boolean(el && el !== document.body && el.getClientRects().length > 0),
      };
    });
    trail.push(state.describe);
    expect(state.inHiddenSheet, state.describe).toBe(false);
    expect(state.visible, `Tab ${i + 1}: ${trail.join(" | ")}`).toBe(true);
  }
});

test("F4: cookie A + project route B — the Project tool reads and writes B's onboarding only", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await signIn(page, t.multi.email);
  await preferWorkspaceA(page);
  const activationRequests: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("/api/workspace-activation")) activationRequests.push(`${request.method()} ${request.url()}`);
  });
  await page.goto(projectPath({ workspaceId: t.multi.wsB } as Tenant, t.multi.projectB));
  await expect(conversation(page)).toHaveAttribute("data-project-id", t.multi.projectB, { timeout: 45_000 });
  const read = page.waitForResponse((response) => response.url().includes("/api/workspace-activation") && response.request().method() === "GET");
  await page.getByRole("navigation", { name: "Project tools" }).getByRole("button", { name: "Project" }).click();
  expect((await read).status()).toBe(200);
  const panel = page.locator('[aria-label^="Workspace setup"]').first();
  await expect(panel).toBeVisible({ timeout: 45_000 });
  const write = page.waitForResponse((response) => response.url().includes("/api/workspace-activation") && response.request().method() === "PATCH");
  await panel.getByRole("button").first().click();
  expect((await write).status()).toBe(200);
  expect(activationRequests.length).toBeGreaterThanOrEqual(2);
  for (const entry of activationRequests) expect(entry, "every activation request names B").toContain(`workspaceId=${t.multi.wsB}`);
  const prefsB = (await admin.from("workspace_onboarding_preferences").select("workspace_id").eq("user_id", t.multi.userId).eq("workspace_id", t.multi.wsB)).data ?? [];
  const prefsA = (await admin.from("workspace_onboarding_preferences").select("workspace_id").eq("user_id", t.multi.userId).eq("workspace_id", t.multi.wsA)).data ?? [];
  expect(prefsB, "the write landed in B").toHaveLength(1);
  expect(prefsA, "A's preferences were not touched").toHaveLength(0);
});

for (const width of [1024, 390] as const) {
  test(`F5: at ${width}px a task dialog over the tool sheet owns Escape and Tab`, async ({ page }) => {
    await page.setViewportSize({ width, height: 860 });
    await signIn(page, t.main.email);
    await openProject(page, t.main, t.main.frontera);
    if (width >= 768) await page.getByRole("navigation", { name: "Project tools" }).getByRole("button", { name: "Tasks" }).click();
    else {
      await page.getByRole("button", { name: "Tools", exact: true }).click();
      await page.getByRole("group", { name: "Switch project tool" }).getByRole("button", { name: "Tasks" }).click();
    }
    const sheet = page.getByTestId("operational-inspector");
    await expect(sheet).toHaveAttribute("data-tool", "tasks");

    // Add-task modal: Tab stays inside it; one Escape closes ONLY the modal.
    await sheet.getByRole("button", { name: /Add another task/ }).click();
    const modal = page.getByTestId("quick-add-task-modal");
    await expect(modal).toBeVisible();
    for (let i = 0; i < 10; i += 1) {
      await page.keyboard.press("Tab");
      expect(await page.evaluate(() => Boolean(document.activeElement?.closest('[data-testid="quick-add-task-modal"]')))).toBe(true);
    }
    await page.keyboard.press("Escape");
    await expect(modal).toHaveCount(0);
    await expect(sheet).toBeVisible();
    await expect(sheet).toHaveAttribute("data-tool", "tasks");

    // Task detail drawer: same contract.
    await sheet.getByRole("button", { name: fronteraTaskTitle }).click();
    const drawer = page.getByTestId("task-detail-drawer");
    await expect(drawer).toBeVisible({ timeout: 30_000 });
    for (let i = 0; i < 6; i += 1) {
      await page.keyboard.press("Tab");
      expect(await page.evaluate(() => Boolean(document.activeElement?.closest('[role="dialog"][aria-modal="true"]:not([data-testid="operational-inspector"])')))).toBe(true);
    }
    await page.keyboard.press("Escape");
    await expect(drawer).toHaveCount(0);
    await expect(sheet).toBeVisible();
    // A second Escape — now nothing is stacked — closes the sheet.
    await page.keyboard.press("Escape");
    await expect(sheet).toBeHidden();
  });
}

test("F6: a failed brief regeneration is honest, and keeps the evidence", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await signIn(page, t.main.email);
  await page.route(`**/api/projects/${t.main.second}/operational-governance-brief`, (route) =>
    route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "down", brief: { invented: true } }) }),
  );
  await openProject(page, t.main, t.main.second);
  const shell = page.getByTestId("project-conversation-shell");
  await expect(shell).toHaveAttribute("data-has-brief", "false");
  const evidenceBefore = (await admin.from("evidence_items").select("id").eq("project_id", t.main.second)).data?.length ?? 0;
  await captureNotes(page, "Vendor confirmed the settlement window on 2026-09-20.");
  await expect(page.getByTestId("project-brief-refresh-failed")).toBeVisible({ timeout: 45_000 });
  await expect(shell, "a failed regeneration never claims a brief").toHaveAttribute("data-has-brief", "false");
  const evidenceAfter = (await admin.from("evidence_items").select("id").eq("project_id", t.main.second)).data?.length ?? 0;
  expect(evidenceAfter, "the evidence write is kept").toBeGreaterThan(evidenceBefore);
});

test("F6: a project with no brief gains a REAL brief after evidence intake, and the shell updates", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await signIn(page, t.main.email);
  const before = (await admin.from("operational_governance_briefs").select("id").eq("project_id", t.main.direct)).data ?? [];
  expect(before, "starts with no brief").toHaveLength(0);
  await openProject(page, t.main, t.main.direct);
  const shell = page.getByTestId("project-conversation-shell");
  await expect(shell).toHaveAttribute("data-has-brief", "false");
  await captureNotes(page, "Regulator approved the pilot scope; the settlement vendor is now a critical dependency.");
  await expect(shell).toHaveAttribute("data-has-brief", "true", { timeout: 60_000 });
  const after = (await admin.from("operational_governance_briefs").select("id").eq("project_id", t.main.direct)).data ?? [];
  expect(after.length, "the brief the shell shows exists server-side").toBeGreaterThan(0);
  // And a reload reads the same confirmed state from the server.
  await page.reload();
  await expect(page.getByTestId("project-conversation-shell")).toHaveAttribute("data-has-brief", "true", { timeout: 45_000 });
});

/** Record LIVE project notes through the Evidence tool's real intake. */
async function captureNotes(page: Page, text: string) {
  await page.getByRole("navigation", { name: "Project tools" }).getByRole("button", { name: "Evidence" }).click();
  await page.getByTestId("operational-inspector").getByRole("button", { name: /Add project notes/i }).first().click();
  await page.getByRole("textbox", { name: "Project notes" }).fill(text);
  await page.getByLabel("Assertion type").selectOption("FACT");
  await page.getByLabel("Classification").selectOption("DELIVERY");
  await page.getByLabel("Missing data").selectOption("COMPLETE");
  await page.getByLabel("Confidence (0–1)").fill("0.90");
  await page.getByRole("button", { name: "Capture and derive Evidence" }).click();
}
