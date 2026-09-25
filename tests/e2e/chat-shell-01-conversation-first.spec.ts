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
const t: { main: Tenant; other: Tenant } = {} as never;

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
  await expect(tree(page).getByRole("treeitem", { name: FRONTERA })).toHaveAttribute("aria-selected", "true");
  await expect(tree(page).getByRole("treeitem", { name: "Project Brain" })).toHaveAttribute("aria-current", "page");

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
  await expect(tree(page).getByRole("treeitem", { name: `Settlement Rails main` })).toHaveAttribute("aria-selected", "true");
  await expect(tree(page).getByRole("treeitem", { name: FRONTERA })).not.toHaveAttribute("aria-selected", "true");
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
  await expect(navSheet.getByRole("treeitem", { name: FRONTERA })).toHaveAttribute("aria-selected", "true");
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
