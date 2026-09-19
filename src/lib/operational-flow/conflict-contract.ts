/**
 * P2-15 — stable, client-facing conflict vocabulary for the canonical operational flow.
 *
 * The canonical intake and derivation RPCs answer a retry that carries the SAME
 * idempotency key but DIFFERENT content by raising, not by returning a disposition:
 *
 *   - `derive_operational_evidence` folds assertionType, classification,
 *     confidenceScore and missingDataState into `derivation_digest`. A retry under the
 *     same `derivation_idempotency_key` whose digest differs raises
 *     `evidence_idempotency_conflict`. This is deliberate and is the ratified P2-15
 *     semantic: the recorded Evidence assertion is immutable, a changed quality
 *     judgement is NOT silently coerced onto it, NOT silently replayed as the old
 *     judgement, and NOT quietly minted as a second assertion.
 *
 *   - `capture_live_operational_input` / `capture_operational_input` raise
 *     `intake_idempotency_conflict` on the same shape for Raw Input content.
 *
 * A raise aborts the transaction, so the caller received `Error("<rpc>: <postgres
 * message>")` and the route returned that string verbatim with a 409. That leaked the
 * internal RPC name and raw driver text to the browser, and gave the observer no stable
 * code, no reference to quote to support, and no idea what to do next.
 *
 * This module is the narrow translation layer: raw RPC signal -> stable domain code,
 * human-safe message and recovery instruction. It carries no data, reads nothing, and
 * never echoes the driver text — the raw error stays in the server log, correlated by a
 * reference id.
 *
 * Longer term the preferred model is a governed Evidence correction/supersession
 * (recording the corrected judgement as an explicit, linked successor rather than
 * refusing it). That needs migration, RPC-signature and Observation-eligibility work and
 * is explicitly OUT of P2-15 scope — see docs/release/residual-risk-register.md.
 */

/** What the caller is told, and what they can do about it. Never driver text. */
export type OperationalFlowConflict = {
  /** Stable domain code. Safe to switch on, safe to log, safe to quote to support. */
  code: string;
  /** Human-safe explanation. Names no table, column, function or identifier. */
  message: string;
  /** Machine-readable next step, so a client can offer recovery without guessing. */
  recovery: string;
};

/** A governed Recommendation already carries its one terminal Decision. */
const RECOMMENDATION_ALREADY_DECIDED: OperationalFlowConflict = {
  code: "recommendation_already_decided",
  message:
    "This Recommendation already has a final Decision. The recorded Decision is immutable " +
    "and has not been changed, and no new Decision was recorded. Reload to see it.",
  recovery: "reload_recorded_decision",
};

/**
 * Raw RPC signal -> client contract.
 *
 * Keyed by the exact string the database raises. Adding a raise in a migration without
 * adding it here degrades to GENERIC_OPERATIONAL_FLOW_CONFLICT rather than leaking.
 */
export const OPERATIONAL_FLOW_CONFLICTS: Readonly<Record<string, OperationalFlowConflict>> = {
  evidence_idempotency_conflict: {
    code: "evidence_quality_conflict",
    message:
      "This intake attempt was already recorded as an Evidence assertion with different " +
      "evidence-quality fields. The recorded assertion is immutable and has not been changed. " +
      "Reload and inspect it before starting a new explicit assertion.",
    recovery: "reload_recorded_assertion",
  },
  intake_idempotency_conflict: {
    code: "intake_content_conflict",
    message:
      "This intake attempt was already recorded with different content. The recorded input is " +
      "immutable and has not been changed. Reload and inspect it before capturing a new one.",
    recovery: "reload_recorded_input",
  },
  // `record_operational_decision` (20260911000000_p2_decision_terminal_integrity.sql): the
  // Recommendation already carries its one terminal Decision (accepted / rejected /
  // modified), so no further Decision — terminal or not — may be recorded against it.
  // Previously a second terminal Decision leaked the unique-index violation as a 500, and a
  // later escalation silently reopened the Recommendation.
  operational_decision_already_terminal: RECOMMENDATION_ALREADY_DECIDED,
  // The same refusal as seen by a database that does not yet carry that migration: the
  // one-terminal-Decision partial unique index fires on the INSERT. Mapped so a deploy
  // ordering gap still answers 409 in the stable vocabulary, never 500 with the index name.
  operational_decision_terminal_recommendation_uidx: RECOMMENDATION_ALREADY_DECIDED,
};

/** Fallback for a conflict signal this layer does not yet name explicitly. */
export const GENERIC_OPERATIONAL_FLOW_CONFLICT: OperationalFlowConflict = {
  code: "operational_flow_conflict",
  message:
    "This attempt was already recorded with different content. The recorded state is immutable " +
    "and has not been changed. Reload and inspect it before starting a new one.",
  recovery: "reload_recorded_state",
};

/**
 * Resolve a caught error message to its client contract, or null when it is not a conflict.
 *
 * Matching is ANCHORED on a whole-token boundary rather than a bare substring test, for
 * the same reason the route anchors its `*_unauthenticated` test: an unrelated driver
 * error that merely CONTAINS one of these words must not be reported to the browser as a
 * 409 conflict, which would be both a wrong status and a wrong explanation.
 */
export function resolveOperationalFlowConflict(rawMessage: string): OperationalFlowConflict | null {
  for (const [signal, contract] of Object.entries(OPERATIONAL_FLOW_CONFLICTS)) {
    if (new RegExp(`(?:^|[^a-z_])${signal}(?:$|[^a-z_])`).test(rawMessage)) return contract;
  }
  // Any other canonical idempotency conflict still gets a stable, non-leaking answer.
  if (/(?:^|[^a-z_])[a-z_]*idempotency_conflict(?:$|[^a-z_])/.test(rawMessage)) {
    return GENERIC_OPERATIONAL_FLOW_CONFLICT;
  }
  return null;
}
