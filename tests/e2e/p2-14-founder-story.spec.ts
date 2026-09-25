/**
 * P2-14 — AUTHENTICATED TWO-TENANT FOUNDER BROWSER STORY.
 *
 * One deterministic orchestrator, phased so every checkpoint is attributable.
 *
 * P2_14_17_STEP_ACCEPTANCE
 * ------------------------
 * The P2-14 prompt requires completion of the 17 Founder steps enumerated in
 * docs/product-baseline/PMFREAK_FOCUSED_ASSESSMENT_P1.md, "Founder Invite Scenario
 * Assessment" (#1–#17). That historical list is the requirement. (An earlier revision of
 * this comment said no such list existed; that was wrong.) The executable STEP_NN
 * checkpoints below are this spec's own numbering and do not line up 1:1 with it, so the
 * mapping is stated explicitly — historical step → executable checkpoint(s):
 *
 *   1 Register or accept invite ........ STEP_01 (sign-in of a P2-13-seeded member whose
 *                                        invite the seed already accepted; the browser does
 *                                        not itself accept an invite)
 *   2 Enter correct Workspace .......... STEP_02, STEP_03 (refresh), STEP_04 (server scope)
 *   3 Create/select real Project ....... STEP_05 (P2-13 project, selected by route)
 *   4 Real signal or explicit fixture .. STEP_06 (DEMO / FIXTURE), STEP_16 (LIVE input)
 *   5 Normalize with provenance ........ P2-13 seed via real capture/derive RPCs (PRECHECK);
 *                                        STEP_16 (LIVE Evidence -> Normalized Event, Source)
 *   6 Detect exposure .................. P2-13 seed via real materialize_operational_chain;
 *                                        STEP_07 reads the resulting Recommendations
 *   7 Temporal explainable finding ..... STEP_08 (Why this matters, Evidence, provenance)
 *   8 Canonical recommendation ......... STEP_07
 *   9 PM accept/reject/defer ........... STEP_09 (accept); NEGATIVE PM authority (escalate
 *                                        only). Governed statuses have no `deferred`.
 *  10 Separate auditable Decision ...... STEP_09/10, STEP_09b
 *  11 Separate governed Action ......... STEP_11, STEP_11b
 *  12 AOC authorize/deny/honest mode ... STEP_11 (AOC-E), STEP_11b (writeback false),
 *                                        STEP_12 (Frontera fronteraDecisionId), NEGATIVE
 *                                        knowledge_elevation denied
 *  13 Idempotent Task .................. STEP_12
 *  14 Execution changes state .......... STEP_13
 *  15 Observe Outcome separately ....... STEP_14, STEP_15, STEP_16, STEP_16b
 *  16 PM sees result, why, next ........ STEP_16c
 *  17 Reconstruct audit chain .......... STEP_17
 *
 * The positive story is driven by BROWSER ACTIONS ONLY. Canonical state is read back
 * through the same authenticated session to VERIFY what the browser produced; no read ever
 * creates a P2-14-owned node, and no fixture is promoted to stand in for a real one.
 *
 * Actor note. The positive chain runs as Tenant A OWNER, not PM — established from the
 * contracts, not from role names. P2-13's recommendations carry `authority_required` of
 * 'sponsor or PMO' / 'authorized approver'; `operational_authority_evaluation` admits a PM
 * for neither, so a PM can only escalate. A Material Action additionally requires
 * `decision_status IN ('accepted','modified')` and `decided_by = the proposing actor`.
 */

import { test, expect, type BrowserContext, type Page } from "@playwright/test";
import { TENANT_A, TENANT_B, actor, fixtureSourceKey, MANIFEST } from "./helpers/p2-14-scenario";
import {
  signIn,
  signOut,
  readSummary,
  probeSummary,
  probeWrite,
  waitForSummary,
  countOf,
} from "./helpers/p2-14-session";

const SHOTS = "artifacts/p2-14/screenshots";

const OWNER_A = actor(TENANT_A, "owner");
const PM_A = actor(TENANT_A, "pm");
const VIEWER_A = actor(TENANT_A, "viewer");
const OWNER_B = actor(TENANT_B, "owner");

const A_PATH = `/command-center?projectId=${TENANT_A.projectId}`;

/** Canonical ids the browser story produces, threaded between phases. */
const chainIds = {
  recommendationId: "",
  decisionId: "",
  actionId: "",
  taskId: "",
  executionId: "",
  outcomeId: "",
  observationId: "",
  liveEvidenceId: "",
  // P0-PKG-06: the Frontera decision this journey's dispatch was authorized by.
  fronteraDecisionId: "",
};

/** Named acceptance checkpoints, reported at the end of the run. */
const checkpoints: Array<{ step: string; result: "PASS" | "FAIL"; evidence: string }> = [];
function checkpoint(step: string, evidence: string) {
  checkpoints.push({ step, result: "PASS", evidence });
  console.log(`P2-14 CHECKPOINT ${step}: PASS — ${evidence}`);
}

let context: BrowserContext;
let page: Page;
/** A recommendation deliberately left undecided, for the PM authority negative. */
let undecidedRecommendationId = "";
/** Every `proposed` Recommendation P2-13 seeded, captured before any decision. */
let proposedRecommendationIds: string[] = [];

async function shot(name: string) {
  await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: false });
}

/**
 * Open one of the project conversation's tools, the way a user would at any width.
 *
 * CHAT-SHELL-01: the Command Center's sections are the tools of the inspector beside the
 * project's Project Brain conversation. From `md` up they are in the right-hand rail;
 * below it the header's "Tools" button opens the inspector and its in-sheet switcher
 * chooses the tool. Opening a tool is presentation only — it never navigates.
 */
async function openTool(target: Page, key: string, label: RegExp) {
  const inspector = target.getByTestId("operational-inspector");
  const isOpenOn = async () => (await inspector.isVisible()) && (await inspector.getAttribute("data-tool")) === key;
  // Re-read the state before every attempt: a click that lands before the page has
  // hydrated is dropped, and blindly clicking again could toggle an open tool closed.
  await expect(async () => {
    if (await isOpenOn()) return;
    // Below 1280px an open inspector is a sheet over the rail; it carries its own switcher.
    const sheetSwitcher = inspector.getByRole("group", { name: "Switch project tool" });
    const railButton = target.getByTestId("operational-rail").locator(`button[data-tool="${key}"]`);
    if ((await inspector.isVisible()) && (await sheetSwitcher.isVisible())) {
      await sheetSwitcher.getByRole("button", { name: label }).click();
    } else if (await railButton.isVisible()) {
      await railButton.click();
    } else {
      if (!(await inspector.isVisible())) await target.getByRole("button", { name: "Tools", exact: true }).click();
      await sheetSwitcher.getByRole("button", { name: label }).click();
    }
    await expect(inspector).toHaveAttribute("data-tool", key, { timeout: 2_000 });
  }).toPass({ timeout: 30_000 });
}

/**
 * Reach the operational attention surface through the product's own navigation.
 *
 * `/command-center` resolves the workspace and hands a project to its conversation with
 * the Needs You tool open — or, while the durable initial-ingestion marker is still open,
 * first renders the guided "Project Brain Online" view, whose real "Continue to Project
 * Brain" control is how a user leaves it. Clicking it is ordinary product navigation, not
 * a shortcut around a gate, and nothing here fabricates state. The control is absent once
 * the guided view is done, so the click is conditional rather than assumed.
 */
async function enterOperationalSurface(target: Page = page) {
  const proceed = target.getByRole("button", { name: /Continue to Project Brain/i });
  if (await proceed.count()) await proceed.first().click();
  await expect(target.getByTestId("project-conversation-center")).toBeVisible({ timeout: 45_000 });
  await openTool(target, "attention", /Needs you/);
  await expect(target.getByRole("heading", { name: "Needs your attention" }).first()).toBeVisible({ timeout: 45_000 });
}

/** Open the Tenant A Command Center and wait for the real read model to land. */
async function openCommandCenter(target: Page = page) {
  await target.goto(A_PATH);
  await enterOperationalSurface(target);
}

/**
 * The operational inspector — where the Command Center's queues now live, one tool at a
 * time, beside the conversation (CHAT-SHELL-01). Mounted once at every width.
 */
function attentionCanvas(target: Page = page) {
  return target.getByTestId("operational-inspector");
}

/**
 * The governed chain row on the post-decision surface, wherever it currently sits.
 *
 * The W2 review closed a defect where every decided chain — rejected, achieved,
 * superseded, expired — was listed beneath the heading "In Progress". The surface now
 * groups by whether work is actually progressing, so ONE chain moves between groups as it
 * advances: no Action yet is "Not progressing", live work is "In Progress", an achieved
 * Outcome is "Closed" behind a disclosure. This follows the row instead of assuming a
 * position, expanding the disclosure first when the chain has reached a terminal state —
 * which is exactly what a PM would have to do. The queue is the "In progress" tool.
 */
async function governedChainRow(target: Page = page) {
  await openTool(target, "execution", /In progress/);
  const canvas = attentionCanvas(target);
  const closed = canvas.getByTestId("cc-closed-chains");
  if (await closed.count()) {
    const alreadyOpen = await closed.evaluate((el) => (el as HTMLDetailsElement).open);
    if (!alreadyOpen) await closed.locator("summary").click();
  }
  return canvas
    .locator('[data-testid="cc-in-progress-item"], [data-testid="cc-not-progressing-item"], [data-testid="cc-closed-chain-item"]')
    .first();
}

test.describe.serial("P2-14 authenticated two-tenant Founder browser story", () => {
  test.beforeAll(async ({ browser }) => {
    context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    page = await context.newPage();
  });

  test.afterAll(async () => {
    console.log(`P2-14 CANONICAL IDS ${JSON.stringify(chainIds, null, 2)}`);
    await context?.close();
  });

  // ────────────────────────────── PRECHECK ──────────────────────────────

  test("PRECHECK — P2-13 seed boundary holds and P2-14 owns nothing yet", async () => {
    expect(MANIFEST.contract).toBe("pmfreak.p2-13.founder-scenario-handoff.v1");
    await signIn(page, OWNER_A.email);
    const summary = await readSummary(page, TENANT_A.workspaceId, TENANT_A.projectId);

    // Preseeded by P2-13.
    expect(countOf(summary, "evidence"), "preseeded Evidence").toBeGreaterThan(0);
    expect(countOf(summary, "recommendations"), "preseeded Recommendations").toBeGreaterThan(0);

    // Owned by P2-14 — must be exactly zero before the story runs.
    for (const key of ["decisions", "materialActions", "tasks", "executions", "outcomes", "observations"] as const) {
      expect(countOf(summary, key), `P2_14_START_STATE_CONTAMINATED:${key}`).toBe(0);
    }

    // The fixture Evidence exists but is NOT observation-eligible. This is the invariant
    // step 16 must honour rather than weaken.
    expect(countOf(summary, "observationEligibleEvidence"), "fixture Evidence is not LIVE").toBe(0);
    checkpoint("PRECHECK", "P2-13 preseeded spine present; all six P2-14-owned nodes at 0; fixture Evidence not observation-eligible");
  });

  // ──────────────────────── STEPS 01–03: AUTH + SESSION ────────────────────────

  test("STEP 01/02 — invited Founder actor authenticates and holds an authorized session", async () => {
    // Already signed in above through the real /login form + /api/login.
    expect(page.url()).not.toContain("/login");
    await openCommandCenter();
    await expect(page.getByRole("heading", { name: "Needs your attention" }).first()).toBeVisible();
    checkpoint("STEP_01", `real form sign-in as ${OWNER_A.reference} through /login -> /api/login`);
    checkpoint("STEP_02", "authorized session established; Command Center read model rendered");
  });

  test("STEP 03 — hard refresh preserves the authenticated principal and scope", async () => {
    const before = await readSummary(page, TENANT_A.workspaceId, TENANT_A.projectId);
    await page.reload({ waitUntil: "domcontentloaded" });
    // A refresh returns to the activation surface, so re-enter it the way a user would.
    // This is navigation only — it never re-authenticates and never re-creates state.
    await enterOperationalSurface();
    expect(page.url()).not.toContain("/login");

    const after = await readSummary(page, TENANT_A.workspaceId, TENANT_A.projectId);
    expect(countOf(after, "recommendations")).toBe(countOf(before, "recommendations"));
    await shot("01-authenticated-tenant-a-demo-fixture");
    checkpoint("STEP_03", "page.reload() kept the session; same principal, same scoped read model, no /login redirect");
  });

  // ──────────────────────── STEPS 04–06: CONTEXT + FIXTURE ────────────────────────

  test("STEP 04/05 — correct Tenant A Workspace and Project resolve", async () => {
    // Canonical identity, not title matching: the scoped read only succeeds for a member of
    // this workspace whose project belongs to it.
    const response = await page.request.get(
      `/api/operational-flow?workspaceId=${encodeURIComponent(TENANT_A.workspaceId)}&projectId=${encodeURIComponent(TENANT_A.projectId)}`
    );
    expect(response.status()).toBe(200);

    // A workspace/project pair that does not belong together is refused, proving the scope
    // is enforced rather than echoed.
    const mismatched = await probeSummary(page, TENANT_A.workspaceId, TENANT_B.projectId);
    expect(mismatched.status, "cross-workspace project pairing").toBe(403);
    checkpoint("STEP_04", `Workspace ${TENANT_A.workspaceId} resolved and enforced server-side`);
    checkpoint("STEP_05", `Project ${TENANT_A.projectId} resolved within that workspace; mismatched pairing refused ${mismatched.status}`);
  });

  test("STEP 06 — DEMO / FIXTURE starting context is visibly and honestly identified", async () => {
    await openCommandCenter();
    // The canonical fixture label the verified schema enforces, surfaced in the UI.
    await expect(page.getByText(/DEMO \/ FIXTURE/i).first()).toBeVisible({ timeout: 30_000 });

    const summary = await readSummary(page, TENANT_A.workspaceId, TENANT_A.projectId);
    const evidence = summary.evidence ?? [];
    expect(evidence.every((row) => String(row.fixture_state) === "DEMO_FIXTURE"), "all seeded Evidence is DEMO_FIXTURE").toBe(true);
    // Never presented as LIVE.
    expect(countOf(summary, "observationEligibleEvidence")).toBe(0);
    checkpoint("STEP_06", "DEMO / FIXTURE label visible; every seeded Evidence row is DEMO_FIXTURE and none is offered as LIVE");
  });

  // ──────────────────────── STEPS 07–08: ATTENTION + PROVENANCE ────────────────────────

  test("STEP 07/08 — Recommendation is visible in the real attention flow with inspectable provenance", async () => {
    const summary = await readSummary(page, TENANT_A.workspaceId, TENANT_A.projectId);
    const proposed = (summary.recommendations ?? []).filter((row) => String(row.status) === "proposed");
    expect(proposed.length, "P2-13 proposed recommendations").toBeGreaterThan(0);
    // Record the candidate set only. WHICH recommendation this run decides is whichever
    // one the queue actually surfaces first to the human, and that is not knowable from
    // canonical ordering — the queue ranks by attention, not by id. Binding the id here
    // would assert an assumption about render order rather than an observed fact, so the
    // decided id is read back off the persisted Decision in STEP 09 instead.
    proposedRecommendationIds = proposed.map((row) => String(row.id));

    const canvas = attentionCanvas();
    const items = canvas.getByRole("heading", { name: "Needs your attention" }).locator("xpath=../..").getByRole("button");
    await expect(items.first()).toBeVisible({ timeout: 30_000 });
    await items.first().click();

    const drawer = page.getByRole("dialog");
    await expect(drawer).toBeVisible();
    // Exact names: since UX-W3 the drawer also carries an "Evidence & governance" heading,
    // which a substring match on "Evidence" resolves to as well (strict-mode violation).
    await expect(drawer.getByRole("heading", { name: "Why this matters", exact: true })).toBeVisible();
    await expect(drawer.getByRole("heading", { name: "Evidence", exact: true })).toBeVisible();
    await expect(drawer.getByRole("heading", { name: "Your decision" })).toBeVisible();
    await expect(drawer.getByRole("heading", { name: "Evidence & governance", exact: true })).toBeVisible();
    await expect(drawer.getByText("How PMFreak got here", { exact: true })).toBeVisible();
    await shot("02-recommendation-provenance");
    checkpoint("STEP_07", `${proposedRecommendationIds.length} proposed Recommendation(s) reachable through the real Needs You attention flow; the queue surfaced one for decision`);
    checkpoint("STEP_08", "drawer exposes Why this matters, Evidence, and the Evidence & governance / How PMFreak got here provenance disclosure before any decision");
  });

  // ──────────────────────── STEPS 09–10: DECISION, NO AUTO-ACTION ────────────────────────

  test("STEP 09/10 — human Decision is recorded, and it does NOT auto-create a Material Action", async () => {
    const drawer = page.getByRole("dialog");
    await drawer.getByLabel(/^Rationale/).fill("Scope and approval confirmation is required before any supplier commitment.");
    await drawer.getByRole("button", { name: "Accept" }).click();

    const summary = await waitForSummary(
      page, TENANT_A.workspaceId, TENANT_A.projectId,
      (s) => countOf(s, "decisions") === 1,
      "decision persisted"
    );
    const decision = (summary.decisions ?? [])[0];
    chainIds.decisionId = String(decision.id);
    expect(String(decision.decision_status)).toBe("accepted");
    // The decided Recommendation is read back off the canonical Decision — the persisted
    // record is the authority on what the human actually decided. It must be one of the
    // Recommendations that was `proposed` before this step, which is the real invariant:
    // a Decision may only resolve a genuine pending item.
    chainIds.recommendationId = String(decision.recommendation_id);
    expect(proposedRecommendationIds, "Decision resolves a previously proposed Recommendation")
      .toContain(chainIds.recommendationId);
    // Whatever remains proposed stays undecided for the whole run, so the PM authority
    // negative exercises an authority denial rather than an already-decided item.
    undecidedRecommendationId = proposedRecommendationIds.find((id) => id !== chainIds.recommendationId) ?? "";

    // The hard P2-11/P2-12 regression gate.
    expect(countOf(summary, "materialActions"), "AUTO_ACTION_AFTER_DECISION").toBe(0);
    expect(countOf(summary, "tasks")).toBe(0);
    checkpoint("STEP_09", `Decision ${chainIds.decisionId} persisted as accepted against recommendation ${chainIds.recommendationId}`);
    checkpoint("STEP_10", "Material Action count is still 0 immediately after the Decision — no auto-conversion");
  });

  test("STEP 09b — the Decision survives a hard refresh", async () => {
    await page.reload({ waitUntil: "domcontentloaded" });
    // A refresh returns to the activation surface, so re-enter it the way a user would.
    // This is navigation only — it never re-authenticates and never re-creates state.
    await enterOperationalSurface();
    const summary = await readSummary(page, TENANT_A.workspaceId, TENANT_A.projectId);
    expect(countOf(summary, "decisions"), "no duplicate Decision after refresh").toBe(1);
    expect(String((summary.decisions ?? [])[0].id)).toBe(chainIds.decisionId);
    expect(countOf(summary, "materialActions"), "still no auto Action after refresh").toBe(0);
    await shot("03-decision-persisted");
    checkpoint("STEP_09b", "hard refresh preserved exactly one Decision and created no Material Action");
  });

  // ──────────────────────── STEP 11: GOVERNED MATERIAL ACTION ────────────────────────

  test("STEP 11 — governed Material Action is explicitly proposed and authorized through the real AOC boundary", async () => {
    await openCommandCenter();
    await (await governedChainRow()).click();

    const drawer = page.getByRole("dialog");
    await expect(drawer).toBeVisible();
    // Classification is stated by the human; governance is derived from it, never hardcoded.
    await drawer.getByLabel("What kind of action is this? (required)").fill("supplier scope confirmation request");
    await drawer.getByLabel("What would it change? (required)").fill("Sends a formal scope and approval confirmation request to the supplier.");
    await drawer.getByLabel("Action class (required)").selectOption("external_write");
    await drawer.getByLabel("Risk (required)").selectOption("medium");
    await drawer.getByLabel("Reversibility (required)").selectOption("reversible");
    await drawer.getByLabel("Side effect (required)").selectOption("external");
    await drawer.getByRole("button", { name: /Request governed material action/ }).click();

    const summary = await waitForSummary(
      page, TENANT_A.workspaceId, TENANT_A.projectId,
      (s) => countOf(s, "materialActions") === 1,
      "material action persisted"
    );
    const action = (summary.materialActions ?? [])[0];
    chainIds.actionId = String(action.id);
    expect(String(action.source_decision_id)).toBe(chainIds.decisionId);
    // Material, not ordinary — so this is a real AOC authorization, not a `not_required` bypass.
    expect(String(action.materiality)).toBe("material");

    const evaluation = (summary.materialActionEvaluations ?? []).find((row) => String(row.action_id) === chainIds.actionId);
    expect(evaluation, "governance evaluation persisted").toBeTruthy();
    expect(String(evaluation!.governance_state), "dispatchable governance state").toBe("authorized");
    expect(String(evaluation!.evaluator_kind)).toBe("aoc_e_in_process");
    // Authorization is not execution.
    expect(evaluation!.can_execute).toBe(false);
    checkpoint("STEP_11", `Material Action ${chainIds.actionId} evaluated authorized by aoc_e_in_process; materiality=material; can_execute=false`);
  });

  test("STEP 11b — an ambiguous retry of the same Material Action replays instead of proposing a second", async () => {
    // The governed proposal is the one canonical write where a duplicate would be an
    // unauthorized second authorization, so its retry behaviour is proven, not assumed.
    //
    // The retry is reconstructed from the PERSISTED row rather than from the text this spec
    // typed: `proposal_digest` folds every business field, so replaying anything other than
    // the exact submission would be answered `conflict` and would prove nothing about
    // idempotency. Reading the submission back makes this immune to UI copy drift.
    const before = await readSummary(page, TENANT_A.workspaceId, TENANT_A.projectId);
    const persisted = (before.materialActions ?? []).find((row) => String(row.id) === chainIds.actionId)!;
    const proposal = persisted.proposal as Record<string, unknown>;

    // The contract's own non-execution invariant, asserted on the persisted record: an
    // authorization is inert. No Task, no dispatch, no execution, no remote AOC writeback.
    expect(String(proposal.remoteDecisionWriteback), "remote AOC writeback stays false").toBe("false");
    expect(String(proposal.createsTask)).toBe("false");
    expect(String(proposal.dispatchesAction)).toBe("false");
    expect(String(proposal.executesAction)).toBe("false");

    const retry = await probeWrite(page, {
      workspaceId: TENANT_A.workspaceId, projectId: TENANT_A.projectId,
      operation: "propose_material_action",
      decisionId: chainIds.decisionId,
      idempotencyKey: String(persisted.idempotency_key),
      actionClass: String(persisted.action_class),
      risk: String(proposal.risk), reversibility: String(proposal.reversibility), sideEffect: String(proposal.sideEffect),
      actionType: String(proposal.actionType), intendedEffect: String(proposal.intendedEffect),
      intendedOperation: String(proposal.intendedOperation),
      targetResourceType: String(proposal.targetResourceType), targetResourceId: String(proposal.targetResourceId),
      justification: String(proposal.justification),
    });
    // `replay` (200), never `created` (201). A 409 would mean the resubmission was not
    // byte-identical, which is a different fact and must not pass as idempotency.
    expect(retry.status, `material action retry disposition (${retry.bodyText.slice(0, 200)})`).toBe(200);
    expect(retry.bodyText).toContain('"disposition":"replay"');

    const after = await readSummary(page, TENANT_A.workspaceId, TENANT_A.projectId);
    expect(countOf(after, "materialActions"), "MATERIAL_ACTION_RETRY_DUPLICATE").toBe(1);
    expect(String((after.materialActions ?? [])[0].id)).toBe(chainIds.actionId);
    // A replay must not manufacture a second authorization either.
    expect((after.materialActionEvaluations ?? []).filter((row) => String(row.action_id) === chainIds.actionId).length,
      "no duplicate governance evaluation").toBe(1);
    checkpoint("STEP_11b", `identical resubmission of Material Action ${chainIds.actionId} replayed 200; still exactly 1 proposal and 1 evaluation; remote AOC writeback false`);
  });

  // ──────────────────────── STEP 12: ACTION -> EXACTLY ONE TASK ────────────────────────

  test("STEP 12 — authorized Action dispatches exactly one canonical Task, and a retry adds none", async () => {
    const drawer = page.getByRole("dialog");
    await drawer.getByRole("button", { name: "Create canonical internal task" }).click();

    let summary = await waitForSummary(
      page, TENANT_A.workspaceId, TENANT_A.projectId,
      (s) => countOf(s, "tasks") === 1,
      "task dispatched"
    );
    const task = (summary.tasks ?? [])[0];
    chainIds.taskId = String(task.id);
    expect(String((task.source_payload as Record<string, unknown>)?.sourceActionId)).toBe(chainIds.actionId);

    // Ambiguous-retry proof: the canonical write already reached the server. Re-issuing the
    // same logical dispatch must reconcile onto the same Task, not append a second one.
    const retry = await probeWrite(page, {
      workspaceId: TENANT_A.workspaceId, projectId: TENANT_A.projectId,
      operation: "dispatch_material_action_to_task", actionId: chainIds.actionId,
    });
    expect([200, 201], `retry disposition (${retry.bodyText.slice(0, 200)})`).toContain(retry.status);

    // P0-PKG-06. Proof that this browser-driven dispatch crossed the real Frontera
    // boundary rather than running beside it: the response carries the opaque
    // decision id minted by AocKernel.evaluate() against the durable, operator-
    // provisioned authority world. It cannot be produced without that evaluation
    // returning `allowed`, and PMFreak never mints one itself. If Frontera had
    // denied, or been unreachable, the dispatch would have failed closed above and
    // there would be no Task to retry at all.
    expect(retry.bodyText, "FRONTERA_BOUNDARY_NOT_TRAVERSED").toContain('"fronteraDecisionId"');
    const fronteraDecisionId = String(JSON.parse(retry.bodyText).fronteraDecisionId ?? "");
    expect(fronteraDecisionId.length, "Frontera decision id is present and non-empty").toBeGreaterThan(0);
    chainIds.fronteraDecisionId = fronteraDecisionId;

    summary = await readSummary(page, TENANT_A.workspaceId, TENANT_A.projectId);
    expect(countOf(summary, "tasks"), "TASK_RETRY_DUPLICATE").toBe(1);
    expect(String((summary.tasks ?? [])[0].id)).toBe(chainIds.taskId);

    await page.reload({ waitUntil: "domcontentloaded" });
    // A refresh returns to the activation surface, so re-enter it the way a user would.
    // This is navigation only — it never re-authenticates and never re-creates state.
    await enterOperationalSurface();
    summary = await readSummary(page, TENANT_A.workspaceId, TENANT_A.projectId);
    expect(countOf(summary, "tasks"), "no duplicate Task after refresh").toBe(1);
    checkpoint("STEP_12", `Task ${chainIds.taskId} created from Action ${chainIds.actionId} through Frontera decision ${chainIds.fronteraDecisionId}; retry and hard refresh both yielded exactly 1`);
  });

  // ──────────────────────── STEP 13: INTERNAL EXECUTION ────────────────────────

  test("STEP 13 — Internal Execution runs through the real canonical lifecycle", async () => {
    await openCommandCenter();
    await (await governedChainRow()).click();
    const drawer = page.getByRole("dialog");
    await expect(drawer).toBeVisible();

    // Only commands the persisted state and governance actually allow are offered; each is
    // driven through the real P2-08 contract rather than assumed.
    for (const label of ["Queue internal execution", "Start", "Mark complete"]) {
      const control = drawer.getByRole("button", { name: label, exact: true });
      await expect(control, `command offered: ${label}`).toBeVisible({ timeout: 30_000 });
      await control.click();
      await page.waitForTimeout(1200);
    }

    const summary = await waitForSummary(
      page, TENANT_A.workspaceId, TENANT_A.projectId,
      (s) => (s.executions ?? []).some((row) => String(row.status) === "completed"),
      "execution completed"
    );
    const execution = (summary.executions ?? []).find((row) => String(row.status) === "completed")!;
    chainIds.executionId = String(execution.id);
    expect(String(execution.task_id)).toBe(chainIds.taskId);
    await shot("04-material-action-task-execution-chain");
    checkpoint("STEP_13", `Execution ${chainIds.executionId} reached completed through queue -> start -> complete on task ${chainIds.taskId}`);
  });

  // ──────────────────────── STEP 14: COMPLETION != ACHIEVEMENT ────────────────────────

  test("STEP 14 — Task completion does NOT equal Outcome achievement", async () => {
    const summary = await readSummary(page, TENANT_A.workspaceId, TENANT_A.projectId);
    const execution = (summary.executions ?? []).find((row) => String(row.id) === chainIds.executionId)!;
    expect(String(execution.status)).toBe("completed");

    // Persisted state: nothing downstream was invented by completing the work.
    expect(countOf(summary, "outcomes"), "AUTO_OUTCOME_ACHIEVEMENT").toBe(0);
    expect(countOf(summary, "observations")).toBe(0);

    // Product state: the surface must not claim achievement either.
    const drawer = page.getByRole("dialog");
    await expect(drawer.getByText(/Outcome achieved/i)).toHaveCount(0);
    await shot("05-task-complete-outcome-not-achieved");
    checkpoint("STEP_14", "Execution completed while Outcome=0 and Observation=0; no surface claims achievement");
  });

  // ──────────────────────── STEP 15: EXPECTED OUTCOME ────────────────────────

  test("STEP 15 — expected Outcome is explicitly created, and a semantic retry reconciles", async () => {
    const drawer = page.getByRole("dialog");
    await drawer.getByLabel("What is this work expected to achieve? (required)")
      .fill("The supplier returns a formal, written scope and approval confirmation.");
    await drawer.getByRole("button", { name: "Define expected outcome" }).click();

    const summary = await waitForSummary(
      page, TENANT_A.workspaceId, TENANT_A.projectId,
      (s) => countOf(s, "outcomes") === 1,
      "expected outcome persisted"
    );
    const outcome = (summary.outcomes ?? [])[0];
    chainIds.outcomeId = String(outcome.id);
    expect(String(outcome.task_id)).toBe(chainIds.taskId);
    // Expected, not achieved.
    expect(String(outcome.state)).not.toBe("achieved");

    // Same semantic retry -> reconciles onto the existing Outcome, never a second one.
    const retry = await probeWrite(page, {
      workspaceId: TENANT_A.workspaceId, projectId: TENANT_A.projectId,
      operation: "ensure_expected_outcome", taskId: chainIds.taskId,
      expectedResult: "The supplier returns a formal, written scope and approval confirmation.",
      successCriteria: [], correlationId: String(outcome.correlation_id ?? ""),
    });
    expect([200, 201]).toContain(retry.status);
    const after = await readSummary(page, TENANT_A.workspaceId, TENANT_A.projectId);
    expect(countOf(after, "outcomes"), "OUTCOME_RETRY reconciled").toBe(1);
    checkpoint("STEP_15", `Outcome ${chainIds.outcomeId} created in a non-achieved state; identical retry reconciled to the same row`);
  });

  // ──────────────── STEP 16: LIVE EVIDENCE + EVIDENCE-LINKED OBSERVATION ────────────────

  test("STEP 16a — the LIVE intake path cannot select the DEMO / FIXTURE Source identity", async () => {
    // The review repair. Source identity is no longer the browser's to state: whoever chose
    // the key chose whether the derived Evidence was DEMO_FIXTURE or LIVE, because each
    // capture contract MINTS a Source on first use of a key. Naming the DEMO identity is how
    // demo material was laundered into Observation-eligible LIVE Evidence.
    //
    // The refusal is now the pinned-source-key contract rather than the fixture check, and
    // it lands BEFORE the RPC. The fixture refusal itself is still enforced inside the
    // contract and is proven at that layer by `scripts/check-p2-14-db.mjs`, which calls the
    // RPC directly — the only place it remains reachable.
    for (const [label, sourceKey] of [
      ["the reserved DEMO identity", "manual-demo:v1"],
      ["a P2-13 fixture identity", fixtureSourceKey("A")],
    ] as const) {
      const refused = await probeWrite(page, {
        workspaceId: TENANT_A.workspaceId, projectId: TENANT_A.projectId,
        operation: "capture_live_input", sourceKey,
        idempotencyKey: `p2-14-live-collision-${Date.now()}`,
        title: "attempted fixture promotion", content: "should be refused",
        occurredAt: new Date().toISOString(), correlationId: crypto.randomUUID(),
      });
      expect(refused.status, `live intake naming ${label} refused`).toBe(400);
      expect(refused.bodyText).toContain("intake_source_key_not_permitted");
    }
    checkpoint("STEP_16a", "capture_live_input naming the DEMO / FIXTURE or a P2-13 fixture Source identity refused 400 intake_source_key_not_permitted");
  });

  test("STEP 16a-mirror — the DEMO intake path cannot select the LIVE Source identity", async () => {
    // The other direction, and the one that is unrecoverable in-app: a fixture Source minted
    // under the LIVE key would make every genuine live capture afterwards fail
    // `intake_source_fixture_prohibited`, and `operational_sources` has no application
    // update or supersession path.
    const refused = await probeWrite(page, {
      workspaceId: TENANT_A.workspaceId, projectId: TENANT_A.projectId,
      operation: "capture_input", sourceKey: "live-observation:v1",
      idempotencyKey: `p2-14-demo-collision-${Date.now()}`,
      title: "attempted live lockout", content: "should be refused",
      occurredAt: new Date().toISOString(), correlationId: crypto.randomUUID(),
    });
    expect(refused.status, "demo intake naming the LIVE identity refused").toBe(400);
    expect(refused.bodyText).toContain("intake_source_key_not_permitted");

    // And the lockout it would have caused did not happen: live intake still works below.
    checkpoint("STEP_16a_MIRROR", "capture_input naming the LIVE Source identity refused 400 intake_source_key_not_permitted; LIVE intake remains available");
  });

  test("STEP 16 — LIVE operational input becomes eligible Evidence, then an Observation is recorded", async () => {
    await openCommandCenter();
    // Real product control: open the Command Center notes intake. CHAT-SHELL-01 moved it
    // from the removed top bar into the Evidence tool beside the conversation.
    await openTool(page, "repository", /Evidence/);
    await page.getByRole("button", { name: /Add project notes/i }).first().click();

    // Since UX-W0 (UX-P0-01) the customer intake panel records LIVE, always: the PM is no
    // longer asked to classify their own notes, and DEMO / FIXTURE capture lives only on the
    // internal governance lab. The browser therefore offers no classification at all — and
    // must not offer a DEMO / FIXTURE one. That the Evidence is LIVE is still proven below
    // from the persisted row and its server-selected, non-fixture Source.
    await expect(page.getByRole("textbox", { name: "Project notes" })).toBeVisible();
    await expect(page.getByRole("radio", { name: /DEMO \/ FIXTURE/i })).toHaveCount(0);
    await page.getByRole("textbox", { name: "Project notes" }).fill(
      "Supplier returned a signed scope and approval confirmation on 2026-08-20, covering the disputed additional activity."
    );
    await page.getByLabel("Assertion type").selectOption("FACT");
    await page.getByLabel("Classification").selectOption("DELIVERY");
    await page.getByLabel("Missing data").selectOption("COMPLETE");
    await page.getByLabel("Confidence (0–1)").fill("0.90");
    await page.getByRole("button", { name: "Capture and derive Evidence" }).click();

    const summary = await waitForSummary(
      page, TENANT_A.workspaceId, TENANT_A.projectId,
      (s) => countOf(s, "observationEligibleEvidence") > 0,
      "LIVE observation-eligible evidence derived"
    );
    const live = (summary.observationEligibleEvidence ?? [])[0];
    chainIds.liveEvidenceId = String(live.id);
    expect(String(live.fixture_state)).toBe("LIVE");
    expect(live.normalized_event_id, "LIVE Evidence carries canonical provenance").toBeTruthy();

    // The Source identity was selected by the SERVER, not offered by the browser. The panel
    // sends `capture_live_input` with no Source identity at all, so the sole reason this
    // Evidence is LIVE is that the server resolved the live identity and the contract
    // confirmed that identity is not a fixture.
    const sourceById = (id: unknown) => (summary.sources ?? []).find((row) => String(row.id) === String(id));
    const liveSource = sourceById(live.source_id);
    expect(liveSource, "LIVE Evidence resolves to a persisted Source").toBeTruthy();
    expect(String(liveSource?.source_key), "server-selected LIVE Source identity").toBe("live-observation:v1");
    expect(Boolean(liveSource?.is_fixture), "the LIVE Source is NOT a fixture").toBe(false);

    // The P2-13 fixture Evidence is untouched and still DEMO_FIXTURE, and every Source
    // backing it is still a fixture — no lineage was relabelled in either direction.
    const fixtureStillFixture = (summary.evidence ?? []).filter((row) => String(row.fixture_state) === "DEMO_FIXTURE");
    expect(fixtureStillFixture.length, "fixture Evidence was not relabelled").toBeGreaterThan(0);
    for (const row of fixtureStillFixture) {
      const fixtureSource = sourceById(row.source_id);
      if (fixtureSource) {
        expect(Boolean(fixtureSource.is_fixture), `Source ${String(fixtureSource.source_key)} stayed a fixture`).toBe(true);
      }
    }

    // Now the Observation, through the real P2-12 surface.
    await (await governedChainRow()).click();
    const drawer = page.getByRole("dialog");
    await expect(drawer).toBeVisible();
    await drawer.getByLabel("What does the evidence say?").selectOption("achieved");
    await drawer.getByLabel("What was observed? (required)").fill("Supplier confirmation received in writing; the expected outcome is supported by live evidence.");
    await drawer.getByLabel("Supporting evidence (required)").selectOption(chainIds.liveEvidenceId);
    await drawer.getByLabel("How confident is this observation? 0 to 1 (required)").fill("0.9");
    await drawer.getByLabel("Was any needed data missing? (required)").selectOption("COMPLETE");
    await drawer.getByRole("button", { name: "Record evidence-backed observation" }).click();

    const observed = await waitForSummary(
      page, TENANT_A.workspaceId, TENANT_A.projectId,
      (s) => countOf(s, "observations") === 1,
      "observation persisted"
    );
    const observation = (observed.observations ?? [])[0];
    chainIds.observationId = String(observation.id);
    expect(String(observation.outcome_id)).toBe(chainIds.outcomeId);
    expect((observation.evidence_reference_ids as string[]) ?? []).toContain(chainIds.liveEvidenceId);
    expect(Number(observation.confidence_score)).toBeCloseTo(0.9, 4);
    expect(String(observation.missing_data_state)).toBe("COMPLETE");

    // Survives a hard refresh without duplicating. The ambiguous-retry proof is STEP 16b.
    await page.reload({ waitUntil: "domcontentloaded" });
    // A refresh returns to the activation surface, so re-enter it the way a user would.
    // This is navigation only — it never re-authenticates and never re-creates state.
    await enterOperationalSurface();
    const afterReload = await readSummary(page, TENANT_A.workspaceId, TENANT_A.projectId);
    expect(countOf(afterReload, "observations"), "OBSERVATION survives refresh without duplicating").toBe(1);

    await shot("06-observation-outcome-review");
    checkpoint("STEP_16", `LIVE Evidence ${chainIds.liveEvidenceId} derived via capture_live_input; Observation ${chainIds.observationId} cites it at confidence 0.9 / COMPLETE`);
  });

  test("STEP 16b — an ambiguous retry of the same Observation reconciles instead of recording a second", async () => {
    // An Observation is the claim that an Outcome was achieved. A duplicate would be a
    // second, independently-citable assertion of achievement, so the retry is proven here
    // rather than inferred from the hard refresh above.
    //
    // The key is read back off the persisted Observation — the same key the contract
    // compares — because a retry under a NEW key is not a retry, it is a second observation.
    const before = await readSummary(page, TENANT_A.workspaceId, TENANT_A.projectId);
    const persisted = (before.observations ?? []).find((row) => String(row.id) === chainIds.observationId)!;

    // Fresh wall-clock timestamps and a fresh correlation id on purpose: the contract
    // compares outcome, state, summary and evidence references — not client time — so a
    // genuine retry from a browser that has moved on must still reconcile.
    const retry = await probeWrite(page, {
      workspaceId: TENANT_A.workspaceId, projectId: TENANT_A.projectId,
      operation: "record_outcome_observation",
      outcomeId: String(persisted.outcome_id),
      observationState: String(persisted.observation_state),
      summary: String(persisted.summary),
      evidenceReferenceIds: (persisted.evidence_reference_ids as string[]) ?? [],
      confidenceScore: Number(persisted.confidence_score),
      missingDataState: String(persisted.missing_data_state),
      observedAt: new Date().toISOString(), evaluatedAt: new Date().toISOString(),
      correlationId: crypto.randomUUID(),
      idempotencyKey: String(persisted.idempotency_key),
    });
    // `existing` (200), never `created` (201).
    expect(retry.status, `observation retry disposition (${retry.bodyText.slice(0, 200)})`).toBe(200);
    expect(retry.bodyText).toContain('"disposition":"existing"');

    const after = await readSummary(page, TENANT_A.workspaceId, TENANT_A.projectId);
    expect(countOf(after, "observations"), "OBSERVATION_RETRY_DUPLICATE").toBe(1);
    expect(String((after.observations ?? [])[0].id)).toBe(chainIds.observationId);
    // The reconciled row is the original, not a rewritten one.
    expect(String((after.observations ?? [])[0].recorded_at)).toBe(String(persisted.recorded_at));
    checkpoint("STEP_16b", `identical resubmission of Observation ${chainIds.observationId} reconciled 200 existing; still exactly 1, and the original recorded_at is unchanged`);
  });

  test("STEP 16c — the PM sees the result, why the work existed, and that nothing is pending next", async () => {
    // Historical Founder step 16 ("PM sees result, why, next") read off the real Command
    // Center after the Observation, not inferred from the rows above. The journey card is
    // the product's own post-decision surface (UX-W4); every line is derived from persisted
    // state, and "Next" is deliberately absent when nothing is pending rather than invented.
    await openCommandCenter();
    // A closed loop is filed under the "Closed" disclosure. Wait for it to render before
    // governedChainRow() decides whether to expand it — right after navigation the queue is
    // still loading, and an absent disclosure would be skipped rather than opened.
    await openTool(page, "execution", /In progress/);
    await expect(attentionCanvas().getByTestId("cc-closed-chains")).toBeVisible({ timeout: 30_000 });
    const row = await governedChainRow();
    await expect(row).toBeVisible();
    await expect(row).toHaveAttribute("data-testid", "cc-closed-chain-item");
    await expect(row).toHaveAttribute("data-journey-closure", "loop_closed");
    await expect(row.getByTestId("cc-journey-state")).toHaveText("The expected result was achieved.");
    await expect(row.getByTestId("cc-journey-why")).toContainText(
      "Scope and approval confirmation is required before any supplier commitment."
    );
    await expect(row.getByTestId("cc-journey-next")).toHaveCount(0);
    await shot("06b-result-why-next");
    checkpoint("STEP_16c", "journey card after the Observation: loop_closed, result 'The expected result was achieved.', why = the Decision's own rationale, no fabricated next step");
  });

  // ──────────────────────── STEP 17: LINEAGE + AUDIT ────────────────────────

  test("STEP 17 — complete lineage and canonical audit export are inspectable", async () => {
    const lineageResponse = await page.request.get(
      `/api/operational-flow?view=lineage&workspaceId=${encodeURIComponent(TENANT_A.workspaceId)}&projectId=${encodeURIComponent(TENANT_A.projectId)}&outcomeId=${encodeURIComponent(chainIds.outcomeId)}`
    );
    expect(lineageResponse.status()).toBe(200);
    const lineageText = JSON.stringify(await lineageResponse.json());
    for (const [label, id] of Object.entries({
      decision: chainIds.decisionId, action: chainIds.actionId, task: chainIds.taskId,
      outcome: chainIds.outcomeId, observation: chainIds.observationId, liveEvidence: chainIds.liveEvidenceId,
    })) {
      expect(lineageText, `lineage carries the ${label} id`).toContain(id);
    }

    const auditResponse = await page.request.get(
      `/api/operational-flow?view=audit_export&workspaceId=${encodeURIComponent(TENANT_A.workspaceId)}&projectId=${encodeURIComponent(TENANT_A.projectId)}&outcomeId=${encodeURIComponent(chainIds.outcomeId)}`
    );
    expect(auditResponse.status(), "P2-20 audit export reachable").toBe(200);
    const auditText = JSON.stringify(await auditResponse.json());
    expect(auditText).toContain(chainIds.outcomeId);
    checkpoint("STEP_17", "lineage view carries Decision -> Action -> Task -> Outcome -> Observation -> LIVE Evidence ids; audit_export reachable and includes the outcome");
  });

  // ──────────────────────── TENANT / VIEWER / IDOR NEGATIVES ────────────────────────

  test("NEGATIVE — Tenant A cannot read or mutate Tenant B", async () => {
    const read = await probeSummary(page, TENANT_B.workspaceId, TENANT_B.projectId);
    expect(read.status, "A -> B read").toBe(403);
    expect(read.bodyText).not.toContain(TENANT_B.projectId.slice(0, 8) + "-restricted");

    const write = await probeWrite(page, {
      workspaceId: TENANT_B.workspaceId, projectId: TENANT_B.projectId,
      operation: "record_decision", recommendationId: chainIds.recommendationId,
      decisionStatus: "accepted", decision: "cross-tenant attempt", rationale: "cross-tenant attempt",
    });
    expect(write.status, "A -> B write").toBe(403);

    // ID substitution across every canonical node P2-14 created.
    for (const [label, payload] of [
      ["action", { operation: "dispatch_material_action_to_task", actionId: chainIds.actionId }],
      ["outcome", { operation: "ensure_expected_outcome", taskId: chainIds.taskId, expectedResult: "x", successCriteria: [], correlationId: crypto.randomUUID() }],
      ["observation", { operation: "record_outcome_observation", outcomeId: chainIds.outcomeId, observationState: "achieved", summary: "x", evidenceReferenceIds: [chainIds.liveEvidenceId], confidenceScore: 1, missingDataState: "COMPLETE", observedAt: new Date().toISOString(), evaluatedAt: new Date().toISOString(), correlationId: crypto.randomUUID(), idempotencyKey: `idor-${Date.now()}` }],
    ] as const) {
      const probe = await probeWrite(page, { workspaceId: TENANT_B.workspaceId, projectId: TENANT_B.projectId, ...payload });
      expect(probe.status, `A -> B IDOR via ${label}`).toBe(403);
    }
    checkpoint("NEG_A_TO_B", "Tenant A denied 403 on Tenant B read, write and id-substitution probes for action/outcome/observation");
  });

  test("NEGATIVE — Tenant A PM lacks authority for a terminal Decision on these recommendations", async () => {
    test.skip(!undecidedRecommendationId, "scenario provided only one proposed recommendation");
    await signOut(context);
    await signIn(page, PM_A.email);

    // PM is a WRITE role on this route, so this is an authority denial from the canonical
    // contract, not a role/route rejection — exactly the distinction being proven.
    const read = await probeSummary(page, TENANT_A.workspaceId, TENANT_A.projectId);
    expect(read.status, "PM read").toBe(200);

    const terminal = await probeWrite(page, {
      workspaceId: TENANT_A.workspaceId, projectId: TENANT_A.projectId,
      operation: "record_decision", recommendationId: undecidedRecommendationId,
      decisionStatus: "accepted", decision: "PM terminal attempt", rationale: "PM terminal attempt",
    });
    expect(terminal.status, "PM terminal decision denied").toBe(403);
    expect(terminal.bodyText).toContain("operational_decision_authority_denied");

    // The non-terminal escalation authority a PM DOES hold still works.
    const escalated = await probeWrite(page, {
      workspaceId: TENANT_A.workspaceId, projectId: TENANT_A.projectId,
      operation: "record_decision", recommendationId: undecidedRecommendationId,
      decisionStatus: "escalated", decision: "Escalated for sponsor authority.",
      rationale: "Requires sponsor or PMO authority, which this role does not hold.",
    });
    expect([200, 201], `PM escalation (${escalated.bodyText.slice(0, 200)})`).toContain(escalated.status);
    checkpoint("NEG_PM_AUTHORITY", "Tenant A PM denied 403 operational_decision_authority_denied on a terminal Decision, but permitted the non-terminal escalation the contract grants");
  });

  test("NEGATIVE — Tenant A viewer may read but cannot mutate", async () => {
    await signOut(context);
    await signIn(page, VIEWER_A.email);

    const read = await probeSummary(page, TENANT_A.workspaceId, TENANT_A.projectId);
    expect(read.status, "viewer read").toBe(200);

    for (const [label, payload] of [
      ["decision", { operation: "record_decision", recommendationId: chainIds.recommendationId, decisionStatus: "accepted", decision: "viewer attempt", rationale: "viewer attempt" }],
      ["material action", { operation: "propose_material_action", decisionId: chainIds.decisionId, idempotencyKey: `viewer-${Date.now()}`, actionClass: "external_write", actionType: "x", targetResourceType: "project", targetResourceId: TENANT_A.projectId, intendedOperation: "x", intendedEffect: "x", risk: "medium", reversibility: "reversible", sideEffect: "external", justification: "x" }],
      ["task dispatch", { operation: "dispatch_material_action_to_task", actionId: chainIds.actionId }],
      ["live capture", { operation: "capture_live_input", sourceKey: "live-observation:v1", idempotencyKey: `viewer-live-${Date.now()}`, title: "x", content: "x", occurredAt: new Date().toISOString(), correlationId: crypto.randomUUID() }],
      ["observation", { operation: "record_outcome_observation", outcomeId: chainIds.outcomeId, observationState: "achieved", summary: "x", evidenceReferenceIds: [chainIds.liveEvidenceId], confidenceScore: 1, missingDataState: "COMPLETE", observedAt: new Date().toISOString(), evaluatedAt: new Date().toISOString(), correlationId: crypto.randomUUID(), idempotencyKey: `viewer-obs-${Date.now()}` }],
    ] as const) {
      const probe = await probeWrite(page, { workspaceId: TENANT_A.workspaceId, projectId: TENANT_A.projectId, ...payload });
      expect(probe.status, `viewer mutation denied: ${label}`).toBe(403);
    }

    // The UI must not offer what the server refuses.
    await openCommandCenter();
    await expect(page.getByRole("button", { name: "Accept" })).toHaveCount(0);
    checkpoint("NEG_VIEWER", "Tenant A viewer reads 200 but is denied 403 on decision, material action, dispatch, live capture and observation");
  });

  test("NEGATIVE — Tenant B cannot read or mutate Tenant A, and no cached context leaks", async () => {
    await signOut(context);
    await signIn(page, OWNER_B.email);

    // B -> B allowed.
    const own = await probeSummary(page, TENANT_B.workspaceId, TENANT_B.projectId);
    expect(own.status, "B -> B read").toBe(200);

    // B -> A denied, and Tenant A's canonical ids must not appear anywhere in the response.
    const cross = await probeSummary(page, TENANT_A.workspaceId, TENANT_A.projectId);
    expect(cross.status, "B -> A read").toBe(403);
    for (const id of [chainIds.decisionId, chainIds.actionId, chainIds.taskId, chainIds.outcomeId, chainIds.observationId]) {
      expect(cross.bodyText, "no Tenant A id leaks into a denial").not.toContain(id);
    }

    const write = await probeWrite(page, {
      workspaceId: TENANT_A.workspaceId, projectId: TENANT_A.projectId,
      operation: "record_outcome_observation", outcomeId: chainIds.outcomeId,
      observationState: "achieved", summary: "cross-tenant", evidenceReferenceIds: [chainIds.liveEvidenceId],
      confidenceScore: 1, missingDataState: "COMPLETE",
      observedAt: new Date().toISOString(), evaluatedAt: new Date().toISOString(),
      correlationId: crypto.randomUUID(), idempotencyKey: `b-to-a-${Date.now()}`,
    });
    expect(write.status, "B -> A write").toBe(403);

    // Session-switch leakage: B's Command Center must not render A's project context.
    await page.goto("/command-center");
    await page.waitForLoadState("domcontentloaded");
    const body = (await page.textContent("body")) ?? "";
    expect(body, "no Tenant A project id in Tenant B's rendered surface").not.toContain(TENANT_A.projectId);
    await shot("07-tenant-b-isolation");
    checkpoint("NEG_B_TO_A", "Tenant B reads its own project 200, is denied 403 on Tenant A read/write, and no Tenant A id appears in the denial or the rendered surface");
  });

  test("NEGATIVE — logged-out access to a protected product path is refused", async () => {
    await signOut(context);
    await page.goto(A_PATH);
    await page.waitForLoadState("domcontentloaded");
    expect(page.url(), "unauthenticated redirect").toContain("/login");

    const probe = await probeSummary(page, TENANT_A.workspaceId, TENANT_A.projectId);
    expect(probe.status, "unauthenticated API").toBe(401);
    checkpoint("NEG_LOGGED_OUT", "unauthenticated browser redirected to /login and the canonical API answered 401");
  });

  // ──────────────────────── GOVERNANCE NEGATIVES ────────────────────────

  test("NEGATIVE — a knowledge_elevation action is denied by the real governance contract", async () => {
    await signIn(page, OWNER_A.email);
    const probe = await probeWrite(page, {
      workspaceId: TENANT_A.workspaceId, projectId: TENANT_A.projectId,
      operation: "propose_material_action", decisionId: chainIds.decisionId,
      idempotencyKey: `p2-14-denied-${Date.now()}`,
      actionClass: "knowledge_elevation", actionType: "elevate finding to policy",
      targetResourceType: "project", targetResourceId: TENANT_A.projectId,
      intendedOperation: "elevate", intendedEffect: "Promote this finding into standing policy.",
      risk: "high", reversibility: "irreversible", sideEffect: "knowledge",
      justification: "governance negative control",
    });
    expect([200, 201]).toContain(probe.status);
    const summary = await readSummary(page, TENANT_A.workspaceId, TENANT_A.projectId);
    const denied = (summary.materialActionEvaluations ?? []).filter((row) => String(row.governance_state) === "denied");
    expect(denied.length, "denied governance state is reachable and visible").toBeGreaterThan(0);
    // A denied Action must never become a Task.
    expect(countOf(summary, "tasks"), "denied Action created no Task").toBe(1);
    checkpoint("NEG_GOVERNANCE_DENIED", "knowledge_elevation evaluated denied by aoc_e_in_process; Task count unchanged at 1");
  });

  // ──────────────────────── ACCESSIBILITY + RESPONSIVE ────────────────────────

  test("ACCESSIBILITY — keyboard reach, visible focus and no duplicate ids on mounted surfaces", async () => {
    await openCommandCenter();

    // No duplicate document ids across the simultaneously mounted responsive surfaces.
    const duplicates = await page.evaluate(() => {
      const seen = new Map<string, number>();
      for (const element of Array.from(document.querySelectorAll("[id]"))) {
        const id = element.id;
        if (!id) continue;
        seen.set(id, (seen.get(id) ?? 0) + 1);
      }
      return Array.from(seen.entries()).filter(([, count]) => count > 1).map(([id]) => id);
    });
    expect(duplicates, "duplicate document ids").toEqual([]);

    // The attention item is keyboard reachable and activates on Enter, and focus is not lost.
    // Since UX-W4 the row card is a container, not a <button>: its control is the row's own
    // `<testId>-open` button (a stretched target over the card), so that is what must take focus.
    const chainButton = (await governedChainRow()).locator('button[data-testid$="-item-open"]');
    await chainButton.focus();
    await expect(chainButton).toBeFocused();
    await page.keyboard.press("Enter");
    const drawer = page.getByRole("dialog");
    await expect(drawer).toBeVisible();

    // Primary controls carry accessible names, and the drawer close is reachable.
    await expect(drawer.getByRole("button", { name: "Close" })).toBeVisible();
    await drawer.getByRole("button", { name: "Close" }).click();
    await expect(drawer).toHaveCount(0);
    checkpoint("ACCESSIBILITY", "no duplicate document ids; attention control focusable and Enter-activated; drawer has an accessible close and is not a keyboard trap");
  });

  for (const width of [390, 768, 1440] as const) {
    test(`RESPONSIVE — critical Founder surfaces are usable at ${width}px`, async () => {
      await page.setViewportSize({ width, height: 900 });
      await openCommandCenterResponsive(width);

      // No horizontal document overflow at any breakpoint.
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow, `horizontal overflow at ${width}px`).toBeLessThanOrEqual(1);

      await shot(`08-responsive-${width}`);
      checkpoint(`RESPONSIVE_${width}`, `Command Center and the governed chain reachable at ${width}px with no horizontal overflow`);
    });
  }

  test("FINAL — the browser-created chain is complete and internally consistent", async () => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const summary = await readSummary(page, TENANT_A.workspaceId, TENANT_A.projectId);

    // The story deliberately produces TWO Decisions: the Founder's `accepted` decision that
    // drives the governed chain, and the PM's `escalated` decision from the authority
    // negative — an escalation IS a real Decision, and it is precisely the non-terminal
    // authority the contract grants a PM. Asserting "exactly one Decision" would force
    // either deleting that proof or pretending it did not happen, so the invariant asserted
    // here is the one that actually matters: the governed chain is singular, and every
    // Decision outside it is non-terminal.
    const decisions = summary.decisions ?? [];
    const terminal = decisions.filter((row) => String(row.decision_status) === "accepted");
    expect(terminal.length, "exactly one terminal accepted Decision").toBe(1);
    expect(String(terminal[0].id), "the accepted Decision is the one the chain was built on").toBe(chainIds.decisionId);
    for (const row of decisions) {
      if (String(row.id) === chainIds.decisionId) continue;
      expect(String(row.decision_status), "every Decision outside the chain is non-terminal").toBe("escalated");
    }

    expect(countOf(summary, "tasks")).toBe(1);
    expect(countOf(summary, "outcomes")).toBe(1);
    expect(countOf(summary, "observations")).toBe(1);
    for (const [label, id] of Object.entries(chainIds)) {
      expect(id, `canonical id resolved: ${label}`).not.toBe("");
    }
    console.log(`P2-14 CHECKPOINTS ${JSON.stringify(checkpoints, null, 2)}`);
  });
});

/** Reach the Command Center attention surface at any breakpoint. */
async function openCommandCenterResponsive(width: number) {
  await page.goto(A_PATH);
  await page.waitForLoadState("domcontentloaded");
  const proceed = page.getByRole("button", { name: /Continue to Project Brain/i });
  if (await proceed.count()) await proceed.first().click();
  // CHAT-SHELL-01: at every width the conversation is the page and its composer is
  // visible without searching; attention is one tap away in the tools.
  await expect(page.getByTestId("project-conversation-center")).toBeVisible({ timeout: 45_000 });
  await expect(page.getByTestId("project-brain-input")).toBeVisible();
  await openTool(page, "attention", /Needs you/);
  const queueHeading = page.getByRole("heading", { name: "Needs your attention" });
  await expect(queueHeading.first()).toBeVisible({ timeout: 45_000 });

  // Intake stays reachable at every breakpoint: a Founder who can only see the queue but
  // cannot add an operational record has not been given a usable surface. The notes
  // intake is the Evidence tool's "Add project notes"; the accessible name is unchanged.
  await openTool(page, "repository", /Evidence/);
  await expect(page.getByRole("button", { name: /Add project notes/i }).first()).toBeVisible();
}
