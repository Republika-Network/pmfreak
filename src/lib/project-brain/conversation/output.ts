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
//
// PB-REASON-01 adds a fake-precision check in the same pass: a reference-shaped
// token (milestone code, PR number, branch name, percentage, ISO date) that
// appears nowhere in what this turn supplied is counted, and a statement carrying
// one cannot stay evidence-backed — it is shown as an assumption.
//
// PB-REASON-02 adds report grounding: `reportIds` (R*) resolve ONLY against the
// server-built report map (reported-context.ts) — authenticated user turns of this
// conversation — and never against sources, nor sources against reports. A report
// supports a REPORTED claim (reportedBy is forced to "user"); it may be the basis of
// a RECOMMENDATION / ASSUMPTION / OPEN_QUESTION; it never supports FACT, INFERENCE
// or CONTRADICTION. A FACT citing any valid report becomes REPORTED, and an
// INFERENCE / CONTRADICTION / UNKNOWN citing one becomes ASSUMPTION — with or
// without sources, so a report is never laundered into evidence nor dropped.
// ─────────────────────────────────────────────────────────────────────────────

import { PROJECT_BRAIN_CONSTITUTION_VERSION } from "../constitution";
import { validateResponse, type GuardrailFailure } from "../guardrails";
import {
  EPISTEMIC_TYPES,
  type ContradictingClaim,
  type EpistemicType,
  type ProjectBrainReportReference,
  type ProjectBrainResponse,
  type ProjectBrainSourceReference,
  type ProjectBrainStatement,
  type ProjectContextScope,
  type QualitativeConfidenceLevel,
} from "../types";
import type { ProjectBrainContext, ProjectBrainContextReport, ProjectBrainContextSource } from "./context-types";
import { MAX_CONTEXT_SOURCES, MAX_HISTORY_MESSAGES, PROJECT_BRAIN_OUTPUT_LIMITS as LIMITS } from "./context-budget";

export const MAX_REPLY_CHARS = LIMITS.replyChars;
export const MAX_STATEMENTS = LIMITS.statements;
const MAX_STATEMENT_CHARS = LIMITS.statementChars;

export type RawModelStatement = {
  text: string;
  epistemicType: EpistemicType;
  sourceIds: string[];
  /** PB-REASON-02. Required by the strict schema; absent in pre-PB-REASON-02 fixtures = none. */
  reportIds?: string[];
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
    // Absent reportIds = no report support (the conservative direction); present
    // but malformed = the whole answer is not the contract.
    if (s.reportIds !== undefined && (!Array.isArray(s.reportIds) || !s.reportIds.every(isString))) return null;
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
      reportIds: (s.reportIds as string[] | undefined) ?? [],
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
  /**
   * PB-REASON-02: report ids the model cited that this turn's report map does not
   * contain (invented, a source id used as a report, beyond the per-statement cap).
   * Absent on rows written before PB-REASON-02.
   */
  rejectedReports?: number;
  /** Statements whose epistemic type or confidence was lowered to match their valid sources. */
  downgradedStatements: number;
  /** Statements dropped because they were empty or beyond the statement limit. */
  droppedStatements: number;
  /**
   * Distinct reference-shaped tokens (milestone code, PR number, branch, percentage,
   * ISO date) in the reply or statements that nothing this turn supplied contains.
   */
  unsupportedReferences: number;
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
/** Types that may keep report support (mirrors guardrails.ts). */
const REPORT_BEARING = new Set<EpistemicType>(["REPORTED", "RECOMMENDATION", "ASSUMPTION", "OPEN_QUESTION"]);
const SECONDARY_BASIS = "Derived from the cited project records, which are not all authoritative.";
const GENERIC_BASIS = "Derived from the cited project records.";

function clip(text: string, max: number): string {
  const value = text.trim();
  return value.length <= max ? value : `${value.slice(0, max - 1).trimEnd()}…`;
}

/**
 * Shapes of precise project references a model is prone to invent. Deliberately
 * narrow: a false positive only adds the "could not be fully linked" notice and
 * lowers a claim to an assumption — the conservative direction. Identifier codes
 * match in any case (MPP-07, mpp-07, Pb-Exec-01) and compare after lowercasing.
 */
export type ReferenceKind = "code" | "pr" | "branch" | "percent" | "date";

export const REFERENCE_PATTERNS: ReadonlyArray<{ kind: ReferenceKind; pattern: RegExp }> = [
  { kind: "code", pattern: /\b[a-z][a-z0-9]{1,9}(?:-[a-z][a-z0-9]{0,9})*-\d{1,5}\b/gi }, // MPP-04, pb-exec-01, JIRA-123
  { kind: "pr", pattern: /(?<![\w&])#\d{1,6}\b/g }, // PR / issue numbers
  { kind: "branch", pattern: /\b(?:feat|feature|fix|bugfix|hotfix|chore|release)\/[\w.\/-]*\w/gi }, // branch names
  { kind: "percent", pattern: /\b\d{1,3}(?:\.\d+)?\s?%/g }, // percentages
  { kind: "date", pattern: /\b\d{4}-\d{2}-\d{2}\b/g }, // ISO dates
];

export const normalizeReference = (value: string) => value.toLowerCase().replace(/\s+/g, " ").replace(/ %/g, "%");

export type Reference = { token: string; kind: ReferenceKind };

export function extractTypedReferences(text: string): Reference[] {
  const found = new Map<string, Reference>();
  for (const { kind, pattern } of REFERENCE_PATTERNS) {
    for (const match of text.matchAll(pattern)) {
      const token = normalizeReference(match[0]);
      if (!found.has(token)) found.set(token, { token, kind });
    }
  }
  return [...found.values()];
}

export function extractReferences(text: string): string[] {
  return extractTypedReferences(text).map((ref) => ref.token);
}

/** "pb-exec-01" → "pb-exec": the identifier family a code belongs to. */
const codeFamily = (token: string) => token.replace(/-\d+$/, "");

/**
 * Every reference this turn supplied: the records, their dates, today's date, the
 * question and what the USER said earlier. Prior assistant turns are excluded, so a
 * reference the model invented once cannot become "supplied" on the next turn.
 * Compared as exact tokens, so MPP-1 is not vouched for by MPP-10.
 */
export function suppliedReferenceText(context: ProjectBrainContext, question: string, generatedAt: string): string {
  return [
    context.projectName,
    generatedAt.slice(0, 10),
    question,
    ...context.sources.flatMap((s) => [s.label, s.content, s.reference.recordedAt.slice(0, 10)]),
    ...context.history.filter((m) => m.role === "user").map((m) => m.content),
  ].join("\n");
}

/** PB-EXEC-01 reuses this exact notion of "supplied" for execution briefs (execution-brief/ground.ts). */
export function suppliedReferences(context: ProjectBrainContext, question: string, generatedAt: string): { tokens: Set<string>; codeFamilies: Set<string> } {
  const refs = extractTypedReferences(suppliedReferenceText(context, question, generatedAt));
  return {
    tokens: new Set(refs.map((ref) => ref.token)),
    codeFamilies: new Set(refs.filter((ref) => ref.kind === "code").map((ref) => codeFamily(ref.token))),
  };
}

/**
 * Whether an unsupplied reference in a reply WITHOUT project statements (a general
 * or off-topic answer) is still project-shaped. "50%", a date or "COVID-19" in a
 * general answer is ordinary knowledge, not an invented project fact; a PR number,
 * a branch, or a code from one of this project's own identifier families (mpp-07
 * when the records use MPP-…) is project-shaped wherever it appears.
 */
function projectShaped(ref: Reference, codeFamilies: Set<string>): boolean {
  if (ref.kind === "pr" || ref.kind === "branch") return true;
  if (ref.kind === "code") return codeFamilies.has(codeFamily(ref.token));
  return false;
}

/** How a cited alias ("s3", " R2 ") is looked up in this turn's alias maps. Shared with execution-brief/ground.ts. */
export const normalizeCitationAlias = (id: string) => id.trim().toUpperCase();

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
  /** The user's question this turn — a reference the user typed is not invented. */
  question?: string;
}): { ok: true; value: GroundedOutput } | { ok: false; failures: GuardrailFailure[] } {
  const { output, context, generatedAt } = input;
  const scope: ProjectContextScope = context.scope;
  const byAlias = new Map<string, ProjectBrainContextSource>(context.sources.map((s) => [s.alias, s]));
  const byReportAlias = new Map<string, ProjectBrainContextReport>((context.reports ?? []).map((r) => [r.alias, r]));
  const citations: CitationReport = { rejectedCitations: 0, rejectedReports: 0, downgradedStatements: 0, droppedStatements: 0, unsupportedReferences: 0 };
  const supplied = suppliedReferences(context, input.question ?? "", generatedAt);
  const unsupported = new Set<string>();
  const unsupportedIn = (text: string, onlyProjectShaped = false): boolean => {
    const missing = extractTypedReferences(text).filter(
      (ref) => !supplied.tokens.has(ref.token) && (!onlyProjectShaped || projectShaped(ref, supplied.codeFamilies)),
    );
    for (const ref of missing) unsupported.add(ref.token);
    return missing.length > 0;
  };
  // A reply that makes project claims is checked in full. A reply with no
  // statements is conversational (general or off-topic): only project-shaped
  // references in it count, so "50%" answering "what is one half?" is not flagged.
  unsupportedIn(output.reply, output.statements.length === 0);

  const resolve = (id: string): ProjectBrainContextSource | null => {
    const source = byAlias.get(normalizeCitationAlias(id));
    if (!source) citations.rejectedCitations += 1;
    return source ?? null;
  };

  const resolveReport = (id: string): ProjectBrainContextReport | null => {
    const report = byReportAlias.get(normalizeCitationAlias(id));
    if (!report) citations.rejectedReports = (citations.rejectedReports ?? 0) + 1;
    return report ?? null;
  };

  const statements: GroundedStatement[] = [];
  citations.droppedStatements += Math.max(0, output.statements.length - MAX_STATEMENTS);
  for (const raw of output.statements.slice(0, MAX_STATEMENTS)) {
    const text = clip(raw.text, MAX_STATEMENT_CHARS);
    if (!text) {
      citations.droppedStatements += 1;
      continue;
    }
    const seen = new Set<string>();
    const sources: ProjectBrainSourceReference[] = [];
    const cited = raw.sourceIds.slice(0, LIMITS.sourceIdsPerStatement);
    citations.rejectedCitations += raw.sourceIds.length - cited.length;
    for (const id of cited) {
      const source = resolve(id);
      if (source && !seen.has(source.alias)) {
        seen.add(source.alias);
        sources.push(source.reference);
      }
    }
    const reports: ProjectBrainReportReference[] = [];
    const seenReports = new Set<string>();
    const rawReportIds = raw.reportIds ?? [];
    const citedReports = rawReportIds.slice(0, LIMITS.reportIdsPerStatement);
    citations.rejectedReports = (citations.rejectedReports ?? 0) + rawReportIds.length - citedReports.length;
    for (const id of citedReports) {
      const report = resolveReport(id);
      if (report && !seenReports.has(report.alias)) {
        seenReports.add(report.alias);
        reports.push(report.reference);
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
    // whatever the model called it: it is shown as an unverified assumption. The
    // same holds for a claim naming a reference nothing this turn supplied — a
    // cited record cannot vouch for a milestone code or PR number it never contains.
    const inventsReference = unsupportedIn(text);
    // A claim the model says rests on a VALID user report (resolved above — an
    // invented R999 is not support) is never left as an evidence-only type, whatever
    // sources it also cites: an incidental record must not launder a report into
    // evidence, nor may the report be silently dropped. FACT → REPORTED;
    // INFERENCE / CONTRADICTION / UNKNOWN → ASSUMPTION. The report stays attached.
    if (reports.length > 0 && !REPORT_BEARING.has(type)) {
      type = type === "FACT" ? "REPORTED" : "ASSUMPTION";
      if (type === "ASSUMPTION") confidence = "low";
    }
    const reportBacked = type === "REPORTED" && reports.length > 0;
    if ((EVIDENCE_DERIVED.has(type) && sources.length === 0 && !reportBacked) || (inventsReference && (EVIDENCE_DERIVED.has(type) || type === "RECOMMENDATION"))) {
      type = "ASSUMPTION";
      confidence = "low";
    }
    if (type === "CONTRADICTION") {
      const claims: ContradictingClaim[] = [];
      for (const claim of raw.contradictingClaims.slice(0, LIMITS.contradictingClaims)) {
        const source = resolve(claim.sourceId);
        if (source && sources.some((s) => s.evidenceId === source.reference.evidenceId) && claim.claim.trim()) {
          claims.push({ sourceEvidenceId: source.reference.evidenceId, claim: clip(claim.claim, LIMITS.contradictingClaimChars) });
        }
      }
      if (claims.length >= 2) contradictingClaims = claims;
      else type = "INFERENCE";
    }
    if (type === "FACT" && !hasPrimary) type = "INFERENCE";
    // Report-backed: the server knows exactly who said it — an authenticated user —
    // and never lets the model name a stakeholder role it cannot know.
    if (type === "REPORTED" && reports.length > 0) reportedBy = "user";
    if (type === "REPORTED" && !reportedBy) type = "INFERENCE";
    if (type === "INFERENCE" && !inferenceBasis) inferenceBasis = hasPrimary ? GENERIC_BASIS : SECONDARY_BASIS;
    if (EVIDENCE_DERIVED.has(type) && confidence === "high" && !hasPrimary) confidence = "medium";
    if (type === "OPEN_QUESTION" && confidence === "high") confidence = "medium";
    // What a user said is never high-confidence, even beside a primary source.
    if (reports.length > 0 && confidence === "high") confidence = "medium";
    if (type === "UNKNOWN") {
      sources.length = 0;
      confidence = "unknown";
    }
    if (type !== "INFERENCE") inferenceBasis = null;
    if (type !== "REPORTED") reportedBy = null;
    // Unreachable after the normalization above; kept as a defensive invariant.
    if (!REPORT_BEARING.has(type)) reports.length = 0;

    const downgraded = type !== original || confidence !== raw.confidence;
    if (downgraded) citations.downgradedStatements += 1;

    statements.push({
      id: `${input.statementIdPrefix}:${statements.length}`,
      scope,
      epistemicType: type,
      text,
      confidence: { kind: "qualitative", level: confidence },
      sources,
      ...(reports.length > 0 ? { reports } : {}),
      ...(reportedBy ? { reportedBy: clip(reportedBy, LIMITS.reportedByChars) } : {}),
      ...(inferenceBasis ? { inferenceBasis: clip(inferenceBasis, LIMITS.inferenceBasisChars) } : {}),
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
  citations.unsupportedReferences = unsupported.size;
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

/**
 * The largest output the contract allows: every field at its limit, the longest
 * enum values, the widest alias ("S48"). Its JSON size is what `maxTokens` must fit
 * (see context-budget.ts); tests pin that relationship so the caps and the token
 * ceiling cannot drift apart again.
 */
export function worstCaseProjectBrainOutput(): RawModelOutput {
  const longestType = [...EPISTEMIC_TYPES].sort((a, b) => b.length - a.length)[0];
  const alias = `S${MAX_CONTEXT_SOURCES}`;
  // Every history message a user turn, plus the current one.
  const reportAlias = `R${MAX_HISTORY_MESSAGES + 1}`;
  return {
    reply: "x".repeat(LIMITS.replyChars),
    statements: Array.from({ length: LIMITS.statements }, () => ({
      text: "x".repeat(LIMITS.statementChars),
      epistemicType: longestType,
      sourceIds: Array.from({ length: LIMITS.sourceIdsPerStatement }, () => alias),
      reportIds: Array.from({ length: LIMITS.reportIdsPerStatement }, () => reportAlias),
      confidence: "unknown" as QualitativeConfidenceLevel,
      inferenceBasis: "x".repeat(LIMITS.inferenceBasisChars),
      reportedBy: "x".repeat(LIMITS.reportedByChars),
      contradictingClaims: Array.from({ length: LIMITS.contradictingClaims }, () => ({ sourceId: alias, claim: "x".repeat(LIMITS.contradictingClaimChars) })),
    })),
  };
}
