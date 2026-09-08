/**
 * UX-W4 — the human loop, run through the REAL read models.
 *
 * Canonical-shaped fixtures go through the REAL `buildExecutionChains`, the REAL
 * `deriveDecisionJourney`, the REAL `projectChainProgress`, and are then RENDERED through
 * the REAL `ExecutionQueue` and `DetailDrawer`. Nothing here hand-builds a
 * `GovernedExecutionChain`: whether a PM can tell DO from VERIFY is a question about what
 * the projection produces and what the DOM says, and a hand-made view object would answer
 * neither.
 *
 * The scenarios are chosen to DISCRIMINATE. Several pairs differ by exactly one canonical
 * field — an Outcome present in state `expected` versus the same Outcome observed, a
 * rejected Decision versus an accepted one with no Action — because those are the pairs a
 * surface gets wrong by guessing.
 *
 * Executed by `tests/ux-w4-decision-execution-loop.test.mjs` through tsx.
 */

import { renderToStaticMarkup } from "react-dom/server";
import type { OperationalSummary } from "@/lib/operational-flow/types";
import {
  buildExecutionChains,
  type GovernedExecutionChain,
} from "../src/modules/workspace/presentation/command-center/execution-read-model";
import { projectChainProgress } from "../src/modules/workspace/presentation/command-center/in-progress-read-model";
import { deriveDecisionJourney } from "../src/modules/workspace/presentation/command-center/decision-journey";
import { ExecutionQueue } from "../src/modules/workspace/presentation/command-center/execution-queue";
import { computeGovernedExecutionRoot } from "./ux-w4-execution-root-membership-stub";
import { DetailDrawer } from "../src/modules/workspace/presentation/command-center/detail-drawer";
import type { DrawerContent } from "../src/modules/workspace/presentation/command-center/types";

type Row = Record<string, unknown>;

const WORKSPACE = "ws-1";
const PROJECT = "proj-1";
/** The viewer. Also the actor on every fixture unless a scenario says otherwise. */
const ACTOR = "actor-pm";
const OTHER_ACTOR = "actor-colleague";

const NOW = new Date("2027-03-01T00:00:00Z");
const PAST = "2027-02-01T00:00:00Z";
const FUTURE = "2027-12-01T00:00:00Z";

const scoped = (row: Row): Row => ({ workspace_id: WORKSPACE, project_id: PROJECT, ...row });

// ── Canonical row builders ───────────────────────────────────────────────────
// Each mirrors the columns its migration declares, so a fixture cannot describe a row the
// database could not hold.

function decisionRow(id: string, status: string, extra: Row = {}): Row {
  return scoped({
    id,
    decision_status: status,
    decided_by: ACTOR,
    recommendation_id: `rec-${id}`,
    rationale: `We decided ${id} because the scope change was justified.`,
    decision: `Recommendation ${status}.`,
    governance_event_id: `gov-${id}`,
    created_at: PAST,
    ...extra,
  });
}

function recommendationRow(decisionId: string, title: string): Row {
  return scoped({
    id: `rec-${decisionId}`,
    recommendation: title,
    status: "accepted",
    governance_event_id: `gov-${decisionId}`,
    created_at: PAST,
    updated_at: PAST,
  });
}

/** P2-06 `material_action_proposals`. `expires_at` in the future unless overridden, so a
 *  scenario testing phase is not accidentally testing expiry. */
function actionRow(id: string, decisionId: string, extra: Row = {}): Row {
  return scoped({
    id,
    source_decision_id: decisionId,
    proposed_by: ACTOR,
    schema_version: "pmfreak.material-action.v1",
    digest_version: "sha256:pmfreak-material-action:v1",
    proposal_digest: "a".repeat(64),
    idempotency_key: `idem-${id}`,
    action_class: "ordinary_business_write",
    materiality: "ordinary",
    proposal: { actionType: "prepare_change_request", evidenceReferenceIds: ["ev-1"], createsTask: false },
    correlation_id: `corr-${id}`,
    causation_id: null,
    expires_at: FUTURE,
    created_at: PAST,
    persisted_at: PAST,
    ...extra,
  });
}

/** P2-06 `material_action_governance_evaluations`. `not_required` + `can_commit_action`
 *  is the ordinary-work verdict P2-07 will dispatch. */
function evaluationRow(actionId: string, extra: Row = {}): Row {
  return scoped({
    id: `eval-${actionId}`,
    action_id: actionId,
    proposal_digest: "a".repeat(64),
    contract_version: "pmfreak.aoc-e.in-process-governance.v1",
    evaluator_kind: "aoc_e_in_process",
    governance_state: "not_required",
    policy_decision_reference: null,
    grant_references: [],
    can_commit_action: true,
    can_execute: false,
    evaluated_at: PAST,
    recorded_at: PAST,
    valid_until: null,
    ...extra,
  });
}

/** P2-07 governed `execution_tasks`. The Action link lives in `source_payload`. */
function taskRow(id: string, actionId: string, status: string, extra: Row = {}): Row {
  return scoped({
    id,
    title: "Prepare customer change request",
    status,
    source_payload: { source: "governed_action", sourceActionId: actionId },
    created_at: PAST,
    completed_at: status === "completed" ? PAST : null,
    ...extra,
  });
}

/** P2-08 `internal_task_executions`. */
function executionRow(id: string, taskId: string, actionId: string, status: string, extra: Row = {}): Row {
  return scoped({
    id,
    task_id: taskId,
    source_action_id: actionId,
    governance_evaluation_id: `eval-${actionId}`,
    provider_key: "pmfreak/internal-state-machine:v1",
    status,
    attempt_count: 1,
    idempotency_key: `exec-idem-${id}`,
    correlation_id: `corr-${id}`,
    dispatched_by: ACTOR,
    queued_at: PAST,
    started_at: status === "queued" ? null : PAST,
    completed_at: status === "completed" ? PAST : null,
    last_transition_at: PAST,
    created_at: PAST,
    ...extra,
  });
}

/** P2-09 `canonical_task_outcomes`. State `expected` is what the RPC inserts. */
function outcomeRow(id: string, taskId: string, actionId: string, state: string, extra: Row = {}): Row {
  return scoped({
    id,
    task_id: taskId,
    source_action_id: actionId,
    internal_execution_id: `exec-${taskId}`,
    state,
    expected_result: "Change request reviewed and signed off within one week.",
    success_criteria: [],
    correlation_id: `corr-${id}`,
    created_by: ACTOR,
    created_at: PAST,
    ...extra,
  });
}

/** P2-09 `canonical_outcome_observations`. */
function observationRow(id: string, outcomeId: string, taskId: string, state: string, summary: string): Row {
  return scoped({
    id,
    outcome_id: outcomeId,
    task_id: taskId,
    observation_state: state,
    summary,
    evidence_reference_ids: ["ev-1"],
    confidence_score: 0.9,
    missing_data_state: "COMPLETE",
    observed_by: ACTOR,
    observed_at: PAST,
    evaluated_at: PAST,
    recorded_at: PAST,
    correlation_id: `corr-${id}`,
    idempotency_key: `obs-idem-${id}`,
  });
}

/** Assembles a summary from whole tables. Every collection the chain builder reads is
 *  supplied explicitly, so an omission is a deliberate absence rather than an accident. */
function summaryOf(tables: {
  decisions: Row[];
  recommendations?: Row[];
  materialActions?: Row[];
  materialActionEvaluations?: Row[];
  tasks?: Row[];
  executions?: Row[];
  outcomes?: Row[];
  observations?: Row[];
  actorUserId?: string | null;
  canCreateEvidence?: boolean;
}): OperationalSummary {
  return {
    sources: [],
    rawInputs: [],
    normalizedEvents: [],
    evidence: [],
    signals: [],
    risksIssues: [],
    governanceEvents: [],
    recommendations: tables.recommendations ?? [],
    decisions: tables.decisions,
    evidenceLinks: tables.decisions.map((row) => ({ decision_record_id: row.id })),
    materialActions: tables.materialActions ?? [],
    materialActionEvaluations: tables.materialActionEvaluations ?? [],
    tasks: tables.tasks ?? [],
    executions: tables.executions ?? [],
    outcomes: tables.outcomes ?? [],
    observations: tables.observations ?? [],
    assurance: {
      scope: "project",
      workspaceId: WORKSPACE,
      projectId: PROJECT,
      asOf: NOW.toISOString(),
      totalGovernanceEvents: 0,
      decisionRequiredCount: 0,
      violationsCount: 0,
      openRecommendations: 0,
      unresolvedRisksIssues: 0,
      evidenceLinkedDecisionsCount: 0,
      evidenceWithoutSignalCount: 0,
      incompleteChainCount: 0,
    },
    actor: {
      role: "owner",
      userId: tables.actorUserId === undefined ? ACTOR : tables.actorUserId,
      canCreateEvidence: tables.canCreateEvidence !== false,
    },
  } as OperationalSummary;
}

// ── Scenarios ────────────────────────────────────────────────────────────────
// Named for the human state each is meant to produce, so a failure names the product
// behaviour that broke rather than a fixture number.

type Scenario = { key: string; note: string; summary: OperationalSummary };

const scenarios: Scenario[] = [];

/** A rejected Decision. `persist_governed_material_action` can never attach an Action to
 *  one, so "no follow-through expected" is a contract fact — the CLOSED case. */
scenarios.push({
  key: "rejectedNoAction",
  note: "Rejected decision — the loop legitimately terminates at judgment.",
  summary: summaryOf({
    decisions: [decisionRow("dec-rejected", "rejected")],
    recommendations: [recommendationRow("dec-rejected", "Reject the vendor's change request")],
  }),
});

/** Accepted, eligible to carry work, none requested yet. NOT a defect. */
scenarios.push({
  key: "acceptedNoActionYet",
  note: "Accepted decision, no material action requested yet.",
  summary: summaryOf({
    decisions: [decisionRow("dec-noaction", "accepted")],
    recommendations: [recommendationRow("dec-noaction", "Approve the scope change")],
  }),
});

/** Action authorized, Task not yet created. */
scenarios.push({
  key: "actionNoTask",
  note: "Authorised action, work not created yet.",
  summary: summaryOf({
    decisions: [decisionRow("dec-notask", "accepted")],
    recommendations: [recommendationRow("dec-notask", "Approve the scope change")],
    materialActions: [actionRow("act-notask", "dec-notask")],
    materialActionEvaluations: [evaluationRow("act-notask")],
  }),
});

/** Work under way — the archetypal DO. */
scenarios.push({
  key: "executionRunning",
  note: "Execution running — work is under way.",
  summary: summaryOf({
    decisions: [decisionRow("dec-running", "accepted")],
    recommendations: [recommendationRow("dec-running", "Approve the scope change")],
    materialActions: [actionRow("act-running", "dec-running")],
    materialActionEvaluations: [evaluationRow("act-running")],
    tasks: [taskRow("task-running", "act-running", "in_progress")],
    executions: [executionRow("exec-running", "task-running", "act-running", "running")],
  }),
});

/** Execution blocked. `blocked` is a persisted canonical status, not an elapsed-time guess. */
scenarios.push({
  key: "executionBlocked",
  note: "Execution blocked — a persisted status, never inferred from elapsed time.",
  summary: summaryOf({
    decisions: [decisionRow("dec-blocked", "accepted")],
    recommendations: [recommendationRow("dec-blocked", "Approve the scope change")],
    materialActions: [actionRow("act-blocked", "dec-blocked")],
    materialActionEvaluations: [evaluationRow("act-blocked")],
    tasks: [taskRow("task-blocked", "act-blocked", "in_progress")],
    executions: [executionRow("exec-blocked", "task-blocked", "act-blocked", "blocked", { blocked_at: PAST })],
  }),
});

/** Work COMPLETE, no Outcome row at all. VERIFY. */
scenarios.push({
  key: "completeNoOutcome",
  note: "Work complete, no expected outcome recorded — VERIFY.",
  summary: summaryOf({
    decisions: [decisionRow("dec-noout", "accepted")],
    recommendations: [recommendationRow("dec-noout", "Approve the scope change")],
    materialActions: [actionRow("act-noout", "dec-noout")],
    materialActionEvaluations: [evaluationRow("act-noout")],
    tasks: [taskRow("task-noout", "act-noout", "completed")],
    executions: [executionRow("exec-noout", "task-noout", "act-noout", "completed")],
  }),
});

/**
 * The discriminating pair, half one: work complete, an Outcome row EXISTS in state
 * `expected`, and no Observation.
 *
 * A surface that reads "an Outcome exists" as "we know how it went" reports LEARN here. The
 * canonical contract says the opposite: `ensure_canonical_expected_outcome` inserts state
 * `expected`, and only an evidence-backed Observation moves it. The result is NOT known,
 * so this is VERIFY.
 */
scenarios.push({
  key: "outcomeExpectedNoObservation",
  note: "Expected outcome exists, nothing observed — still VERIFY, never LEARN.",
  summary: summaryOf({
    decisions: [decisionRow("dec-expected", "accepted")],
    recommendations: [recommendationRow("dec-expected", "Approve the scope change")],
    materialActions: [actionRow("act-expected", "dec-expected")],
    materialActionEvaluations: [evaluationRow("act-expected")],
    tasks: [taskRow("task-expected", "act-expected", "completed")],
    executions: [executionRow("exec-expected", "task-expected", "act-expected", "completed")],
    outcomes: [outcomeRow("out-expected", "task-expected", "act-expected", "expected")],
  }),
});

/** The other half: the SAME chain, observed as achieved. LEARN. */
scenarios.push({
  key: "outcomeAchievedObserved",
  note: "Observed as achieved — LEARN, loop closed.",
  summary: summaryOf({
    decisions: [decisionRow("dec-achieved", "accepted")],
    recommendations: [recommendationRow("dec-achieved", "Approve the scope change")],
    materialActions: [actionRow("act-achieved", "dec-achieved")],
    materialActionEvaluations: [evaluationRow("act-achieved")],
    tasks: [taskRow("task-achieved", "act-achieved", "completed")],
    executions: [executionRow("exec-achieved", "task-achieved", "act-achieved", "completed")],
    outcomes: [outcomeRow("out-achieved", "task-achieved", "act-achieved", "achieved")],
    observations: [
      observationRow("obs-achieved", "out-achieved", "task-achieved", "achieved", "Queue contention was the real bottleneck."),
    ],
  }),
});

/** A NEGATIVE result, fully recorded. A business result, not a system failure. */
scenarios.push({
  key: "outcomeNotAchieved",
  note: "Observed as failed — a recorded negative result, not a broken system.",
  summary: summaryOf({
    decisions: [decisionRow("dec-failed", "accepted")],
    recommendations: [recommendationRow("dec-failed", "Approve the scope change")],
    materialActions: [actionRow("act-failed", "dec-failed")],
    materialActionEvaluations: [evaluationRow("act-failed")],
    tasks: [taskRow("task-failed", "act-failed", "completed")],
    executions: [executionRow("exec-failed", "task-failed", "act-failed", "completed")],
    outcomes: [outcomeRow("out-failed", "task-failed", "act-failed", "not_achieved")],
    observations: [
      observationRow("obs-failed", "out-failed", "task-failed", "failed", "The schedule improvement did not materialise."),
    ],
  }),
});

/** An inconclusive result — the model distinguishes it from both success and failure. */
scenarios.push({
  key: "outcomeInconclusive",
  note: "Observed as inconclusive — distinct from achieved and from not achieved.",
  summary: summaryOf({
    decisions: [decisionRow("dec-incon", "accepted")],
    recommendations: [recommendationRow("dec-incon", "Approve the scope change")],
    materialActions: [actionRow("act-incon", "dec-incon")],
    materialActionEvaluations: [evaluationRow("act-incon")],
    tasks: [taskRow("task-incon", "act-incon", "completed")],
    executions: [executionRow("exec-incon", "task-incon", "act-incon", "completed")],
    outcomes: [outcomeRow("out-incon", "task-incon", "act-incon", "inconclusive")],
    observations: [
      observationRow("obs-incon", "out-incon", "task-incon", "inconclusive", "The available evidence did not settle it."),
    ],
  }),
});

/**
 * MULTI-BRANCH. `source_decision_id` has no unique constraint, so one Decision fans out.
 * Branch A is achieved and observed; branch B is still running.
 *
 * The whole-chain answer must be DO. Reporting LEARN because one branch finished would tell
 * a PM the loop is closed while real work runs under the same decision.
 */
scenarios.push({
  key: "multiBranchOneAchievedOneRunning",
  note: "Two actions on one decision: one observed, one still running — conservative DO.",
  summary: summaryOf({
    decisions: [decisionRow("dec-multi", "accepted")],
    recommendations: [recommendationRow("dec-multi", "Approve the scope change")],
    materialActions: [actionRow("act-multi-a", "dec-multi"), actionRow("act-multi-b", "dec-multi")],
    materialActionEvaluations: [evaluationRow("act-multi-a"), evaluationRow("act-multi-b")],
    tasks: [
      taskRow("task-multi-a", "act-multi-a", "completed"),
      taskRow("task-multi-b", "act-multi-b", "in_progress"),
    ],
    executions: [
      executionRow("exec-multi-a", "task-multi-a", "act-multi-a", "completed"),
      executionRow("exec-multi-b", "task-multi-b", "act-multi-b", "running"),
    ],
    outcomes: [outcomeRow("out-multi-a", "task-multi-a", "act-multi-a", "achieved")],
    observations: [
      observationRow("obs-multi-a", "out-multi-a", "task-multi-a", "achieved", "Branch A landed as expected."),
    ],
  }),
});

/** Both branches observed — only then is the loop closed. */
scenarios.push({
  key: "multiBranchAllObserved",
  note: "Every branch observed — the loop is genuinely closed.",
  summary: summaryOf({
    decisions: [decisionRow("dec-multidone", "accepted")],
    recommendations: [recommendationRow("dec-multidone", "Approve the scope change")],
    materialActions: [actionRow("act-md-a", "dec-multidone"), actionRow("act-md-b", "dec-multidone")],
    materialActionEvaluations: [evaluationRow("act-md-a"), evaluationRow("act-md-b")],
    tasks: [taskRow("task-md-a", "act-md-a", "completed"), taskRow("task-md-b", "act-md-b", "completed")],
    executions: [
      executionRow("exec-md-a", "task-md-a", "act-md-a", "completed"),
      executionRow("exec-md-b", "task-md-b", "act-md-b", "completed"),
    ],
    outcomes: [
      outcomeRow("out-md-a", "task-md-a", "act-md-a", "achieved"),
      outcomeRow("out-md-b", "task-md-b", "act-md-b", "partially_achieved"),
    ],
    observations: [
      observationRow("obs-md-a", "out-md-a", "task-md-a", "achieved", "Branch A landed."),
      observationRow("obs-md-b", "out-md-b", "task-md-b", "partial", "Branch B landed partially."),
    ],
  }),
});

/** A superseded Outcome: the contract defines no transition out of it. */
scenarios.push({
  key: "outcomeSuperseded",
  note: "Superseded outcome — stopped, and never described as expired authorisation.",
  summary: summaryOf({
    decisions: [decisionRow("dec-super", "accepted")],
    recommendations: [recommendationRow("dec-super", "Approve the scope change")],
    materialActions: [actionRow("act-super", "dec-super")],
    materialActionEvaluations: [evaluationRow("act-super")],
    tasks: [taskRow("task-super", "act-super", "completed")],
    executions: [executionRow("exec-super", "task-super", "act-super", "completed")],
    outcomes: [outcomeRow("out-super", "task-super", "act-super", "superseded")],
  }),
});

/**
 * A READ-ONLY viewer on running work owned by someone else.
 *
 * `offeredExecutionCommands` refuses new-work commands when the actor is not the Action's
 * proposer, which is exactly what `p2_08_validate_execution_governance` enforces. The
 * journey must therefore not tell this viewer to start anything.
 */
scenarios.push({
  key: "readOnlyViewer",
  note: "Viewer is not the proposer — sees the state, is offered nothing the server would refuse.",
  summary: summaryOf({
    decisions: [decisionRow("dec-ro", "accepted", { decided_by: OTHER_ACTOR })],
    recommendations: [recommendationRow("dec-ro", "Approve the scope change")],
    materialActions: [actionRow("act-ro", "dec-ro", { proposed_by: OTHER_ACTOR })],
    materialActionEvaluations: [evaluationRow("act-ro")],
    tasks: [taskRow("task-ro", "act-ro", "not_started")],
    executions: [],
    actorUserId: ACTOR,
    canCreateEvidence: false,
  }),
});

/**
 * A PARTIAL chain: the Outcome carries a resolved state but its Observation cannot be
 * resolved. Known facts stay visible; completion is not claimed over the gap.
 */
scenarios.push({
  key: "partialChainMissingObservation",
  note: "Resolved outcome whose observation cannot be resolved — partial, not complete.",
  summary: summaryOf({
    decisions: [decisionRow("dec-partial", "accepted")],
    recommendations: [recommendationRow("dec-partial", "Approve the scope change")],
    materialActions: [actionRow("act-partial", "dec-partial")],
    materialActionEvaluations: [evaluationRow("act-partial")],
    tasks: [taskRow("task-partial", "act-partial", "completed")],
    executions: [executionRow("exec-partial", "task-partial", "act-partial", "completed")],
    outcomes: [outcomeRow("out-partial", "task-partial", "act-partial", "achieved")],
    observations: [],
  }),
});

/** Work owned by someone else, so the card must not say it is the viewer's. */
scenarios.push({
  key: "ownedByAnother",
  note: "Execution dispatched by a colleague — ownership stated without inventing a name.",
  summary: summaryOf({
    decisions: [decisionRow("dec-owner", "accepted")],
    recommendations: [recommendationRow("dec-owner", "Approve the scope change")],
    materialActions: [actionRow("act-owner", "dec-owner")],
    materialActionEvaluations: [evaluationRow("act-owner")],
    tasks: [taskRow("task-owner", "act-owner", "in_progress")],
    executions: [
      executionRow("exec-owner", "task-owner", "act-owner", "running", { dispatched_by: OTHER_ACTOR }),
    ],
  }),
});

/** A Decision with NO rationale, so the card must omit "Why" rather than invent one. */
scenarios.push({
  key: "noRationale",
  note: "Decision without a rationale — the Why line is absent, never filled in.",
  summary: summaryOf({
    decisions: [decisionRow("dec-norat", "accepted", { rationale: null })],
    recommendations: [recommendationRow("dec-norat", "Approve the scope change")],
    materialActions: [actionRow("act-norat", "dec-norat")],
    materialActionEvaluations: [evaluationRow("act-norat")],
    tasks: [taskRow("task-norat", "act-norat", "in_progress")],
    executions: [executionRow("exec-norat", "task-norat", "act-norat", "running")],
  }),
});

/**
 * The W3 BOUNDARY. `escalated` and `needs_more_evidence` write a real Decision row and
 * return the Recommendation to `proposed` — the judgment is not finished, so these belong
 * to Needs You. W4 must not pull them into the execution surface merely because a Decision
 * record now exists.
 */
scenarios.push({
  key: "escalatedStaysWithAttention",
  note: "Escalated decision — non-terminal, so no execution chain exists at all.",
  summary: summaryOf({
    decisions: [decisionRow("dec-esc", "escalated")],
    recommendations: [recommendationRow("dec-esc", "Approve the scope change")],
  }),
});

scenarios.push({
  key: "needsMoreEvidenceStaysWithAttention",
  note: "Needs-more-evidence decision — non-terminal, so no execution chain exists at all.",
  summary: summaryOf({
    decisions: [decisionRow("dec-nme", "needs_more_evidence")],
    recommendations: [recommendationRow("dec-nme", "Approve the scope change")],
  }),
});

/** A `modified` Decision carries work exactly as `accepted` does — both are in
 *  `persist_governed_material_action`'s eligible set. */
scenarios.push({
  key: "modifiedCarriesWork",
  note: "Modified decision — work-bearing, exactly like accepted.",
  summary: summaryOf({
    decisions: [decisionRow("dec-mod", "modified")],
    recommendations: [recommendationRow("dec-mod", "Approve a reduced scope change")],
    materialActions: [actionRow("act-mod", "dec-mod")],
    materialActionEvaluations: [evaluationRow("act-mod")],
    tasks: [taskRow("task-mod", "act-mod", "in_progress")],
    executions: [executionRow("exec-mod", "task-mod", "act-mod", "running")],
  }),
});

// ── Run ──────────────────────────────────────────────────────────────────────

const text = (markup: string): string => markup.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

function drawerFor(chain: GovernedExecutionChain, actorUserId: string | null): DrawerContent {
  const journey = deriveDecisionJourney(chain, actorUserId);
  return {
    title: chain.title,
    journey,
    why: chain.rationale ?? "A human decision was recorded for this recommendation.",
    evidence: [],
    nextStep: chain.boundary.statement,
    nextStepLabel: "Current state",
    badge: { tone: chain.status.tone, label: `Governed · ${chain.status.label}` },
    kindSummary: "The governed chain that follows your recorded decision.",
    chain: [{ label: "Decision", value: `${chain.decisionStatus} · ${chain.decisionId}` }],
  };
}

/**
 * The SERVER-side membership predicate, evaluated over the same rows this scenario holds.
 *
 * The authoritative execution root and the presentation model must describe ONE universe.
 * If the server's notion of "open" is narrower than `deriveDecisionJourney`'s, a journey
 * the surface would call open is one the root never offers it — and the Decision silently
 * disappears once it falls out of every recent-history window. This projects the migration
 * predicate over each fixture so the two can be compared scenario by scenario.
 */
function membershipFor(summary: (typeof scenarios)[number]["summary"]): string[] {
  return computeGovernedExecutionRoot(
    {
      operational_decision_records: (summary.decisions ?? []) as Row[],
      material_action_proposals: (summary.materialActions ?? []) as Row[],
      execution_tasks: (summary.tasks ?? []) as Row[],
      canonical_task_outcomes: (summary.outcomes ?? []) as Row[],
      canonical_outcome_observations: (summary.observations ?? []) as Row[],
    },
    WORKSPACE,
    PROJECT,
    NOW.toISOString()
  ).openExecutionDecisionIds;
}

const results = scenarios.map((scenario) => {
  const actorUserId = scenario.summary.actor?.userId ?? null;
  const chains = buildExecutionChains(scenario.summary, NOW);
  const journeys = chains.map((chain) => deriveDecisionJourney(chain, actorUserId));
  const progress = projectChainProgress(chains);

  const queueMarkup = renderToStaticMarkup(
    <ExecutionQueue chains={chains} onSelect={() => {}} actorUserId={actorUserId} />
  );
  const drawerMarkup =
    chains.length > 0 ? renderToStaticMarkup(<DetailDrawer content={drawerFor(chains[0], actorUserId)} onClose={() => {}} />) : "";

  return {
    key: scenario.key,
    note: scenario.note,
    chainCount: chains.length,
    /** What the server-side membership predicate names as OPEN for these same rows. */
    serverOpenDecisionIds: membershipFor(scenario.summary),
    /** What the presentation model calls open for these same rows. */
    journeyOpenDecisionIds: journeys
      .filter((journey) => journey.closure === "open")
      .map((journey) => journey.decisionId),
    journeys: journeys.map((journey) => ({
      decisionId: journey.decisionId,
      phase: journey.phase,
      closure: journey.closure,
      marks: journey.marks,
      why: journey.why,
      state: journey.state,
      next: journey.next,
      result: journey.result,
      learning: journey.learning,
      owner: journey.owner,
      partial: journey.partial,
      partialReason: journey.partialReason,
      branches: journey.branches.map((branch) => ({
        branchId: branch.branchId,
        actionId: branch.actionId,
        phase: branch.phase,
        stopped: branch.stopped,
        state: branch.state,
        next: branch.next,
        result: branch.result,
        learning: branch.learning,
        owner: branch.owner,
        partialReason: branch.partialReason,
      })),
    })),
    progress: {
      inProgress: progress.inProgress.map((chain) => chain.decisionId),
      notProgressing: progress.notProgressing.map((chain) => chain.decisionId),
      closed: progress.closed.map((chain) => chain.decisionId),
    },
    queue: { markup: queueMarkup, text: text(queueMarkup) },
    drawer: { markup: drawerMarkup, text: text(drawerMarkup) },
  };
});

/** The empty + unproven states of the section, rendered rather than described. */
const emptyStates = {
  provenEmpty: (() => {
    const markup = renderToStaticMarkup(<ExecutionQueue chains={[]} onSelect={() => {}} incomplete={false} />);
    return { markup, text: text(markup) };
  })(),
  unprovenEmpty: (() => {
    const markup = renderToStaticMarkup(<ExecutionQueue chains={[]} onSelect={() => {}} incomplete />);
    return { markup, text: text(markup) };
  })(),
  unprovenWithItems: (() => {
    const chains = buildExecutionChains(
      scenarios.find((entry) => entry.key === "executionRunning")!.summary,
      NOW
    );
    const markup = renderToStaticMarkup(
      <ExecutionQueue
        chains={chains}
        onSelect={() => {}}
        actorUserId={ACTOR}
        incomplete
        incompleteNote="Some of this project's work could not be read, so this list may not be complete."
      />
    );
    return { markup, text: text(markup) };
  })(),
};

process.stdout.write(JSON.stringify({ results, emptyStates }, null, 2));
