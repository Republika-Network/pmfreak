// ─────────────────────────────────────────────────────────────────────────────
// Project Brain — Guardrails
// Sprint 0: Birth of the Project Brain
//
// Runtime enforcement of the constitution (constitution.ts) against a
// `ProjectBrainStatement`/`ProjectBrainResponse` that may originate from an
// untrusted producer (a future LLM-driven capability). Types alone cannot
// stop a bad statement from being constructed with e.g. an empty `sources`
// array on a FACT — these functions are what actually catches it.
// ─────────────────────────────────────────────────────────────────────────────

import { EPISTEMIC_TYPE_DEFINITIONS } from "./constitution";
import type {
  ProjectBrainConfidence,
  ProjectBrainResponse,
  ProjectBrainSourceReference,
  ProjectBrainStatement,
} from "./types";

export type GuardrailFailure = {
  code: string;
  message: string;
};

export type GuardrailResult =
  | { ok: true }
  | { ok: false; failures: GuardrailFailure[] };

function fail(failures: GuardrailFailure[]): GuardrailResult {
  return { ok: false, failures };
}

const EPISTEMIC_TYPE_DEFINITION_BY_TYPE = new Map(
  EPISTEMIC_TYPE_DEFINITIONS.map((def) => [def.type, def]),
);

/** Types that may carry `reports` (see ProjectBrainStatement.reports). */
const REPORT_BEARING_TYPES = new Set(["REPORTED", "RECOMMENDATION", "ASSUMPTION", "OPEN_QUESTION"]);

function hasPrimarySource(sources: ProjectBrainSourceReference[]): boolean {
  return sources.some((source) => source.isPrimary);
}

function validateConfidence(
  confidence: ProjectBrainConfidence,
  failures: GuardrailFailure[],
): void {
  if (confidence.kind === "scored") {
    if (!confidence.method.trim() || !confidence.scoredBy.trim()) {
      failures.push({
        code: "scored_confidence_missing_method",
        message:
          "A scored confidence value must name the documented method and the actor/detector that produced it — never a bare number.",
      });
    }
    if (!Number.isFinite(confidence.score) || confidence.score < 0 || confidence.score > 100) {
      failures.push({
        code: "scored_confidence_out_of_range",
        message: "A scored confidence value must be a finite number between 0 and 100.",
      });
    }
  }
}

/**
 * Validates one statement against the constitution's non-negotiable
 * principles. Returns every failure found, not just the first — a producer
 * fixing a statement wants the whole list at once.
 */
export function validateStatement(statement: ProjectBrainStatement): GuardrailResult {
  const failures: GuardrailFailure[] = [];

  const definition = EPISTEMIC_TYPE_DEFINITION_BY_TYPE.get(statement.epistemicType);
  if (!definition) {
    return fail([
      {
        code: "unknown_epistemic_type",
        message: `"${statement.epistemicType}" is not one of the eight epistemic types the constitution defines.`,
      },
    ]);
  }

  if (!statement.text.trim()) {
    failures.push({ code: "empty_statement_text", message: "A statement must have non-empty text." });
  }

  // PB-REASON-02: a human report from the current conversation is support ONLY
  // for the types the constitution allows (REPORTED). It is never a source, and it
  // never satisfies FACT/INFERENCE/CONTRADICTION's evidence requirement.
  const reports = statement.reports ?? [];
  const support = statement.sources.length + (definition.humanReportsCountAsSupport ? reports.length : 0);
  if (support < definition.minSources) {
    failures.push({
      code: "insufficient_sources",
      message: `${definition.label} statements require at least ${definition.minSources} source(s)${definition.humanReportsCountAsSupport ? " or human report(s)" : ""} (evidence_before_assertion); found ${support}.`,
    });
  }

  if (reports.length > 0 && !REPORT_BEARING_TYPES.has(statement.epistemicType)) {
    failures.push({
      code: "reports_on_evidence_only_type",
      message: `A ${definition.label} statement cannot rest on a conversation report — only REPORTED, RECOMMENDATION, ASSUMPTION and OPEN_QUESTION may carry reports.`,
    });
  }
  for (const report of reports) {
    if (!report.turnId?.trim() || report.reportedBy !== "user") {
      failures.push({
        code: "invalid_report_reference",
        message: "A report reference must name the user turn it came from, and only a user can report — never the assistant.",
      });
    }
  }

  // Every source must be scoped to the same workspace/project as the statement.
  for (const source of statement.sources) {
    if (
      (source.workspaceId && source.workspaceId !== statement.scope.workspaceId) ||
      (source.projectId && source.projectId !== statement.scope.projectId)
    ) {
      failures.push({
        code: "source_crosses_project_boundary",
        message: `Source "${source.evidenceId}" belongs to a different workspace/project than this statement — evidence is never blended across projects.`,
      });
    }
  }

  validateConfidence(statement.confidence, failures);

  // High confidence requires at least one primary, authoritative source for
  // any type that claims to derive from evidence at all.
  const evidenceDerivedTypes = new Set(["FACT", "REPORTED", "INFERENCE", "CONTRADICTION"]);
  if (
    evidenceDerivedTypes.has(statement.epistemicType) &&
    statement.confidence.level === "high" &&
    !hasPrimarySource(statement.sources)
  ) {
    failures.push({
      code: "high_confidence_without_primary_source",
      message: "High confidence requires at least one primary source; unverified or secondary sources alone cannot justify it.",
    });
  }

  switch (statement.epistemicType) {
    case "FACT": {
      if (!hasPrimarySource(statement.sources)) {
        failures.push({
          code: "fact_without_primary_source",
          message: "A FACT must be backed by at least one primary (authoritative) source, not only reported or secondary ones.",
        });
      }
      break;
    }
    case "REPORTED": {
      if (!statement.reportedBy?.trim()) {
        failures.push({
          code: "reported_without_reporter",
          message: "A REPORTED statement must name who reported it (reportedBy) — otherwise it cannot be distinguished from a FACT.",
        });
      }
      break;
    }
    case "INFERENCE": {
      if (!statement.inferenceBasis?.trim()) {
        failures.push({
          code: "inference_without_basis",
          message: "An INFERENCE must state the reasoning that connects its sources to the conclusion (inferenceBasis).",
        });
      }
      break;
    }
    case "CONTRADICTION": {
      const claims = statement.contradictingClaims ?? [];
      if (claims.length < 2) {
        failures.push({
          code: "contradiction_needs_two_claims",
          message: "A CONTRADICTION must record at least two conflicting claims (contradictingClaims), each traceable to a source.",
        });
      }
      const sourceIds = new Set(statement.sources.map((s) => s.evidenceId));
      for (const claim of claims) {
        if (!sourceIds.has(claim.sourceEvidenceId)) {
          failures.push({
            code: "contradiction_claim_missing_source",
            message: `Contradicting claim references source "${claim.sourceEvidenceId}" which is not in this statement's sources.`,
          });
        }
      }
      break;
    }
    case "RECOMMENDATION": {
      if (statement.requiresHumanApproval !== true) {
        failures.push({
          code: "recommendation_without_approval_gate",
          message: "A RECOMMENDATION must always require human approval — it is never auto-applied or presented with a Decision's authority.",
        });
      }
      break;
    }
    case "UNKNOWN": {
      if (statement.sources.length > 0) {
        failures.push({
          code: "unknown_with_sources",
          message: "An UNKNOWN statement claims no supporting evidence exists — it cannot carry source references.",
        });
      }
      if (statement.confidence.level !== "unknown") {
        failures.push({
          code: "unknown_with_non_unknown_confidence",
          message: "An UNKNOWN statement's confidence level must be \"unknown\".",
        });
      }
      break;
    }
    case "OPEN_QUESTION": {
      if (statement.confidence.level === "high") {
        failures.push({
          code: "open_question_with_high_confidence",
          message: "An unresolved OPEN_QUESTION cannot simultaneously carry high confidence.",
        });
      }
      break;
    }
    case "ASSUMPTION":
      // No source or reporter requirement — an assumption is explicitly a
      // working belief, not a claim of evidence. Guarded only by the shared
      // checks above (text, confidence, project boundary).
      break;
  }

  return failures.length === 0 ? { ok: true } : fail(failures);
}

/** Validates every statement and knowledge gap in a response, plus response-level invariants. */
export function validateResponse(response: ProjectBrainResponse): GuardrailResult {
  const failures: GuardrailFailure[] = [];
  const seenStatementIds = new Set<string>();

  for (const statement of response.statements) {
    if (
      statement.scope.workspaceId !== response.scope.workspaceId ||
      statement.scope.projectId !== response.scope.projectId
    ) {
      failures.push({
        code: "statement_crosses_response_boundary",
        message: `Statement "${statement.id}" is scoped to a different workspace/project than the response it appears in.`,
      });
    }

    if (seenStatementIds.has(statement.id)) {
      failures.push({ code: "duplicate_statement_id", message: `Statement id "${statement.id}" appears more than once.` });
    }
    seenStatementIds.add(statement.id);

    const result = validateStatement(statement);
    if (!result.ok) {
      for (const failure of result.failures) {
        failures.push({ ...failure, message: `[${statement.id}] ${failure.message}` });
      }
    }
  }

  for (const gap of response.knowledgeGaps) {
    if (!gap.title.trim()) {
      failures.push({ code: "empty_knowledge_gap_title", message: `Knowledge gap "${gap.id}" has empty title.` });
    }
    if (!gap.question.trim()) {
      failures.push({ code: "empty_knowledge_gap", message: `Knowledge gap "${gap.id}" has empty question text.` });
    }
    if (!gap.reason.trim()) {
      failures.push({
        code: "knowledge_gap_without_reason",
        message: `Knowledge gap "${gap.id}" must explain why it matters — an unexplained gap reads as arbitrary.`,
      });
    }
    if (gap.epistemicStatus !== "UNKNOWN" && gap.epistemicStatus !== "OPEN_QUESTION") {
      failures.push({
        code: "invalid_knowledge_gap_epistemic_status",
        message: `Knowledge gap "${gap.id}" must be UNKNOWN or OPEN_QUESTION, found "${gap.epistemicStatus}".`,
      });
    }
    if (gap.scope.workspaceId !== response.scope.workspaceId || gap.scope.projectId !== response.scope.projectId) {
      failures.push({
        code: "knowledge_gap_crosses_response_boundary",
        message: `Knowledge gap "${gap.id}" is scoped to a different workspace/project than the response it appears in.`,
      });
    }
  }

  return failures.length === 0 ? { ok: true } : fail(failures);
}
