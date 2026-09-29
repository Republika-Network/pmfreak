/**
 * CHAT-GOV-01a — stable, human-safe vocabulary for governed dispatch and execution refusals.
 *
 * The canonical contracts answer an ineligible request with a RETURNED disposition, not a
 * raise: `dispatch_governed_action_to_internal_task` (P2-07), the Frontera boundary in front
 * of it (P0-PKG-06), and `dispatch_internal_task_execution` /
 * `transition_internal_task_execution` (P2-08) all resolve to
 *
 *   { disposition: "denied" | "conflict", failureClass, reason, governanceState? }
 *
 * and the routes answered that with a 409 carrying no `error` key. The client therefore fell
 * back to "Operational flow action failed." and the operator could not tell an unavailable
 * enforcement service from an expired authorization — the CHAT-GOV-01 finding.
 *
 * This module only TRANSLATES a refusal the contract already made. It reads nothing, decides
 * nothing, and cannot turn a refusal into success: every entry describes a denial, and an
 * unknown failure class still resolves to a refusal. It never echoes Frontera reason codes,
 * diagnostics, configuration values or paths — only PMFreak's own failure class, which is
 * already part of the response body.
 *
 * `recovery` here is a human-readable next step, because it is rendered beside the control
 * that failed. (The older P2-15 intake conflict contract uses machine tokens instead; the
 * client parser tells the two apart — see `operational-data.ts`.)
 */

export type GovernedDenialContract = {
  /** Stable machine-readable code. Safe to switch on, log and quote to support. */
  code: string;
  /** Human-safe explanation. Names no table, function, path, credential or Frontera internal. */
  error: string;
  /** Actionable next step for the person who was refused. */
  recovery: string;
};

/** The governed refusal as the canonical contract (or the Frontera boundary) returned it. */
export type GovernedRefusal = {
  disposition?: unknown;
  failureClass?: unknown;
  reason?: unknown;
  governanceState?: unknown;
  [field: string]: unknown;
};

/** The contract's own fields a refusal body may carry forward, and nothing else. Each is
 *  PMFreak vocabulary or a PMFreak identifier the caller already holds; Frontera reason
 *  codes, decision ids and diagnostics are deliberately absent. */
const CARRIED_REFUSAL_FIELDS = ["failureClass", "reason", "governanceState", "executionState", "actionId", "proposalDigest"] as const;

const REPLACEMENT_RECOVERY = "Request a replacement governed material action to continue.";

/**
 * Failure class -> contract, for refusals that mean the same thing whichever operation hit them.
 *
 * Keyed by PMFreak's own failure-class vocabulary (P2-07, P2-08 and `FronteraDenialClass`).
 * A failure class added to a contract without an entry here degrades to
 * GENERIC_GOVERNED_REFUSAL — still a refusal, still safe — never to a leak.
 */
export const GOVERNED_DENIALS: Readonly<Record<string, GovernedDenialContract>> = {
  // ---- Frontera enforcement boundary (P0-PKG-06). Fail closed; nothing was created. ----
  frontera_unavailable: {
    code: "frontera_unavailable",
    error: "The governance enforcement service is not available for this action.",
    recovery: "Try again after the workspace governance service is available. Nothing was created.",
  },
  frontera_actor_unbound: {
    code: "frontera_actor_unbound",
    error: "Your account is not provisioned to dispatch this governed action.",
    recovery: "Ask a workspace administrator to review your execution authority.",
  },
  frontera_denied: {
    code: "frontera_denied",
    error: "The governance enforcement boundary refused this action.",
    recovery: "Review the action's authority and policy requirements.",
  },
  frontera_malformed_result: {
    code: "frontera_unavailable",
    error: "The governance enforcement service could not give a usable answer, so this action was not dispatched.",
    recovery: "Try again later. If it keeps happening, contact support with the failure reference.",
  },

  // ---- Authorization window and governance state (P2-07 / P2-08 gate). ----
  expired: {
    code: "authorization_expired",
    error: "This governed action authorization has expired.",
    recovery: REPLACEMENT_RECOVERY,
  },
  stale: {
    code: "authorization_stale",
    error: "This governed action's governance evaluation is no longer valid.",
    recovery: REPLACEMENT_RECOVERY,
  },
  governance_missing: {
    code: "governance_evaluation_missing",
    error: "This governed action has no governance evaluation, so it cannot become work.",
    recovery: REPLACEMENT_RECOVERY,
  },
  governance_not_dispatchable: {
    code: "governance_not_permitted",
    error: "Governance has not permitted this action to become work.",
    recovery: "Review the action's governance state. A new governed material action is needed to proceed.",
  },
  governance_not_executable: {
    code: "governance_not_permitted",
    error: "Governance no longer permits work on this action.",
    recovery: "Review the action's governance state. A new governed material action is needed to proceed.",
  },
  governance_evidence_incomplete: {
    code: "authorization_evidence_incomplete",
    error: "This action's authorization is missing the policy and grant references it requires.",
    recovery: REPLACEMENT_RECOVERY,
  },

  // ---- Actor and scope. ----
  unauthorized: {
    code: "write_role_required",
    error: "Your role cannot record governed operations in this project.",
    recovery: "Ask a workspace owner or admin for a PM, admin or owner role in this workspace.",
  },
  actor_not_member: {
    code: "proposer_not_member",
    error: "The person who proposed this action is no longer a member of this workspace.",
    recovery: REPLACEMENT_RECOVERY,
  },
  not_found: {
    code: "governed_target_not_found",
    error: "The governed action or task could not be found in this project.",
    recovery: "Reload the project to see its current state.",
  },

  // ---- Lineage and project. ----
  source_decision_ineligible: {
    code: "source_decision_ineligible",
    error: "The Decision behind this action no longer allows it to become work.",
    recovery: "Review the recorded Decision before requesting new work.",
  },
  lineage_incomplete: {
    code: "decision_evidence_missing",
    error: "The Decision behind this action has no linked evidence, so it cannot become work.",
    recovery: "Record the Decision against evidence before requesting governed work.",
  },
  lineage_invalid: {
    code: "task_lineage_invalid",
    error: "This task's link to its governed action is not valid, so it cannot be executed.",
    recovery: "Contact support with the failure reference.",
  },
  project_not_dispatchable: {
    code: "project_not_active",
    error: "This project is archived or unavailable, so no new work can be created in it.",
    recovery: "Governed work can only be dispatched in an active project.",
  },

  // ---- Internal execution state machine (P2-08). ----
  not_governed: {
    code: "task_not_governed",
    error: "Internal execution requires a task created from a governed action.",
    recovery: "Create the task from an authorized governed action.",
  },
  not_dispatched: {
    code: "execution_not_queued",
    error: "No internal execution has been queued for this task yet.",
    recovery: "Queue internal execution first.",
  },
  invalid_transition: {
    code: "execution_transition_invalid",
    error: "That step is not available from the execution's current state.",
    recovery: "Reload to see the execution's current state.",
  },
  invalid_task_state: {
    code: "task_state_invalid",
    error: "This task is not in a state that can start a new internal execution.",
    recovery: "Reload to see the task's current state.",
  },
  validation_failed: {
    code: "execution_command_invalid",
    error: "That execution command is not recognised.",
    recovery: "Reload and try again.",
  },
};

/** The proposer rule (P2-07 / P2-08 queue gate) and the dispatcher rule (P2-08 transitions)
 *  share `actor_mismatch`; the `reason` says which, and they need different next steps. */
const PROPOSER_MISMATCH: GovernedDenialContract = {
  code: "proposer_required",
  error: "Only the person who proposed this governed action can turn it into work.",
  recovery: "Ask the proposer to continue, or request your own governed material action.",
};
const DISPATCHER_MISMATCH: GovernedDenialContract = {
  code: "dispatcher_required",
  error: "Only the person who queued this internal execution can change its state.",
  recovery: "Ask the person who queued it to continue.",
};

/** A revoked authorization is terminal. It arrives as `governance_not_*` with
 *  `governanceState: "revoked"`, and must not read like a recoverable eligibility gap. */
const REVOKED: GovernedDenialContract = {
  code: "authorization_revoked",
  error: "This governed action authorization was revoked.",
  recovery: "The revoked authorization stays on the record. Request a new governed material action only if the work is still needed.",
};

/** P2-07 `idempotency_conflict`: the expected proposal digest no longer matches. */
const DIGEST_CONFLICT: GovernedDenialContract = {
  code: "proposal_digest_conflict",
  error: "This governed action changed since it was loaded, so the request was refused.",
  recovery: "Reload to see the current action before trying again.",
};

/** Any refusal this layer does not name. Still a refusal; never a generic "failed". */
export const GENERIC_GOVERNED_REFUSAL: GovernedDenialContract = {
  code: "governed_operation_refused",
  error: "This governed operation was refused, and nothing was changed.",
  recovery: "Reload to see the current state. If it keeps happening, contact support with the failure reference.",
};

/** Resolve a returned governed refusal to its client contract. Pure; never throws. */
export function resolveGovernedDenial(refusal: GovernedRefusal): GovernedDenialContract {
  const failureClass = typeof refusal.failureClass === "string" ? refusal.failureClass : "";
  const reason = typeof refusal.reason === "string" ? refusal.reason : "";

  if (refusal.governanceState === "revoked") return REVOKED;
  if (failureClass === "actor_mismatch") {
    return reason === "internal_execution_actor_mismatch" ? DISPATCHER_MISMATCH : PROPOSER_MISMATCH;
  }
  if (failureClass === "idempotency_conflict") return DIGEST_CONFLICT;
  return Object.prototype.hasOwnProperty.call(GOVERNED_DENIALS, failureClass)
    ? GOVERNED_DENIALS[failureClass]
    : GENERIC_GOVERNED_REFUSAL;
}

/**
 * The response body for a governed refusal.
 *
 * The contract's own fields (CARRIED_REFUSAL_FIELDS) are kept so existing callers that
 * switch on them are unchanged; the safe `error`, `code`, `recovery` and the server-minted
 * `referenceId` are added beside them. Nothing else is copied, so a field added upstream —
 * or a Frontera diagnostic attached for the log — cannot leak through here.
 */
export function governedDenialBody(refusal: GovernedRefusal, referenceId: string) {
  const contract = resolveGovernedDenial(refusal);
  const carried: Record<string, string> = {};
  for (const field of CARRIED_REFUSAL_FIELDS) {
    const value = refusal[field];
    if (typeof value === "string") carried[field] = value;
  }
  return {
    disposition: refusal.disposition === "conflict" ? ("conflict" as const) : ("denied" as const),
    ...carried,
    error: contract.error,
    code: contract.code,
    recovery: contract.recovery,
    referenceId,
  };
}
