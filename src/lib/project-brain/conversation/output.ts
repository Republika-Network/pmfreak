// ─────────────────────────────────────────────────────────────────────────────
// Project Brain conversation — model output → validated statements (PB-CHAT-01)
//
//   untrusted model JSON
//     ↓ parseProjectBrainModelOutput   shape check; anything malformed → null
//     ↓ groundProjectBrainOutput       citation validation against the aliases
//                                      THIS turn supplied; deterministic epistemic
//                                      downgrades so no claim outranks its sources
//     ↓ validateResponse (guardrails)  the Sprint 0 constitution, unchanged
//     ↓ safe to persist and render — or null, and the caller degrades
//
// The model can never introduce a source: a citation is only ever a lookup into
// the server-built alias table, so an invented id, another project's id or a
// malformed reference simply resolves to nothing and is dropped.
// ─────────────────────────────────────────────────────────────────────────────

import { PROJECT_BRAIN_CONSTITUTION_VERSION } from "../constitution";
import { validateResponse, type GuardrailFailure } from "../guardrails";
import {
  EPISTEMIC_TYPES,
  type ContradictingClaim,
  type EpistemicType,
  type ProjectBrainResponse,
  type ProjectBrainSourceReference,
  type ProjectBrainStatement,
  type ProjectContextScope,
  type QualitativeConfidenceLevel,
} from "../types";
import type { ProjectBrainContext, ProjectBrainContextSource } from "./context-types";

export const MAX_REPLY_CHARS = 6000;
export const MAX_STATEMENTS = 12;
const MAX_STATEMENT_CHARS = 800;

export type RawModelStatement = {
  text: string;
  epistemicType: EpistemicType;
  sourceIds: string[];
  confidence: QualitativeConfidenceLevel;
  inferenceBasis: string | null;
  reportedBy: string | null;
  contradictingClaims: Array<{ sourceId: string; claim: string }>;
};

export type RawModelOutput = { reply: string; statements: RawModelStatement[] };

const CONFIDENCE_LEVELS = new Set(["high", "medium", "low", "unknown"]);
const EPISTEMIC_SET = new Set<string>(EPISTEMIC_TYPES);

const isString = (value: unknown): value is string => typeof value === "string";
const nullableString = (value: unknown): value is string | null => value === null || typeof value === "string";

/** Strict shape check. Returns null for anything that is not exactly the contract. */
export function parseProjectBrainModelOutput(input: { parsedJson?: unknown; content?: string }): RawModelOutput | null {
  let value: unknown = input.parsedJson;
  if (value === undefined && isString(input.content)) {
    try {
      value = JSON.parse(input.content);
    } catch {
      return null;
    }
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (!isString(record.reply) || !record.reply.trim() || !Array.isArray(record.statements)) return null;

  const statements: RawModelStatement[] = [];
  for (const entry of record.statements) {
    if (!entry || typeof entry !== "object") return null;
    const s = entry as Record<string, unknown>;
    if (!isString(s.text) || !isString(s.epistemicType) || !EPISTEMIC_SET.has(s.epistemicType)) return null;
    if (!Array.isArray(s.sourceIds) || !s.sourceIds.every(isString)) return null;
    if (!isString(s.confidence) || !CONFIDENCE_LEVELS.has(s.confidence)) return null;
    if (!nullableString(s.inferenceBasis) || !nullableString(s.reportedBy)) return null;
    const claims = Array.isArray(s.contradictingClaims) ? s.contradictingClaims : [];
    const contradictingClaims: RawModelStatement["contradictingClaims"] = [];
    for (const claim of claims) {
      if (!claim || typeof claim !== "object") return null;
      const c = claim as Record<string, unknown>;
      if (!isString(c.sourceId) || !isString(c.claim)) return null;
      contradictingClaims.push({ sourceId: c.sourceId, claim: c.claim });
    }
    statements.push({
      text: s.text,
      epistemicType: s.epistemicType as EpistemicType,
      sourceIds: s.sourceIds as string[],
      confidence: s.confidence as QualitativeConfidenceLevel,
      inferenceBasis: s.inferenceBasis as string | null,
      reportedBy: s.reportedBy as string | null,
      contradictingClaims,
    });
  }
  return { reply: record.reply, statements };
}

export type CitationReport = {
  /** Source ids the model cited that this turn never supplied (invented, foreign or malformed). */
  rejectedCitations: number;
  /** Statements whose epistemic type or confidence was lowered to match their valid sources. */
  downgradedStatements: number;
  /** Statements dropped because they were empty. */
  droppedStatements: number;
};

export type GroundedStatement = ProjectBrainStatement & { downgradedFrom?: EpistemicType };

export type GroundedOutput = {
  reply: string;
  statements: GroundedStatement[];
  /** Union of every validated source any statement cites, in first-cited order. */
  sources: ProjectBrainSourceReference[];
  citations: CitationReport;
};

const EVIDENCE_DERIVED = new Set<EpistemicType>(["FACT", "REPORTED", "INFERENCE", "CONTRADICTION"]);
const SECONDARY_BASIS = "Derived from the cited project records, which are not all authoritative.";
const GENERIC_BASIS = "Derived from the cited project records.";

function clip(text: string, max: number): string {
  const value = text.trim();
  return value.length <= max ? value : `${value.slice(0, max - 1).trimEnd()}…`;
}

/**
 * Pure. Resolves citations, applies deterministic downgrades, and returns
 * statements that satisfy the constitution — or null when even the normalized
 * response fails `validateResponse` (caller must degrade, never persist it).
 */
export function groundProjectBrainOutput(input: {
  output: RawModelOutput;
  context: ProjectBrainContext;
  statementIdPrefix: string;
  generatedAt: string;
}): { ok: true; value: GroundedOutput } | { ok: false; failures: GuardrailFailure[] } {
  const { output, context, generatedAt } = input;
  const scope: ProjectContextScope = context.scope;
  const byAlias = new Map<string, ProjectBrainContextSource>(context.sources.map((s) => [s.alias, s]));
  const citations: CitationReport = { rejectedCitations: 0, downgradedStatements: 0, droppedStatements: 0 };

  const resolve = (id: string): ProjectBrainContextSource | null => {
    const source = byAlias.get(id.trim().toUpperCase());
    if (!source) citations.rejectedCitations += 1;
    return source ?? null;
  };

  const statements: GroundedStatement[] = [];
  for (const raw of output.statements.slice(0, MAX_STATEMENTS)) {
    const text = clip(raw.text, MAX_STATEMENT_CHARS);
    if (!text) {
      citations.droppedStatements += 1;
      continue;
    }
    const seen = new Set<string>();
    const sources: ProjectBrainSourceReference[] = [];
    for (const id of raw.sourceIds) {
      const source = resolve(id);
      if (source && !seen.has(source.alias)) {
        seen.add(source.alias);
        sources.push(source.reference);
      }
    }

    const original = raw.epistemicType;
    let type: EpistemicType = original;
    let confidence: QualitativeConfidenceLevel = raw.confidence;
    let inferenceBasis = raw.inferenceBasis?.trim() || null;
    let reportedBy = raw.reportedBy?.trim() || null;
    let contradictingClaims: ContradictingClaim[] | undefined;
    const hasPrimary = sources.some((s) => s.isPrimary);

    // A project claim with no valid supporting source is not evidence-backed,
    // whatever the model called it: it is shown as an unverified assumption.
    if (EVIDENCE_DERIVED.has(type) && sources.length === 0) {
      type = "ASSUMPTION";
      confidence = "low";
    }
    if (type === "CONTRADICTION") {
      const claims: ContradictingClaim[] = [];
      for (const claim of raw.contradictingClaims) {
        const source = resolve(claim.sourceId);
        if (source && sources.some((s) => s.evidenceId === source.reference.evidenceId) && claim.claim.trim()) {
          claims.push({ sourceEvidenceId: source.reference.evidenceId, claim: clip(claim.claim, 300) });
        }
      }
      if (claims.length >= 2) contradictingClaims = claims;
      else type = "INFERENCE";
    }
    if (type === "FACT" && !hasPrimary) type = "INFERENCE";
    if (type === "REPORTED" && !reportedBy) type = "INFERENCE";
    if (type === "INFERENCE" && !inferenceBasis) inferenceBasis = hasPrimary ? GENERIC_BASIS : SECONDARY_BASIS;
    if (EVIDENCE_DERIVED.has(type) && confidence === "high" && !hasPrimary) confidence = "medium";
    if (type === "OPEN_QUESTION" && confidence === "high") confidence = "medium";
    if (type === "UNKNOWN") {
      sources.length = 0;
      confidence = "unknown";
    }
    if (type !== "INFERENCE") inferenceBasis = null;
    if (type !== "REPORTED") reportedBy = null;

    const downgraded = type !== original || confidence !== raw.confidence;
    if (downgraded) citations.downgradedStatements += 1;

    statements.push({
      id: `${input.statementIdPrefix}:${statements.length}`,
      scope,
      epistemicType: type,
      text,
      confidence: { kind: "qualitative", level: confidence },
      sources,
      ...(reportedBy ? { reportedBy: clip(reportedBy, 120) } : {}),
      ...(inferenceBasis ? { inferenceBasis: clip(inferenceBasis, 400) } : {}),
      ...(contradictingClaims ? { contradictingClaims } : {}),
      ...(type === "RECOMMENDATION" ? { requiresHumanApproval: true } : {}),
      generatedAt,
      constitutionVersion: PROJECT_BRAIN_CONSTITUTION_VERSION,
      ...(type !== original ? { downgradedFrom: original } : {}),
    });
  }

  const response: ProjectBrainResponse = {
    scope,
    generatedAt,
    constitutionVersion: PROJECT_BRAIN_CONSTITUTION_VERSION,
    statements,
    knowledgeGaps: [],
  };
  const validation = validateResponse(response);
  if (!validation.ok) return { ok: false, failures: validation.failures };

  const sources: ProjectBrainSourceReference[] = [];
  const seenSources = new Set<string>();
  for (const statement of statements) {
    for (const source of statement.sources) {
      if (!seenSources.has(source.evidenceId)) {
        seenSources.add(source.evidenceId);
        sources.push(source);
      }
    }
  }

  return { ok: true, value: { reply: clip(output.reply, MAX_REPLY_CHARS), statements, sources, citations } };
}
