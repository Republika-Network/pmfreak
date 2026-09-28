// ─────────────────────────────────────────────────────────────────────────────
// Execution Brief — the TRANSIENT model contract (PB-EXEC-01, §9.3, §13)
//
// The model never writes ExecutionBriefV1. It fills this strict schema of
// narrative/candidate fields only, citing request-local aliases (S1…, R1…) that
// the server resolves and then DISCARDS (ground.ts). identity, capability,
// targetRef, repositoryContext, handoff, readiness and provenance are not in it,
// so the model cannot write them.
//
//   additionalProperties: false everywhere · every property required · enums closed
//   arrays bounded (maxItems) · strings bounded by the parser (below)
//
// A shape violation (missing/extra key, wrong type, value outside an enum) makes the
// whole output null → the turn degrades; there is no partial brief. A string over its
// limit is never clipped (clipping an instruction can change its meaning): a list
// item over its limit is dropped whole and counted, a single-valued field over its
// limit is removed like an unsupported one (ground.ts).
// ─────────────────────────────────────────────────────────────────────────────

import type { InferenceJsonSchema } from "@/lib/ai/inference/types";
import { MAX_CONTEXT_SOURCES, MAX_HISTORY_MESSAGES, OUTPUT_CHARS_PER_TOKEN_FLOOR, OUTPUT_TOKEN_SAFETY_MARGIN } from "../conversation/context-budget";
import type { CapabilityFit, UnknownResolveBy, VerificationKind } from "./types";

export const EXECUTION_BRIEF_OUTPUT_LIMITS = {
  titleChars: 120,
  statementChars: 400,
  objectiveChars: 600,
  whyNowChars: 400,
  itemChars: 280,
  unknownFactChars: 200,
  unknownWhyChars: 200,
  stepChars: 240,
  commandChars: 200,
  knownContext: 6,
  reportedContext: 6,
  assumptions: 4,
  unknowns: 8,
  inScope: 8,
  outOfScope: 8,
  areasToInspect: 6,
  constraints: 6,
  acceptanceCriteria: 8,
  verificationPlan: 8,
  sourceAliasesPerItem: 4,
  reportAliasesPerItem: 3,
} as const;

const L = EXECUTION_BRIEF_OUTPUT_LIMITS;

export const CAPABILITY_FITS: readonly CapabilityFit[] = ["fits", "not_code", "unclear"];
export const MODEL_OBJECTIVE_ORIGINS = ["project_record", "reported", "suggested"] as const;
export const MODEL_AREA_ORIGINS = ["project_record", "reported"] as const;
export const UNKNOWN_RESOLVERS: readonly UnknownResolveBy[] = ["user", "project_record", "repository_binding"];
export const VERIFICATION_KINDS: readonly VerificationKind[] = ["test", "build", "lint", "review", "manual_check", "other"];

type ModelOrigin = (typeof MODEL_OBJECTIVE_ORIGINS)[number];
type Aliased = { sourceAliases: string[]; reportAliases: string[] };

export type ExecutionBriefModelOutput = {
  capabilityFit: CapabilityFit;
  target: { title: string; statement: string } & Aliased;
  objective: { text: string; origin: ModelOrigin } & Aliased;
  whyNow: { text: string } & Aliased;
  knownContext: Array<{ text: string; sourceAliases: string[] }>;
  reportedContext: Array<{ text: string; reportAliases: string[]; executionSensitive: boolean }>;
  assumptions: Array<{ text: string }>;
  unknowns: Array<{ fact: string; why: string; resolveBy: UnknownResolveBy; blocking: boolean }>;
  scope: { inScope: string[]; outOfScope: string[] };
  areasToInspect: Array<{ text: string; origin: (typeof MODEL_AREA_ORIGINS)[number] } & Aliased>;
  constraints: Array<{ text: string; origin: ModelOrigin } & Aliased>;
  acceptanceCriteria: Array<{ text: string; origin: ModelOrigin } & Aliased>;
  verificationPlan: Array<{ step: string; kind: VerificationKind; command: string | null } & Aliased>;
};

// ─── JSON schema sent to the provider ────────────────────────────────────────

const str = { type: "string" } as const;
const aliases = (max: number) => ({ type: "array", items: str, maxItems: max });
const obj = (properties: Record<string, unknown>) => ({ type: "object", additionalProperties: false, required: Object.keys(properties), properties });
const list = (items: unknown, max: number) => ({ type: "array", items, maxItems: max });
const aliased = { sourceAliases: aliases(L.sourceAliasesPerItem), reportAliases: aliases(L.reportAliasesPerItem) };
const originEnum = { type: "string", enum: [...MODEL_OBJECTIVE_ORIGINS] };

export const EXECUTION_BRIEF_MODEL_SCHEMA: InferenceJsonSchema = {
  name: "project_brain_execution_brief",
  strict: true,
  schema: obj({
    capabilityFit: { type: "string", enum: [...CAPABILITY_FITS] },
    target: obj({ title: str, statement: str, ...aliased }),
    objective: obj({ text: str, origin: originEnum, ...aliased }),
    whyNow: obj({ text: str, ...aliased }),
    knownContext: list(obj({ text: str, sourceAliases: aliases(L.sourceAliasesPerItem) }), L.knownContext),
    reportedContext: list(obj({ text: str, reportAliases: aliases(L.reportAliasesPerItem), executionSensitive: { type: "boolean" } }), L.reportedContext),
    assumptions: list(obj({ text: str }), L.assumptions),
    unknowns: list(obj({ fact: str, why: str, resolveBy: { type: "string", enum: [...UNKNOWN_RESOLVERS] }, blocking: { type: "boolean" } }), L.unknowns),
    scope: obj({ inScope: list(str, L.inScope), outOfScope: list(str, L.outOfScope) }),
    areasToInspect: list(obj({ text: str, origin: { type: "string", enum: [...MODEL_AREA_ORIGINS] }, ...aliased }), L.areasToInspect),
    constraints: list(obj({ text: str, origin: originEnum, ...aliased }), L.constraints),
    acceptanceCriteria: list(obj({ text: str, origin: originEnum, ...aliased }), L.acceptanceCriteria),
    verificationPlan: list(obj({ step: str, kind: { type: "string", enum: [...VERIFICATION_KINDS] }, command: { type: ["string", "null"] }, ...aliased }), L.verificationPlan),
  }) as Record<string, unknown>,
};

// ─── Strict parser ───────────────────────────────────────────────────────────

type AnyRecord = Record<string, unknown>;
const isString = (v: unknown): v is string => typeof v === "string";
const isStringArray = (v: unknown): v is string[] => Array.isArray(v) && v.every(isString);

/** Exactly these keys — no more, no fewer. */
function exact(value: unknown, keys: readonly string[]): AnyRecord | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as AnyRecord;
  const own = Object.keys(record);
  if (own.length !== keys.length || !keys.every((k) => Object.prototype.hasOwnProperty.call(record, k))) return null;
  return record;
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[]): value is T {
  return isString(value) && (allowed as readonly string[]).includes(value);
}

function aliasFields(r: AnyRecord): Aliased | null {
  if (!isStringArray(r.sourceAliases) || !isStringArray(r.reportAliases)) return null;
  return { sourceAliases: r.sourceAliases, reportAliases: r.reportAliases };
}

function parseList<T>(value: unknown, parse: (item: unknown) => T | null): T[] | null {
  if (!Array.isArray(value)) return null;
  const out: T[] = [];
  for (const item of value) {
    const parsed = parse(item);
    if (parsed === null) return null;
    out.push(parsed);
  }
  return out;
}

const TOP_KEYS = ["capabilityFit", "target", "objective", "whyNow", "knownContext", "reportedContext", "assumptions", "unknowns", "scope", "areasToInspect", "constraints", "acceptanceCriteria", "verificationPlan"] as const;

/**
 * Strict shape check of untrusted model output. Returns null for anything that is
 * not exactly the contract. Bounds on lengths and counts are applied by grounding,
 * which drops (never clips) and counts.
 */
export function parseExecutionBriefModelOutput(input: { parsedJson?: unknown; content?: string }): ExecutionBriefModelOutput | null {
  let value: unknown = input.parsedJson;
  if (value === undefined && isString(input.content)) {
    try {
      value = JSON.parse(input.content);
    } catch {
      return null;
    }
  }
  const top = exact(value, TOP_KEYS);
  if (!top || !oneOf(top.capabilityFit, CAPABILITY_FITS)) return null;

  const target = exact(top.target, ["title", "statement", "sourceAliases", "reportAliases"]);
  const objective = exact(top.objective, ["text", "origin", "sourceAliases", "reportAliases"]);
  const whyNow = exact(top.whyNow, ["text", "sourceAliases", "reportAliases"]);
  const scope = exact(top.scope, ["inScope", "outOfScope"]);
  if (!target || !objective || !whyNow || !scope) return null;
  if (!isString(target.title) || !isString(target.statement) || !isString(objective.text) || !isString(whyNow.text)) return null;
  if (!oneOf(objective.origin, MODEL_OBJECTIVE_ORIGINS)) return null;
  if (!isStringArray(scope.inScope) || !isStringArray(scope.outOfScope)) return null;
  const targetAliases = aliasFields(target);
  const objectiveAliases = aliasFields(objective);
  const whyAliases = aliasFields(whyNow);
  if (!targetAliases || !objectiveAliases || !whyAliases) return null;

  const knownContext = parseList(top.knownContext, (item) => {
    const r = exact(item, ["text", "sourceAliases"]);
    return r && isString(r.text) && isStringArray(r.sourceAliases) ? { text: r.text, sourceAliases: r.sourceAliases } : null;
  });
  const reportedContext = parseList(top.reportedContext, (item) => {
    const r = exact(item, ["text", "reportAliases", "executionSensitive"]);
    return r && isString(r.text) && isStringArray(r.reportAliases) && typeof r.executionSensitive === "boolean"
      ? { text: r.text, reportAliases: r.reportAliases, executionSensitive: r.executionSensitive }
      : null;
  });
  const assumptions = parseList(top.assumptions, (item) => {
    const r = exact(item, ["text"]);
    return r && isString(r.text) ? { text: r.text } : null;
  });
  const unknowns = parseList(top.unknowns, (item) => {
    const r = exact(item, ["fact", "why", "resolveBy", "blocking"]);
    return r && isString(r.fact) && isString(r.why) && oneOf(r.resolveBy, UNKNOWN_RESOLVERS) && typeof r.blocking === "boolean"
      ? { fact: r.fact, why: r.why, resolveBy: r.resolveBy, blocking: r.blocking }
      : null;
  });
  const areasToInspect = parseList(top.areasToInspect, (item) => {
    const r = exact(item, ["text", "origin", "sourceAliases", "reportAliases"]);
    const a = r ? aliasFields(r) : null;
    return r && a && isString(r.text) && oneOf(r.origin, MODEL_AREA_ORIGINS) ? { text: r.text, origin: r.origin, ...a } : null;
  });
  const originItem = (item: unknown) => {
    const r = exact(item, ["text", "origin", "sourceAliases", "reportAliases"]);
    const a = r ? aliasFields(r) : null;
    return r && a && isString(r.text) && oneOf(r.origin, MODEL_OBJECTIVE_ORIGINS) ? { text: r.text, origin: r.origin, ...a } : null;
  };
  const constraints = parseList(top.constraints, originItem);
  const acceptanceCriteria = parseList(top.acceptanceCriteria, originItem);
  const verificationPlan = parseList(top.verificationPlan, (item) => {
    const r = exact(item, ["step", "kind", "command", "sourceAliases", "reportAliases"]);
    const a = r ? aliasFields(r) : null;
    return r && a && isString(r.step) && oneOf(r.kind, VERIFICATION_KINDS) && (r.command === null || isString(r.command))
      ? { step: r.step, kind: r.kind, command: r.command as string | null, ...a }
      : null;
  });
  if (!knownContext || !reportedContext || !assumptions || !unknowns || !areasToInspect || !constraints || !acceptanceCriteria || !verificationPlan) return null;

  return {
    capabilityFit: top.capabilityFit,
    target: { title: target.title, statement: target.statement, ...targetAliases },
    objective: { text: objective.text, origin: objective.origin, ...objectiveAliases },
    whyNow: { text: whyNow.text, ...whyAliases },
    knownContext,
    reportedContext,
    assumptions,
    unknowns,
    scope: { inScope: scope.inScope, outOfScope: scope.outOfScope },
    areasToInspect,
    constraints,
    acceptanceCriteria,
    verificationPlan,
  };
}

// ─── Dedicated output budget ─────────────────────────────────────────────────

/**
 * The largest output the contract allows: every string at its limit, every array
 * full, the widest aliases ("S48", "R25") and the longest enum values. Its JSON size
 * is what `EXECUTION_BRIEF_INFERENCE.maxTokens` must fit — the SAME methodology as
 * ordinary turns (context-budget.ts): tokens ≤ chars / OUTPUT_CHARS_PER_TOKEN_FLOOR,
 * × OUTPUT_TOKEN_SAFETY_MARGIN, rounded up. Tests pin the relationship.
 */
export function worstCaseExecutionBriefModelOutput(): ExecutionBriefModelOutput {
  const s = `S${MAX_CONTEXT_SOURCES}`;
  const r = `R${MAX_HISTORY_MESSAGES + 1}`;
  const x = (n: number) => "x".repeat(n);
  const al = { sourceAliases: Array(L.sourceAliasesPerItem).fill(s), reportAliases: Array(L.reportAliasesPerItem).fill(r) };
  const longest = <T extends string>(values: readonly T[]) => [...values].sort((a, b) => b.length - a.length)[0];
  const origin = longest(MODEL_OBJECTIVE_ORIGINS);
  return {
    capabilityFit: longest(CAPABILITY_FITS),
    target: { title: x(L.titleChars), statement: x(L.statementChars), ...al },
    objective: { text: x(L.objectiveChars), origin, ...al },
    whyNow: { text: x(L.whyNowChars), ...al },
    knownContext: Array.from({ length: L.knownContext }, () => ({ text: x(L.itemChars), sourceAliases: al.sourceAliases })),
    reportedContext: Array.from({ length: L.reportedContext }, () => ({ text: x(L.itemChars), reportAliases: al.reportAliases, executionSensitive: false })),
    assumptions: Array.from({ length: L.assumptions }, () => ({ text: x(L.itemChars) })),
    unknowns: Array.from({ length: L.unknowns }, () => ({ fact: x(L.unknownFactChars), why: x(L.unknownWhyChars), resolveBy: longest(UNKNOWN_RESOLVERS), blocking: false })),
    scope: { inScope: Array(L.inScope).fill(x(L.itemChars)), outOfScope: Array(L.outOfScope).fill(x(L.itemChars)) },
    areasToInspect: Array.from({ length: L.areasToInspect }, () => ({ text: x(L.itemChars), origin: longest(MODEL_AREA_ORIGINS), ...al })),
    constraints: Array.from({ length: L.constraints }, () => ({ text: x(L.itemChars), origin, ...al })),
    acceptanceCriteria: Array.from({ length: L.acceptanceCriteria }, () => ({ text: x(L.itemChars), origin, ...al })),
    verificationPlan: Array.from({ length: L.verificationPlan }, () => ({ step: x(L.stepChars), kind: longest(VERIFICATION_KINDS), command: x(L.commandChars), ...al })),
  };
}

export function requiredExecutionBriefMaxTokens(): number {
  const chars = JSON.stringify(worstCaseExecutionBriefModelOutput()).length;
  return Math.ceil((chars / OUTPUT_CHARS_PER_TOKEN_FLOOR) * OUTPUT_TOKEN_SAFETY_MARGIN);
}

/**
 * Inference parameters for ONE execution-brief request. Separate from
 * PROJECT_BRAIN_INFERENCE (ordinary turns keep 3800 / 20 s / 2 attempts).
 *
 *   maxTokens    ≥ requiredExecutionBriefMaxTokens() (≈ 28.1k characters worst case
 *                → ≈ 11.25k tokens with the 3-chars/token floor and 1.2 margin)
 *   maxAttempts  1 — a brief is larger and slower; one attempt of ≤ 45 s keeps the
 *                whole call inside TURN_PENDING_WINDOW_MS, so a duplicate request can
 *                never mistake an in-flight brief for a dead one and call the model again.
 */
export const EXECUTION_BRIEF_INFERENCE = {
  temperature: 0.2,
  maxTokens: 11_500,
  timeoutMs: 45_000,
  maxAttempts: 1,
  retryDelayMs: 0,
} as const;
