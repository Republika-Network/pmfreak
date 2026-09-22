/**
 * P2-19 — authenticated browser scenarios for governed learning review.
 *
 * Real sign-in through /login, the real Workspace Command Center (the project-scoped surface that
 * already hosts P2-16's governed panel), the real routes, the real in-process governance runtime
 * and the real RPCs against the disposable local stack. Learning Candidates come from REAL, LIVE
 * P2-18 lineages (tests/e2e/helpers/p2-19-live-lineage.ts). Every P2-19 transition under test is
 * made by the signed-in user through the UI.
 *
 *   A owner ratifies   B admin ratifies (explicit expiry date)   C PM denied   D rejection
 *   E stale review     F revocation   G cross-tenant / IDOR refused   H generic knowledge_elevation denied
 *
 * Run: OPERATIONAL_FLOW_TEST_* env set (see scripts/check-p2-19-db.mts), then
 *   npx playwright test tests/e2e/p2-19-learning-review.spec.ts
 */
import { expect, test, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import {
  apiAs,
  buildLiveLineage,
  createLiveUser,
  liveStackConfigured,
  proposeCandidate,
  seedProject,
  seedWorkspace,
  serviceClient,
  type LiveUser,
  type Scope,
} from "./helpers/p2-19-live-lineage";

const SHOTS = "artifacts/p2-19/screenshots";
const password = `P2-19-browser-${randomUUID()}!`;
const suffix = `${Date.now()}-${randomUUID().slice(0, 6)}`;

type World = {
  owner: LiveUser; admin: LiveUser; pm: LiveUser; outsider: LiveUser;
  a1: Scope; a2: Scope; a3: Scope; b1: Scope;
  c1: string; c2: string; c3: string; decisionA1: string;
};
const w = {} as World;

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

const panel = (page: Page) => page.getByTestId("learning-review-panel");
const candidateCard = (page: Page, id: string) => panel(page).locator(`[data-testid="learning-review-candidate"][data-candidate-id="${id}"]`);

async function openPanel(page: Page, t: Scope) {
  await page.goto(`/workspaces/${t.workspaceId}/command-center?projectId=${t.projectId}`);
  await expect(panel(page)).toBeVisible({ timeout: 45_000 });
  await expect(panel(page).getByText("Loading learning candidates and project knowledge…")).toHaveCount(0, { timeout: 45_000 });
}

async function shot(page: Page, name: string) {
  mkdirSync(SHOTS, { recursive: true });
  await panel(page).screenshot({ path: `${SHOTS}/${name}.png` });
}

const knowledgeOf = async (candidateId: string) => {
  const { data, error } = await serviceClient.from("canonical_project_knowledge_records").select("id,status,validity_mode,effective_until,ratified_by").eq("candidate_id", candidateId);
  if (error) throw new Error(error.message);
  return data ?? [];
};
const reviewsOf = async (candidateId: string) => {
  const { data, error } = await serviceClient.from("canonical_learning_candidate_reviews").select("id,review_outcome,reviewed_by,reviewer_role,candidate_version").eq("candidate_id", candidateId);
  if (error) throw new Error(error.message);
  return data ?? [];
};

test.describe.serial("P2-19 governed learning review — authenticated browser scenarios", () => {
  test.beforeAll(async () => {
    test.skip(!liveStackConfigured, "requires the disposable local stack");
    test.setTimeout(600_000);
    w.owner = await createLiveUser("owner", suffix, password);
    w.admin = await createLiveUser("admin", suffix, password);
    w.pm = await createLiveUser("pm", suffix, password);
    w.outsider = await createLiveUser("outsider", suffix, password);
    const wsA = await seedWorkspace(w.owner, [[w.admin, "admin"], [w.pm, "pm"]], `A ${suffix}`);
    w.a1 = await seedProject(w.owner, wsA, `Learning A1 ${suffix}`);
    w.a2 = await seedProject(w.owner, wsA, `Learning A2 ${suffix}`);
    w.a3 = await seedProject(w.owner, wsA, `Learning A3 ${suffix}`);
    const wsB = await seedWorkspace(w.outsider, [], `B ${suffix}`);
    w.b1 = await seedProject(w.outsider, wsB, `Learning B1 ${suffix}`);
    const l1 = await buildLiveLineage(w.owner, w.a1, `a1-${suffix}`);
    w.decisionA1 = l1.decisionId;
    w.c1 = await proposeCandidate(w.owner, w.a1, l1.outcomeId);
    w.c2 = await proposeCandidate(w.pm, w.a2, (await buildLiveLineage(w.owner, w.a2, `a2-${suffix}`)).outcomeId);
    w.c3 = await proposeCandidate(w.pm, w.a3, (await buildLiveLineage(w.owner, w.a3, `a3-${suffix}`)).outcomeId);
  });

  test("C — a PM inspects the candidate but cannot ratify, reject or revoke", async ({ page }) => {
    await signIn(page, w.pm.email);
    await openPanel(page, w.a1);
    await expect(page.getByRole("region", { name: "Learning review & project knowledge" })).toBeVisible();
    const card = candidateCard(page, w.c1);
    await expect(card.getByTestId("learning-review-state-candidate")).toHaveText("Candidate — not knowledge");
    for (const fragment of ["Version 1", "Evidence tier: Single lineage", "Lineages: 1 (1 structurally independent)", "Observed results: 1 achieved", "weakest_linked_observation:v1", "Summary as of:", "Summary reflects current sources: yes", "Source project: this project", "Applicability: this project only"]) {
      await expect(card).toContainText(fragment);
    }
    await expect(card.getByTestId("learning-review-causality")).toContainText("Correlation only");
    await expect(panel(page).getByTestId("learning-review-ratify")).toHaveCount(0);
    await expect(panel(page).getByTestId("learning-review-reject")).toHaveCount(0);
    await expect(panel(page).getByTestId("learning-review-read-only")).toBeVisible();
    // The backend is authoritative regardless of what the UI renders.
    const direct = await page.request.post("/api/learning-candidates/review", { data: { workspaceId: w.a1.workspaceId, projectId: w.a1.projectId, candidateId: w.c1, candidateVersion: 1, candidateEvidenceDigest: "0".repeat(63) + "1", decision: "ratify", rationale: "PM attempt", validityMode: "until_revoked" } });
    expect(direct.status()).toBe(403);
    expect((await direct.json()).disposition).toBe("governance_denied");
    expect(await reviewsOf(w.c1)).toHaveLength(0);
    await shot(page, "c-pm-read-only");
  });

  test("E — a review opened on v1 is stale once new live evidence makes v2", async ({ page }) => {
    test.setTimeout(300_000);
    await signIn(page, w.owner.email);
    await openPanel(page, w.a1);
    const card = candidateCard(page, w.c1);
    await expect(card).toHaveAttribute("data-candidate-version", "1");
    // New live evidence arrives while the reviewer has v1 open.
    const l2 = await buildLiveLineage(w.owner, w.a1, `a1b-${suffix}`);
    await proposeCandidate(w.owner, w.a1, l2.outcomeId);
    await card.getByTestId("learning-review-rationale").fill("The pattern repeated in this project.");
    await card.getByTestId("learning-review-validity-until-revoked").check();
    await card.getByTestId("learning-review-ratify").click();
    await expect(panel(page).getByTestId("learning-review-feedback-stale")).toContainText("now version 2");
    await expect(panel(page).getByTestId("learning-review-feedback-stale")).toContainText("Nothing was recorded");
    expect(await reviewsOf(w.c1)).toHaveLength(0);
    expect(await knowledgeOf(w.c1)).toHaveLength(0);
    await expect(candidateCard(page, w.c1)).toHaveAttribute("data-candidate-version", "2");
    await shot(page, "e-stale-review");
  });

  test("A — the owner ratifies the current version; it becomes retrievable project knowledge", async ({ page }) => {
    await signIn(page, w.owner.email);
    await openPanel(page, w.a1);
    const card = candidateCard(page, w.c1);
    await expect(card).toHaveAttribute("data-candidate-version", "2");
    // Validation: a reason and an explicit validity choice are required; nothing is preselected.
    await card.getByTestId("learning-review-ratify").click();
    await expect(panel(page).getByTestId("learning-review-feedback-validation")).toContainText("Give a reason");
    await card.getByTestId("learning-review-rationale").fill("Two lineages in this project show the same result.");
    await card.getByTestId("learning-review-ratify").click();
    await expect(panel(page).getByTestId("learning-review-feedback-validation")).toContainText("Choose how long");
    await card.getByTestId("learning-review-validity-until-revoked").check();
    await card.getByTestId("learning-review-ratify").click();
    await expect(panel(page).getByTestId("learning-review-feedback-ratified")).toContainText("does not establish causation");
    await expect(candidateCard(page, w.c1).getByTestId("learning-review-state-ratified")).toHaveText("Ratified — version 2");
    const knowledge = panel(page).getByTestId("learning-review-knowledge");
    await expect(knowledge).toHaveCount(1);
    await expect(knowledge).toContainText("Ratified project knowledge");
    await expect(knowledge).toContainText("This project only");
    await expect(knowledge).toContainText("until revoked");
    await expect(knowledge).toContainText("correlation only");
    await expect(candidateCard(page, w.c1)).toContainText("the reviewer also created this candidate");
    const rows = await knowledgeOf(w.c1);
    expect(rows.map((r) => [r.status, r.validity_mode, r.effective_until, r.ratified_by])).toEqual([["active", "until_revoked", null, w.owner.id]]);
    const retrieved = await apiAs(w.owner, "GET", `/api/project-knowledge?workspaceId=${w.a1.workspaceId}&projectId=${w.a1.projectId}`);
    expect((retrieved.body.knowledge as Array<{ id: string }>).map((k) => k.id)).toEqual([rows[0].id]);
    await shot(page, "a-owner-ratified");
  });

  test("B — an admin ratifies a PM-proposed candidate with an explicit expiry date", async ({ page }) => {
    await signIn(page, w.admin.email);
    await openPanel(page, w.a2);
    const card = candidateCard(page, w.c2);
    await card.getByTestId("learning-review-rationale").fill("Holds for this project until the next phase.");
    await card.getByTestId("learning-review-validity-until-date").check();
    const inThirtyDays = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);
    await card.getByTestId("learning-review-expires-on").fill(inThirtyDays);
    await card.getByTestId("learning-review-ratify").click();
    await expect(panel(page).getByTestId("learning-review-feedback-ratified")).toBeVisible();
    const rows = await knowledgeOf(w.c2);
    expect(rows).toHaveLength(1);
    expect(rows[0].validity_mode).toBe("until_date");
    expect(new Date(rows[0].effective_until as string).getTime()).toBeGreaterThan(Date.now());
    const reviews = await reviewsOf(w.c2);
    expect(reviews.map((r) => [r.review_outcome, r.reviewer_role, r.reviewed_by])).toEqual([["ratified", "admin", w.admin.id]]);
    await expect(panel(page).getByTestId("learning-review-knowledge")).toContainText("until ");
    await shot(page, "b-admin-ratified-dated");
  });

  test("D — an admin rejects a candidate version; no knowledge exists", async ({ page }) => {
    await signIn(page, w.admin.email);
    await openPanel(page, w.a3);
    const card = candidateCard(page, w.c3);
    await card.getByTestId("learning-review-reject").click();
    await expect(panel(page).getByTestId("learning-review-feedback-validation")).toContainText("Give a reason");
    await card.getByTestId("learning-review-rationale").fill("One lineage is not enough to keep this for the project.");
    await card.getByTestId("learning-review-reject").click();
    await expect(panel(page).getByTestId("learning-review-feedback-rejected")).toContainText("No project knowledge was created");
    await expect(candidateCard(page, w.c3).getByTestId("learning-review-state-rejected")).toHaveText("Rejected — version 1");
    await expect(candidateCard(page, w.c3).getByTestId("learning-review-ratify")).toHaveCount(0);
    await expect(panel(page).getByTestId("learning-review-knowledge-empty")).toBeVisible();
    expect(await knowledgeOf(w.c3)).toHaveLength(0);
    const retrieved = await apiAs(w.admin, "GET", `/api/project-knowledge?workspaceId=${w.a3.workspaceId}&projectId=${w.a3.projectId}`);
    expect(retrieved.body.knowledge).toEqual([]);
    await shot(page, "d-rejected");
  });

  test("F — the owner revokes project knowledge; it leaves retrieval at once and stays in history", async ({ page }) => {
    await signIn(page, w.owner.email);
    await openPanel(page, w.a1);
    const knowledge = panel(page).getByTestId("learning-review-knowledge");
    await knowledge.getByTestId("learning-review-revoke").click();
    await expect(panel(page).getByTestId("learning-review-feedback-validation")).toContainText("revoking");
    await knowledge.getByTestId("learning-review-revoke-reason").fill("Later outcomes in this project no longer follow the pattern.");
    await knowledge.getByTestId("learning-review-revoke").click();
    await expect(panel(page).getByTestId("learning-review-feedback-revoked")).toBeVisible();
    await expect(panel(page).getByTestId("learning-review-knowledge")).toHaveCount(0);
    await expect(panel(page).getByTestId("learning-review-knowledge-revoked")).toHaveText("Revoked — not in effect");
    await expect(panel(page).getByTestId("learning-review-knowledge-inactive")).toContainText("Later outcomes in this project no longer follow the pattern.");
    await expect(candidateCard(page, w.c1).getByTestId("learning-review-state-knowledge-inactive")).toHaveText("Knowledge revoked — not in effect");
    expect((await knowledgeOf(w.c1)).map((r) => r.status)).toEqual(["revoked"]);
    const retrieved = await apiAs(w.owner, "GET", `/api/project-knowledge?workspaceId=${w.a1.workspaceId}&projectId=${w.a1.projectId}`);
    expect(retrieved.body.knowledge).toEqual([]);
    await shot(page, "f-revoked");
  });

  test("G — another tenant cannot read or act on this project's learning", async ({ page }) => {
    await signIn(page, w.outsider.email);
    const read = await page.request.get(`/api/project-knowledge?workspaceId=${w.a1.workspaceId}&projectId=${w.a1.projectId}`);
    expect(read.status()).toBe(403);
    const forged = await page.request.post("/api/learning-candidates/review", { data: { workspaceId: w.b1.workspaceId, projectId: w.b1.projectId, candidateId: w.c2, candidateVersion: 1, candidateEvidenceDigest: "a".repeat(64), decision: "reject", rationale: "IDOR" } });
    expect(forged.status()).toBe(404);
    const claimed = await page.request.post("/api/learning-candidates/review", { data: { workspaceId: w.a2.workspaceId, projectId: w.a2.projectId, candidateId: w.c2, candidateVersion: 1, candidateEvidenceDigest: "a".repeat(64), decision: "reject", rationale: "IDOR" } });
    expect(claimed.status()).toBe(403);
    const knowledgeId = (await knowledgeOf(w.c2))[0].id;
    const revoke = await page.request.post("/api/project-knowledge/revoke", { data: { workspaceId: w.b1.workspaceId, projectId: w.b1.projectId, knowledgeId, reason: "IDOR" } });
    expect(revoke.status()).toBe(404);
    expect((await knowledgeOf(w.c2)).map((r) => r.status)).toEqual(["active"]);
    await openPanel(page, w.b1);
    await expect(panel(page).getByTestId("learning-review-candidates-empty")).toBeVisible();
    await expect(panel(page).getByTestId("learning-review-knowledge-empty")).toBeVisible();
  });

  test("H — the generic knowledge_elevation Material Action is still denied", async () => {
    const now = new Date().toISOString();
    const denied = await apiAs(w.owner, "POST", "/api/operational-flow", {
      workspaceId: w.a1.workspaceId, projectId: w.a1.projectId, operation: "propose_material_action", decisionId: w.decisionA1,
      idempotencyKey: `p2-19-e2e-elevation:${suffix}`, actionClass: "knowledge_elevation", actionType: "prohibited_knowledge_elevation",
      targetResourceType: "project_schedule", targetResourceId: w.a1.projectId, intendedOperation: "propose_only",
      intendedEffect: "Attempt a generic knowledge elevation.", risk: "high", reversibility: "partially_reversible", sideEffect: "knowledge",
      justification: "P2-19 negative control.", createdAt: now, evaluationTime: now, expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    });
    expect(denied.status).toBe(201);
    expect(denied.body.evaluation?.governance_state).toBe("denied");
  });

  test("responsive — the review panel fits at 390, 768 and 1440 without horizontal overflow", async ({ page }) => {
    await signIn(page, w.admin.email);
    for (const width of [390, 768, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      await openPanel(page, w.a2);
      const overflow = await panel(page).evaluate((el) => el.scrollWidth > el.clientWidth + 1);
      expect(overflow, `no horizontal overflow at ${width}px`).toBe(false);
      await shot(page, `responsive-${width}`);
    }
  });
});
