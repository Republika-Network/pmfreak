/**
 * P2-16 — authenticated browser scenario for Schedule Exposure.
 *
 * Real sign-in through the product's /login form, the real Command Center, the real route and
 * the real RPCs against the disposable local stack. The service-role client is used ONLY to
 * seed the two tenants and their schedules (and to perturb the schedule between steps, the way
 * a planner editing H7/H8 data would); every canonical write under test is made by the signed-in
 * PM through the UI.
 *
 * Run: OPERATIONAL_FLOW_TEST_* env set (see scripts/check-p2-16-db.mts), then
 *   npx playwright test tests/e2e/p2-16-schedule-exposure.spec.ts
 */
import { expect, test, type Page } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { evaluateAndRecordScheduleExposure } from "../../src/lib/critical-path/schedule-exposure-service";

const supabaseUrl = process.env.OPERATIONAL_FLOW_TEST_SUPABASE_URL ?? "";
const serviceRoleKey = process.env.OPERATIONAL_FLOW_TEST_SERVICE_ROLE_KEY ?? "";
const SHOTS = "artifacts/p2-16/screenshots";
const password = `P2-16-browser-${randomUUID()}!`;
const suffix = `${Date.now()}-${randomUUID().slice(0, 6)}`;
const day = (d: number) => new Date(Date.UTC(2026, 9, d)).toISOString();

const admin = createClient(supabaseUrl || "http://127.0.0.1:54321", serviceRoleKey || "missing", { auth: { persistSession: false, autoRefreshToken: false } });

type Tenant = { workspaceId: string; projectId: string; users: Record<string, string>; userIds: Record<string, string>; schedule: Record<string, string> };
const tenants: Record<"a" | "b", Tenant> = {} as never;

function must<T>(result: { data: T; error: { message: string } | null }, label: string): T {
  if (result.error) throw new Error(`${label}: ${result.error.message}`);
  return result.data;
}

async function user(label: string) {
  const email = `p2-16-e2e-${label}-${suffix}@example.test`;
  const created = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (created.error) throw new Error(created.error.message);
  return { id: created.data.user!.id, email };
}

async function seedTenant(key: "a" | "b", roles: Array<[string, string]>) {
  const workspaceId = randomUUID();
  const projectId = randomUUID();
  const actors = await Promise.all(roles.map(async ([label]) => user(`${key}-${label}`)));
  const ownerId = actors[0].id;
  must(await admin.from("workspaces").insert({ id: workspaceId, name: `P2-16 ${key.toUpperCase()} ${suffix}`, created_by_user_id: ownerId }), "workspace");
  // A project past its guided first-run (the durable `initialIngestion` marker the Command Center
  // reads), so it opens on the attention canvas rather than the Project Brain ingestion view.
  must(await admin.from("projects").insert({ id: projectId, workspace_id: workspaceId, user_id: ownerId, name: `Schedule ${key.toUpperCase()} ${suffix}`, onboarding_payload: { initialIngestion: { status: "completed" } } }), "project");
  for (let i = 0; i < roles.length; i += 1) {
    must(await admin.from("workspace_memberships").insert({ workspace_id: workspaceId, user_id: actors[i].id, role: roles[i][1] }), "membership");
  }
  // The protected layout gates on an active trial; the invite is written already accepted
  // with a hash of a public value, exactly as the P2-13 seed does. No usable token exists.
  const inviteId = randomUUID();
  const trialEnd = new Date(Date.now() + 365 * 86_400_000).toISOString();
  must(await admin.from("early_access_invites").insert({
    id: inviteId, invite_email: actors[0].email, invite_token_hash: createHash("sha256").update(`p2-16-consumed:${inviteId}`).digest("hex"),
    invite_note: "P2-16 browser scenario", inviter_user_id: ownerId, expires_at: trialEnd, accepted_at: new Date().toISOString(),
    requires_approval: false, workspace_id: workspaceId,
  }), "invite");
  must(await admin.from("trial_licenses").insert({ id: randomUUID(), invite_id: inviteId, workspace_id: workspaceId, trial_start_at: new Date().toISOString(), trial_end_at: trialEnd, trial_status: "active" }), "trial");

  const s = { a: randomUUID(), b: randomUUID(), c: randomUUID(), milestone: randomUUID(), dep: randomUUID() };
  const scope = { workspace_id: workspaceId, project_id: projectId };
  must(await admin.from("project_milestones").insert({ id: s.milestone, ...scope, title: "Go-live", milestone_type: "go_live", status: "planned", target_date: day(12), baseline_date: day(12) }), "milestone");
  const task = (id: string, title: string, start: number, finish: number, milestoneId: string | null = null) => ({
    id, ...scope, title, description: title, status: "not_started", schedule_status: "scheduled", planned_start_date: day(start), planned_finish_date: day(finish), milestone_id: milestoneId,
  });
  must(await admin.from("execution_tasks").insert([task(s.a, "Design", 1, 6), task(s.b, "Build", 6, 16, s.milestone), task(s.c, "Training plan", 1, 6)]), "tasks");
  must(await admin.from("execution_task_dependencies").insert({ id: s.dep, ...scope, predecessor_task_id: s.a, successor_task_id: s.b, dependency_type: "finish_to_start", status: "active", lag_days: 0 }), "dependency");

  tenants[key] = {
    workspaceId, projectId, schedule: s,
    users: Object.fromEntries(roles.map(([label], i) => [label, actors[i].email])),
    userIds: Object.fromEntries(roles.map(([label], i) => [label, actors[i].id])),
  };
}

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

const commandCenter = (t: Tenant) => `/workspaces/${t.workspaceId}/command-center?projectId=${t.projectId}`;
const panel = (page: Page) => page.getByTestId("schedule-exposure-panel");

async function openPanel(page: Page, t: Tenant) {
  await page.goto(commandCenter(t));
  await expect(panel(page)).toBeVisible();
  await expect(panel(page).getByText("Loading schedule exposure…")).toHaveCount(0, { timeout: 45_000 });
}

async function shot(page: Page, name: string) {
  mkdirSync(SHOTS, { recursive: true });
  await panel(page).screenshot({ path: `${SHOTS}/${name}.png` });
}

test.describe.serial("P2-16 schedule exposure — authenticated PM browser scenario", () => {
  test.beforeAll(async () => {
    test.skip(!supabaseUrl || !serviceRoleKey || process.env.OPERATIONAL_FLOW_TEST_ALLOW_DESTRUCTIVE !== "true", "requires the disposable local stack");
    await seedTenant("a", [["owner", "owner"], ["pm", "pm"], ["viewer", "viewer"]]);
    await seedTenant("b", [["owner", "owner"]]);
  });

  test("STEP 01 empty: the PM sees the Schedule exposure section with no recorded exposure", async ({ page }) => {
    await signIn(page, tenants.a.users.pm);
    await openPanel(page, tenants.a);
    await expect(page.getByRole("region", { name: "Schedule exposure" })).toBeVisible();
    await expect(panel(page).getByTestId("schedule-exposure-empty")).toBeVisible();
    await expect(panel(page).getByRole("button", { name: "Evaluate exposure for dependency Design → Build" })).toBeVisible();
    await shot(page, "01-empty");
  });

  test("STEP 02 positive: a typed dependency change becomes a qualified, snapshot-bound exposure and a governed Recommendation", async ({ page }) => {
    await signIn(page, tenants.a.users.pm);
    await openPanel(page, tenants.a);
    await panel(page).getByRole("button", { name: "Evaluate exposure for dependency Design → Build" }).click();
    await expect(panel(page).getByTestId("schedule-exposure-recorded")).toContainText("No decision has been made.");
    const item = panel(page).getByTestId("schedule-exposure-item");
    await expect(item).toHaveCount(1);
    await expect(item).toContainText('Schedule exposure: milestone "Go-live" projected 4 day(s) past target');
    await expect(item).toContainText('Dependency "Design" → "Build" (finish to start) is active.');
    await expect(item).toContainText("The dependency network finishes the linked work 4 day(s) after the target date.");
    await expect(item.getByTestId("schedule-exposure-confidence")).toHaveText("90%");
    await expect(item).toContainText("Complete data");
    await expect(item).toContainText("Inference");
    await expect(item).toContainText("a Decision is recorded separately");
    await item.getByText("Supporting evidence").click();
    await expect(item.getByTestId("schedule-exposure-snapshot")).toHaveText(/^sha256:[a-f0-9]{64}$/);
    await expect(item).toContainText("schedule-engine:h9-v1");
    await shot(page, "02-qualified");

    // The governed Recommendation reaches the PM's canonical attention queue — undecided.
    const summary = await (await page.request.get(`/api/operational-flow?workspaceId=${tenants.a.workspaceId}&projectId=${tenants.a.projectId}`)).json();
    const recommendation = (summary.recommendations as Array<Record<string, unknown>>).find((r) => r.title === "Respond to schedule exposure");
    expect(recommendation?.status).toBe("proposed");
    expect((summary.decisions ?? []).length).toBe(0);
    expect((summary.materialActions ?? []).length).toBe(0);
    // …and it is the same Finding the PM sees in the "Needs your attention" queue.
    const attention = page.getByTestId("cc-section-needs-you");
    await expect(attention).toContainText('Schedule exposure: milestone "Go-live" projected 4 day(s) past target');
    await expect(attention).toContainText("Confirm whether the dependency is required as modelled");
    const cardOverflow = await attention.evaluate((el) => Array.from(el.querySelectorAll("*")).some((n) => n.scrollWidth > (n as HTMLElement).clientWidth + 1 && getComputedStyle(n).overflowX === "visible" && n.getBoundingClientRect().right > el.getBoundingClientRect().right + 1));
    expect(cardOverflow, "the Finding's rationale fits inside the attention card").toBe(false);
  });

  test("STEP 03 replay: evaluating the same change on the same schedule creates nothing new", async ({ page }) => {
    await signIn(page, tenants.a.users.pm);
    await openPanel(page, tenants.a);
    await panel(page).getByRole("button", { name: "Evaluate exposure for dependency Design → Build" }).click();
    await expect(panel(page).getByTestId("schedule-exposure-recorded")).toContainText("Already recorded for this schedule state and change");
    await expect(panel(page).getByTestId("schedule-exposure-item")).toHaveCount(1);
  });

  test("STEP 04 partial: missing planned dates are shown as partial coverage with lower confidence", async ({ page }) => {
    must(await admin.from("execution_tasks").update({ planned_start_date: null, planned_finish_date: null }).eq("id", tenants.a.schedule.c), "clear dates");
    await signIn(page, tenants.a.users.pm);
    await openPanel(page, tenants.a);
    await panel(page).getByRole("button", { name: "Evaluate exposure for dependency Design → Build" }).click();
    await expect(panel(page).getByTestId("schedule-exposure-recorded")).toBeVisible();
    const partial = panel(page).getByTestId("schedule-exposure-item").filter({ hasText: "Partial data" });
    await expect(partial).toHaveCount(1);
    await expect(partial.getByTestId("schedule-exposure-confidence")).toHaveText("60%");
    await expect(partial.getByTestId("schedule-exposure-coverage")).toContainText("1 of 3 task(s) have no planned start/finish");
    await shot(page, "04-partial");
    must(await admin.from("execution_tasks").update({ planned_start_date: day(1), planned_finish_date: day(6) }).eq("id", tenants.a.schedule.c), "restore dates");
  });

  test("STEP 05 degraded: invalid topology is refused visibly and nothing is recorded", async ({ page }) => {
    const cycle = randomUUID();
    must(await admin.from("execution_task_dependencies").insert({ id: cycle, workspace_id: tenants.a.workspaceId, project_id: tenants.a.projectId, predecessor_task_id: tenants.a.schedule.b, successor_task_id: tenants.a.schedule.a, dependency_type: "finish_to_start", status: "active", lag_days: 0 }), "cycle");
    await signIn(page, tenants.a.users.pm);
    await openPanel(page, tenants.a);
    const before = await panel(page).getByTestId("schedule-exposure-item").count();
    await panel(page).getByRole("button", { name: "Evaluate exposure for dependency Design → Build" }).click();
    const refused = panel(page).getByTestId("schedule-exposure-refused");
    await expect(refused).toBeVisible();
    await expect(refused).toHaveAttribute("role", "alert");
    await expect(refused).toContainText("Degraded: the schedule topology is invalid.");
    await expect(refused).toContainText("Cycle detected");
    await expect(refused).toContainText("No critical path was computed and nothing was recorded.");
    await expect(panel(page).getByTestId("schedule-exposure-item")).toHaveCount(before);
    mkdirSync(SHOTS, { recursive: true });
    await refused.screenshot({ path: `${SHOTS}/05-degraded-topology.png` });
    must(await admin.from("execution_task_dependencies").update({ status: "invalidated" }).eq("id", cycle), "invalidate cycle");
  });

  test("STEP 05b incomplete: a chain whose materialisation failed is a visible degraded state that resumes to a complete exposure", async ({ page }) => {
    // Reproduce a transient materialisation failure after Evidence committed: the real service,
    // with the real trusted writer, whose materialise call fails once. A new lag makes it a new snapshot.
    must(await admin.from("execution_task_dependencies").update({ lag_days: 2 }).eq("id", tenants.a.schedule.dep), "lag");
    const pmClient = createClient(supabaseUrl, process.env.OPERATIONAL_FLOW_TEST_ANON_KEY ?? "", { auth: { persistSession: false, autoRefreshToken: false } });
    const signedIn = await pmClient.auth.signInWithPassword({ email: tenants.a.users.pm, password });
    if (signedIn.error) throw new Error(signedIn.error.message);
    const failingWriter = new Proxy(admin, {
      get(target, prop) {
        if (prop === "rpc") return (name: string, args: Record<string, unknown>) => (name === "materialize_schedule_exposure_finding" ? Promise.resolve({ data: null, error: { message: "forced_materialize_failure" } }) : target.rpc(name, args));
        return Reflect.get(target, prop);
      },
    });
    await expect(evaluateAndRecordScheduleExposure(pmClient, failingWriter, { workspaceId: tenants.a.workspaceId, projectId: tenants.a.projectId, userId: tenants.a.userIds.pm, role: "pm" }, { kind: "dependency_change", entityId: tenants.a.schedule.dep })).rejects.toThrow(/forced_materialize_failure/);

    await signIn(page, tenants.a.users.pm);
    await openPanel(page, tenants.a);
    const incomplete = panel(page).getByTestId("schedule-exposure-incomplete");
    await expect(incomplete).toHaveCount(1);
    await expect(incomplete).toHaveAttribute("role", "alert");
    await expect(incomplete).toContainText("Schedule evaluation recorded, but the Finding and Recommendation did not finish materializing. No decision or action has been created.");
    await expect(incomplete).not.toContainText("Confidence");
    const completeBefore = await panel(page).getByTestId("schedule-exposure-item").count();
    mkdirSync(SHOTS, { recursive: true });
    await incomplete.screenshot({ path: `${SHOTS}/05b-incomplete.png` });
    await incomplete.getByRole("button", { name: "Resume materialization" }).click();
    await expect(panel(page).getByTestId("schedule-exposure-incomplete")).toHaveCount(0);
    await expect(panel(page).getByTestId("schedule-exposure-item")).toHaveCount(completeBefore + 1);
    await expect(panel(page).getByTestId("schedule-exposure-item").filter({ hasText: "6 day(s) past target" }).first()).toContainText("a Decision is recorded separately");
    must(await admin.from("execution_task_dependencies").update({ lag_days: 0 }).eq("id", tenants.a.schedule.dep), "restore lag");
  });

  test("STEP 06 error: a failed read is an explicit, retryable error — never an empty 'healthy' state", async ({ page }) => {
    await signIn(page, tenants.a.users.pm);
    await page.route("**/api/critical-path/schedule-exposure?**", (route) => route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ ok: false, error: "Schedule exposure could not be evaluated. Please retry." }) }));
    await page.goto(commandCenter(tenants.a));
    await expect(panel(page).getByRole("alert")).toContainText("Please retry.");
    await expect(panel(page).getByRole("button", { name: "Try again" })).toBeVisible();
    await expect(panel(page).getByTestId("schedule-exposure-empty")).toHaveCount(0);
    await shot(page, "06-error");
    await page.unroute("**/api/critical-path/schedule-exposure?**");
    await panel(page).getByRole("button", { name: "Try again" }).click();
    await expect(panel(page).getByTestId("schedule-exposure-item").first()).toBeVisible();
  });

  test("STEP 07 viewer: same-tenant read-only member sees the exposure but cannot evaluate", async ({ page }) => {
    await signIn(page, tenants.a.users.viewer);
    await openPanel(page, tenants.a);
    await expect(panel(page).getByTestId("schedule-exposure-item").first()).toBeVisible();
    await expect(panel(page).getByTestId("schedule-exposure-evaluate")).toHaveCount(0);
    await expect(panel(page)).toContainText("Only project owners, admins and PMs can evaluate schedule changes.");
    const post = await page.request.post("/api/critical-path/schedule-exposure", { data: { workspaceId: tenants.a.workspaceId, projectId: tenants.a.projectId, trigger: { kind: "dependency_change", entityId: tenants.a.schedule.dep } } });
    expect(post.status()).toBe(403);
  });

  test("STEP 08 cross-tenant: tenant B can neither read nor write tenant A, and sees only its own empty project", async ({ page }) => {
    await signIn(page, tenants.b.users.owner);
    const read = await page.request.get(`/api/critical-path/schedule-exposure?workspaceId=${tenants.a.workspaceId}&projectId=${tenants.a.projectId}`);
    expect(read.status()).toBe(403);
    const forged = await page.request.get(`/api/critical-path/schedule-exposure?workspaceId=${tenants.b.workspaceId}&projectId=${tenants.a.projectId}`);
    expect(forged.status()).toBe(403);
    const write = await page.request.post("/api/critical-path/schedule-exposure", { data: { workspaceId: tenants.a.workspaceId, projectId: tenants.a.projectId, trigger: { kind: "dependency_change", entityId: tenants.a.schedule.dep } } });
    expect(write.status()).toBe(403);
    const wrongProject = await page.request.post("/api/critical-path/schedule-exposure", { data: { workspaceId: tenants.b.workspaceId, projectId: tenants.b.projectId, trigger: { kind: "dependency_change", entityId: tenants.a.schedule.dep } } });
    expect(wrongProject.status()).toBe(404);
    await openPanel(page, tenants.b);
    await expect(panel(page).getByTestId("schedule-exposure-empty")).toBeVisible();
    await expect(panel(page)).not.toContainText("Partial data");
    const unauth = await page.context().request.fetch(`/api/critical-path/schedule-exposure?workspaceId=${tenants.a.workspaceId}&projectId=${tenants.a.projectId}`, { headers: { cookie: "" } });
    expect([401, 403]).toContain(unauth.status());
  });

  test("STEP 09 accessibility: labelled region, keyboard activation, status/alert semantics, unique ids", async ({ page }) => {
    await signIn(page, tenants.a.users.pm);
    await openPanel(page, tenants.a);
    const region = page.getByRole("region", { name: "Schedule exposure" });
    await expect(region.getByRole("heading", { name: "Schedule exposure", level: 2 })).toBeVisible();
    await expect(region).toContainText("Milestone (current state): Go-live");
    await expect(region).not.toContainText(/date change/i);
    const button = region.getByRole("button", { name: "Evaluate current state of milestone Go-live" });
    await button.focus();
    await expect(button).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(region.getByRole("status").or(region.getByRole("alert")).first()).toBeVisible();
    const duplicateIds = await page.evaluate(() => {
      const ids = Array.from(document.querySelectorAll("[data-testid='schedule-exposure-panel'] [id]")).map((el) => el.id);
      return ids.filter((id, i) => ids.indexOf(id) !== i);
    });
    expect(duplicateIds).toEqual([]);
    const details = region.getByText("Supporting evidence").first();
    await details.focus();
    await page.keyboard.press("Enter");
    await expect(region.getByTestId("schedule-exposure-snapshot").first()).toBeVisible();
  });

  test("STEP 10 responsive: the section is in the main flow at 390, 768 and 1440 px with no horizontal overflow", async ({ page }) => {
    await signIn(page, tenants.a.users.pm);
    for (const width of [390, 768, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      await openPanel(page, tenants.a);
      await panel(page).scrollIntoViewIfNeeded();
      await expect(panel(page).getByTestId("schedule-exposure-item").first()).toBeVisible();
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow, `no horizontal page scroll at ${width}px`).toBeLessThanOrEqual(0);
      const panelBox = await panel(page).boundingBox();
      expect(panelBox && panelBox.x >= 0 && panelBox.x + panelBox.width <= width + 1).toBeTruthy();
      await shot(page, `10-responsive-${width}`);
    }
  });
});
