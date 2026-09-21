/**
 * P2-17 — authenticated browser scenario for PMO Attention.
 *
 * Real sign-in through the product's /login form, the real canonical PMO Command Center
 * (/workspaces/[workspaceId]/pmos/[pmoId]/command-center), the real attention route and the real
 * canonical write paths against the disposable local stack.
 *
 * The service-role client is used ONLY for structural seeding a product operator would do in
 * setup — users, two workspaces, PMOs, projects and their PMO membership, and plain H7/H8
 * schedule rows (and, in STEP 04, a planner's schedule edit). Every canonical signal the PMO sees
 * is written by a signed-in PM through the product's own routes:
 *   - Atlas: a P2-16 schedule exposure recorded through /api/critical-path/schedule-exposure;
 *   - Orion: LIVE Evidence captured and derived through /api/operational-flow, then the real
 *     deterministic chain (Finding → governed Recommendation) via `run_chain`.
 * No fixture data is used, so nothing here may be labelled DEMO / FIXTURE — and STEP 02 checks
 * that nothing is.
 *
 * Run: OPERATIONAL_FLOW_TEST_* env set (see scripts/check-p2-16-db.mts), then
 *   npx playwright test tests/e2e/p2-17-pmo-attention.spec.ts
 */
import { expect, test, type Page } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";

const supabaseUrl = process.env.OPERATIONAL_FLOW_TEST_SUPABASE_URL ?? "";
const serviceRoleKey = process.env.OPERATIONAL_FLOW_TEST_SERVICE_ROLE_KEY ?? "";
const SHOTS = "artifacts/p2-17/screenshots";
const password = `P2-17-browser-${randomUUID()}!`;
const suffix = `${Date.now()}-${randomUUID().slice(0, 6)}`;
const day = (d: number) => new Date(Date.UTC(2026, 9, d)).toISOString();

const admin = createClient(supabaseUrl || "http://127.0.0.1:54321", serviceRoleKey || "missing", { auth: { persistSession: false, autoRefreshToken: false } });

type Tenant = {
  workspaceId: string;
  pmoId: string;
  siblingPmoId: string;
  projects: Record<"atlas" | "orion" | "bare" | "done" | "sibling", string>;
  users: Record<string, string>;
  schedule: { design: string; build: string; milestone: string; dep: string };
};
const tenants: Record<"a" | "b", Tenant> = {} as never;

function must<T>(result: { data: T; error: { message: string } | null }, label: string): T {
  if (result.error) throw new Error(`${label}: ${result.error.message}`);
  return result.data;
}

async function user(label: string) {
  const email = `p2-17-e2e-${label}-${suffix}@example.test`;
  const created = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (created.error) throw new Error(created.error.message);
  return { id: created.data.user!.id, email };
}

async function seedTenant(key: "a" | "b", roles: Array<[string, string]>) {
  const workspaceId = randomUUID();
  const actors = await Promise.all(roles.map(async ([label]) => user(`${key}-${label}`)));
  const ownerId = actors[0].id;
  const tag = key.toUpperCase();
  must(await admin.from("workspaces").insert({ id: workspaceId, name: `P2-17 ${tag} ${suffix}`, created_by_user_id: ownerId }), "workspace");
  for (let i = 0; i < roles.length; i += 1) {
    must(await admin.from("workspace_memberships").insert({ workspace_id: workspaceId, user_id: actors[i].id, role: roles[i][1] }), "membership");
  }
  const inviteId = randomUUID();
  const trialEnd = new Date(Date.now() + 365 * 86_400_000).toISOString();
  must(await admin.from("early_access_invites").insert({
    id: inviteId, invite_email: actors[0].email, invite_token_hash: createHash("sha256").update(`p2-17-consumed:${inviteId}`).digest("hex"),
    invite_note: "P2-17 browser scenario", inviter_user_id: ownerId, expires_at: trialEnd, accepted_at: new Date().toISOString(),
    requires_approval: false, workspace_id: workspaceId,
  }), "invite");
  must(await admin.from("trial_licenses").insert({ id: randomUUID(), invite_id: inviteId, workspace_id: workspaceId, trial_start_at: new Date().toISOString(), trial_end_at: trialEnd, trial_status: "active" }), "trial");

  const pmoId = randomUUID();
  const siblingPmoId = randomUUID();
  must(await admin.from("pmos").insert([
    { id: pmoId, workspace_id: workspaceId, name: `Delivery PMO ${tag}`, pmo_type: "company_pmo", status: "active", created_by_user_id: ownerId },
    { id: siblingPmoId, workspace_id: workspaceId, name: `Sibling PMO ${tag}`, pmo_type: "team_portfolio", status: "active", created_by_user_id: ownerId },
  ]), "pmos");
  const projects = { atlas: randomUUID(), orion: randomUUID(), bare: randomUUID(), done: randomUUID(), sibling: randomUUID() };
  const project = (id: string, name: string, pmo: string, status = "active") => ({
    id, workspace_id: workspaceId, user_id: ownerId, pmo_id: pmo, name: `${name} ${tag} ${suffix}`, status,
    onboarding_payload: { initialIngestion: { status: "completed" } },
  });
  must(await admin.from("projects").insert([
    project(projects.atlas, "Atlas", pmoId),
    project(projects.orion, "Orion", pmoId),
    project(projects.bare, "Bare", pmoId),
    project(projects.done, "Done", pmoId, "completed"),
    project(projects.sibling, "Sibling Secret", siblingPmoId),
  ]), "projects");

  // Atlas schedule: Build finishes on day 16 against a Go-live target of day 12 → 4-day slip.
  const s = { design: randomUUID(), build: randomUUID(), milestone: randomUUID(), dep: randomUUID() };
  const scope = { workspace_id: workspaceId, project_id: projects.atlas };
  must(await admin.from("project_milestones").insert({ id: s.milestone, ...scope, title: "Go-live", milestone_type: "go_live", status: "planned", target_date: day(12), baseline_date: day(12) }), "milestone");
  const task = (id: string, title: string, start: number, finish: number, milestoneId: string | null = null) => ({
    id, ...scope, title, description: title, status: "not_started", schedule_status: "scheduled", planned_start_date: day(start), planned_finish_date: day(finish), milestone_id: milestoneId,
  });
  must(await admin.from("execution_tasks").insert([task(s.design, "Design", 1, 6), task(s.build, "Build", 6, 16, s.milestone)]), "tasks");
  must(await admin.from("execution_task_dependencies").insert({ id: s.dep, ...scope, predecessor_task_id: s.design, successor_task_id: s.build, dependency_type: "finish_to_start", status: "active", lag_days: 0 }), "dependency");

  tenants[key] = { workspaceId, pmoId, siblingPmoId, projects, schedule: s, users: Object.fromEntries(roles.map(([label], i) => [label, actors[i].email])) };
}

async function signIn(page: Page, email: string) {
  // /login redirects an existing session away, so switching identity starts from a clean context.
  await page.context().clearCookies();
  await page.goto("/login");
  await page.getByPlaceholder("Email").fill(email);
  await page.getByPlaceholder("Password").fill(password);
  await Promise.all([
    page.waitForURL((url) => !url.pathname.startsWith("/login"), { timeout: 45_000 }),
    page.getByRole("button", { name: "Continue" }).click(),
  ]);
  expect(page.url()).not.toContain("/login");
}

/** LIVE Evidence through the product's intake → derivation → deterministic chain. */
async function recordLiveChain(page: Page, workspaceId: string, projectId: string, title: string, content: string) {
  const post = async (data: Record<string, unknown>) => {
    const response = await page.request.post("/api/operational-flow", { data: { workspaceId, projectId, ...data } });
    expect(response.ok(), `${String(data.operation)} → ${response.status()} ${await response.text()}`).toBeTruthy();
    return response.json();
  };
  const submission = randomUUID();
  const captured = await post({ operation: "capture_live_input", idempotencyKey: `live-capture:${submission}`, title, content, occurredAt: new Date().toISOString(), correlationId: randomUUID() });
  const derived = await post({
    operation: "derive_evidence", normalizedEventId: captured.normalizedEvent.id, idempotencyKey: `live-evidence:${submission}`,
    assertionType: "FACT", classification: "RISK", confidenceScore: 0.9, missingDataState: "COMPLETE", evaluatedAt: new Date().toISOString(),
  });
  expect(String(derived.evidence.fixture_state)).toBe("LIVE");
  const chain = await post({ operation: "run_chain", evidenceItemId: derived.evidence.id });
  expect(chain.chain.length).toBeGreaterThan(0);
}

const pmoCommandCenter = (t: Tenant) => `/workspaces/${t.workspaceId}/pmos/${t.pmoId}/command-center`;
const attention = (page: Page) => page.getByTestId("pmo-attention");
// The protected layout wraps each page's own <main> in its <main>; the outermost one holds everything rendered.
const pageContent = (page: Page) => page.locator("main").first();

async function openAttention(page: Page, t: Tenant) {
  await page.goto(pmoCommandCenter(t));
  // While Suspense streams the resolved section in, the loading fallback is briefly still in the DOM.
  await expect(page.locator('[data-testid="pmo-attention"]:not([aria-busy])')).toBeVisible({ timeout: 45_000 });
  await expect(attention(page)).toHaveCount(1, { timeout: 45_000 });
  await expect(attention(page).getByText("Loading PMO attention…")).toHaveCount(0, { timeout: 45_000 });
}

async function shot(page: Page, name: string, full = false) {
  mkdirSync(SHOTS, { recursive: true });
  if (full) await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true });
  else await attention(page).screenshot({ path: `${SHOTS}/${name}.png` });
}

test.describe.serial("P2-17 PMO attention — authenticated PMO browser scenario", () => {
  test.beforeAll(async () => {
    test.skip(!supabaseUrl || !serviceRoleKey || process.env.OPERATIONAL_FLOW_TEST_ALLOW_DESTRUCTIVE !== "true", "requires the disposable local stack");
    await seedTenant("a", [["owner", "owner"], ["pm", "pm"], ["viewer", "viewer"]]);
    await seedTenant("b", [["owner", "owner"]]);
  });

  test("STEP 01 real signals: a PM records a schedule exposure on Atlas and a governed chain on Orion", async ({ page }) => {
    const a = tenants.a;
    await signIn(page, a.users.pm);
    const exposure = await page.request.post("/api/critical-path/schedule-exposure", {
      data: { workspaceId: a.workspaceId, projectId: a.projects.atlas, trigger: { kind: "dependency_change", entityId: a.schedule.dep } },
    });
    expect(exposure.status(), await exposure.text()).toBe(201);
    await recordLiveChain(page, a.workspaceId, a.projects.orion, "Client scope request", "The client requested work outside the agreed scope, without formal approval.");
    // Alarming, real data in the SIBLING PMO's project and in tenant B: neither may reach this PMO.
    await recordLiveChain(page, a.workspaceId, a.projects.sibling, "Sibling blocker", "Delivery is blocked; the team cannot proceed.");
  });

  test("STEP 01b tenant B records its own real chain", async ({ page }) => {
    await signIn(page, tenants.b.users.owner);
    await recordLiveChain(page, tenants.b.workspaceId, tenants.b.projects.orion, "Tenant B blocker", "Delivery is blocked; the team cannot proceed.");
  });

  test("STEP 02 qualified attention: the PMO sees coverage, ordering, reasons, confidence and freshness", async ({ page }) => {
    const a = tenants.a;
    await signIn(page, a.users.viewer);
    await openAttention(page, a);
    const region = page.getByRole("region", { name: "PMO Attention" });
    await expect(region.getByRole("heading", { name: "PMO Attention", level: 2 })).toBeVisible();

    // Coverage: 4 projects in this PMO, 3 active; Bare has no canonical inputs → 2 / 3, incomplete.
    await expect(region.getByTestId("pmo-attention-coverage")).toHaveText("2 / 3 active projects");
    await expect(region).toContainText("Incomplete · of 4 in this PMO");
    await expect(region.getByTestId("pmo-attention-state")).toContainText("Partial assessment: PMFreak could assess 2 of 3 active projects. This is not a complete PMO assessment.");
    await expect(region.getByTestId("pmo-attention-count")).toHaveText("2");
    await expect(region.getByTestId("pmo-attention-confidence")).toHaveText(/^\d{1,3}%$/);
    await expect(region).toContainText(/Evaluated \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC · membership [0-9a-f]{12} \(4 projects\)/);

    // Why: Atlas's P2-16 exposure (4-day slip on the critical Go-live → high) and Orion's findings.
    const cards = region.getByTestId("pmo-attention-project");
    await expect(cards).toHaveCount(2);
    const atlas = cards.filter({ hasText: `Atlas A ${suffix}` });
    await expect(atlas).toContainText('Schedule exposure · High: "Go-live" projected 4 days past target (critical milestone). Recommendation awaiting decision.');
    await expect(atlas.locator('[data-rule="schedule.severity.high"]')).toContainText("Current");
    await expect(atlas).toContainText("evidence_items.confidence_score (schedule-coverage:v1)");
    await expect(atlas).toContainText("evaluated against the current schedule snapshot");
    const orion = cards.filter({ hasText: `Orion A ${suffix}` });
    await expect(orion.locator('[data-rule="finding.unresolved.high"]').first()).toContainText("Unresolved");
    await expect(orion).toContainText("Recommendation awaiting decision");
    await expect(orion).toContainText("operational_signals.confidence_score ÷ 100");

    // Not assessed, and why — never presented as healthy.
    const notAssessed = region.getByTestId("pmo-attention-not-assessed");
    await expect(notAssessed).toContainText(`Bare A ${suffix}`);
    await expect(notAssessed).toContainText("No canonical Evidence has been recorded for this project");
    await expect(notAssessed).toContainText(`Done A ${suffix}`);
    await expect(notAssessed).toContainText("Not evaluated (not active)");

    // Unsupported analyses are stated, not fabricated.
    await expect(region.getByTestId("pmo-attention-dependencies")).toHaveAttribute("data-support", "unsupported");
    await expect(region.getByTestId("pmo-attention-resources")).toContainText("Resource conflict analysis unavailable");

    // Nothing outside this PMO, nothing from tenant B, nothing labelled as fixture, no health claim.
    await expect(pageContent(page)).not.toContainText("Sibling Secret");
    await expect(pageContent(page)).not.toContainText("P2-17 B");
    await expect(region.getByTestId("pmo-attention-fixture")).toHaveCount(0);
    await expect(region).not.toContainText(/healthy|health score/i);
    await shot(page, "02-qualified-partial");
  });

  test("STEP 03 drill-down: the PMO opens the authorized project and its supporting canonical detail", async ({ page }) => {
    const a = tenants.a;
    await signIn(page, a.users.viewer);
    await openAttention(page, a);
    const atlas = attention(page).getByTestId("pmo-attention-project").filter({ hasText: `Atlas A ${suffix}` });
    await atlas.getByRole("link", { name: `Open project: Atlas A ${suffix}` }).click();
    await page.waitForURL(`**/workspaces/${a.workspaceId}/projects/${a.projects.atlas}/command-center`);
    await expect(pageContent(page)).toContainText(`Atlas A ${suffix}`);
    await expect(pageContent(page)).not.toContainText("isn't available to you");
    await shot(page, "03a-drill-project", true);

    await openAttention(page, a);
    await attention(page).getByTestId("pmo-attention-project").filter({ hasText: `Atlas A ${suffix}` }).getByRole("link", { name: "View supporting detail" }).first().click();
    await page.waitForURL((url) => url.pathname === `/workspaces/${a.workspaceId}/command-center` && url.searchParams.get("projectId") === a.projects.atlas);
    const panel = page.getByTestId("schedule-exposure-panel");
    await expect(panel).toBeVisible({ timeout: 45_000 });
    await expect(panel.getByTestId("schedule-exposure-item").first()).toContainText('milestone "Go-live" projected 4 day(s) past target', { timeout: 45_000 });
    await shot(page, "03b-drill-supporting-detail", true);
  });

  test("STEP 04 stale: a planner edits Atlas's schedule — the exposure is shown as superseded and no longer ranks Atlas", async ({ page }) => {
    const a = tenants.a;
    must(await admin.from("execution_tasks").update({ title: "Design (re-scoped)" }).eq("id", a.schedule.design), "planner edit");
    await signIn(page, a.users.viewer);
    await openAttention(page, a);
    // The superseded exposure was Atlas's only reason, so Atlas no longer needs attention…
    await expect(attention(page).getByTestId("pmo-attention-project").filter({ hasText: `Atlas A ${suffix}` })).toHaveCount(0);
    // …and is listed as assessed, with the exposure kept as superseded provenance.
    const atlas = attention(page).getByTestId("pmo-attention-quiet").locator(`[data-project-id="${a.projects.atlas}"]`);
    const reason = atlas.getByTestId("pmo-attention-superseded").locator('[data-rule="schedule.severity.high"]');
    await expect(atlas.getByTestId("pmo-attention-superseded")).toContainText("Superseded · not counted toward attention");
    await expect(reason.getByTestId("pmo-attention-freshness")).toHaveText("Stale");
    await expect(reason).toContainText("schedule changed since this evaluation (snapshot superseded)");
    await expect(atlas).toContainText("The schedule changed after its last recorded exposure evaluation");
    await expect(attention(page).getByTestId("pmo-attention-state")).toContainText("Some inputs are stale or superseded.");
    await shot(page, "04-stale-superseded");

    // The API — not only the view — carries the same semantics.
    const body = await (await page.request.get(`/api/pmos/${a.pmoId}/attention?workspaceId=${a.workspaceId}`)).json();
    expect(body.attention.attention.map((p: { projectId: string }) => p.projectId)).not.toContain(a.projects.atlas);
    const projected = body.attention.quiet.find((p: { projectId: string }) => p.projectId === a.projects.atlas);
    expect(projected.attentionLevel).toBeNull();
    expect(projected.reasons).toEqual([]);
    expect(projected.superseded.map((r: { ruleId: string; freshness: { state: string } }) => [r.ruleId, r.freshness.state])).toEqual([["schedule.severity.high", "stale"]]);
    expect(projected.missingInputs.map((m: { code: string }) => m.code)).toContain("schedule_reevaluation_needed");
  });

  test("STEP 05 caller metrics: forged query metrics do not change the server-derived projection", async ({ page }) => {
    const a = tenants.a;
    await signIn(page, a.users.viewer);
    const base = `/api/pmos/${a.pmoId}/attention?workspaceId=${a.workspaceId}`;
    const clean = await (await page.request.get(base)).json();
    expect(clean.ok).toBe(true);
    const forged = await page.request.get(`${base}&riskScore=0&healthScore=100&attentionScore=0&priority=low&resourceConflict=true&projectId=${tenants.b.projects.orion}&pmoId=${a.siblingPmoId}`);
    expect(forged.status()).toBe(200);
    const body = await forged.json();
    expect(body.attention.assessmentDigest).toBe(clean.attention.assessmentDigest);
    expect(body.attention.membership.digest).toBe(clean.attention.membership.digest);
    expect(JSON.stringify(body)).not.toContain("Sibling Secret");
    // The retired caller-metric endpoints refuse outright.
    const retired = await page.request.post("/api/personal-portfolio/prioritize", { data: { projectMetrics: [{ projectId: a.projects.atlas, healthScore: 100, riskScore: 0 }] } });
    expect(retired.status()).toBe(410);
    expect((await retired.json()).failureClass).toBe("caller_metrics_not_accepted");
  });

  test("STEP 06 tenancy: foreign PMO, workspace claim and project drill-down are refused without disclosure", async ({ page }) => {
    const a = tenants.a;
    const b = tenants.b;
    await signIn(page, b.users.owner);
    // Tenant B cannot open tenant A's PMO, under either workspace claim.
    for (const path of [pmoCommandCenter(a), `/workspaces/${b.workspaceId}/pmos/${a.pmoId}/command-center`]) {
      await page.goto(path);
      await expect(pageContent(page)).toContainText("This PMO isn't available to you");
      await expect(pageContent(page)).not.toContainText("Delivery PMO A");
      await expect(pageContent(page)).not.toContainText(`Atlas A ${suffix}`);
    }
    await shot(page, "06a-foreign-pmo-refused", true);
    const refusals = await Promise.all([
      page.request.get(`/api/pmos/${a.pmoId}/attention?workspaceId=${a.workspaceId}`),
      page.request.get(`/api/pmos/${a.pmoId}/attention?workspaceId=${b.workspaceId}`),
      page.request.get(`/api/pmos/${randomUUID()}/attention?workspaceId=${b.workspaceId}`),
    ]);
    const texts = await Promise.all(refusals.map((r) => r.text()));
    refusals.forEach((r) => expect(r.status()).toBe(404));
    expect(new Set(texts).size, "refusals are indistinguishable").toBe(1);
    expect(texts[0]).not.toContain("Atlas");
    // Tenant B's own PMO works and shows only its own projects.
    await openAttention(page, b);
    await expect(attention(page)).not.toContainText(`A ${suffix}`);

    // Tenant A's viewer cannot drill into tenant B's project by crafting a URL under A.
    await signIn(page, a.users.viewer);
    await page.goto(`/workspaces/${a.workspaceId}/projects/${b.projects.orion}/command-center`);
    await expect(pageContent(page)).not.toContainText(`Orion B ${suffix}`);
    await expect(pageContent(page)).toContainText(/isn't available|not available/i);
    // A sibling PMO's attention is scoped to that PMO — it never includes this PMO's projects, and vice versa.
    const sibling = await (await page.request.get(`/api/pmos/${a.siblingPmoId}/attention?workspaceId=${a.workspaceId}`)).json();
    expect(sibling.attention.membership.projectCount).toBe(1);
    expect(JSON.stringify(sibling.attention)).not.toContain(a.projects.atlas);
  });

  test("STEP 07 accessibility: labelled region, heading order, keyboard-reachable drill-down and coverage detail", async ({ page }) => {
    await signIn(page, tenants.a.users.viewer);
    await openAttention(page, tenants.a);
    const region = page.getByRole("region", { name: "PMO Attention" });
    await expect(region.getByRole("heading", { level: 3, name: "High attention" })).toBeVisible();
    const link = region.getByRole("link", { name: `Open project: Atlas A ${suffix}` });
    await link.focus();
    await expect(link).toBeFocused();
    const details = region.getByText("How complete is this view?");
    await details.focus();
    await page.keyboard.press("Enter");
    await expect(region.getByRole("table")).toBeVisible();
    await expect(region.getByRole("rowheader", { name: "Schedule exposure" })).toBeVisible();
    const duplicateIds = await page.evaluate(() => {
      const ids = Array.from(document.querySelectorAll("[data-testid='pmo-attention'] [id]")).map((el) => el.id);
      return ids.filter((id, i) => ids.indexOf(id) !== i);
    });
    expect(duplicateIds).toEqual([]);
  });

  test("STEP 08 responsive: the section fits at 390, 768 and 1440 px with no horizontal overflow", async ({ page }) => {
    await signIn(page, tenants.a.users.viewer);
    for (const width of [390, 768, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      await openAttention(page, tenants.a);
      await attention(page).scrollIntoViewIfNeeded();
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow, `no horizontal page scroll at ${width}px`).toBeLessThanOrEqual(0);
      const box = await attention(page).boundingBox();
      expect(box && box.x >= 0 && box.x + box.width <= width + 1).toBeTruthy();
      await shot(page, `08-responsive-${width}`);
    }
  });
});
