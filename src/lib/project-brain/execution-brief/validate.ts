// ─────────────────────────────────────────────────────────────────────────────
// Execution Brief — strict validator for a PERSISTED ExecutionBriefV1 (PB-EXEC-01)
//
// Used after assembly (before persistence), when turning transcript metadata into
// the client view, and before rendering. Data is never trusted just because this
// service wrote it: a malformed or legacy brief returns null and the caller omits
// it (the transcript never crashes, nothing unknown reaches the browser).
//
// Beyond shapes and enums it re-asserts the invariants that make a brief safe:
//   * handoff: manual, executionAuthorized false, delegationEligible false;
//   * provenance.aiGenerated true; generator.operation = project_brain.execution_brief;
//   * no transient alias (S12 / R3) in any id field;
//   * a `project_record` item cites ≥1 source, a `reported` item ≥1 turn;
//   * `command` only with a basis, and never without one.
// The returned value is rebuilt from known keys only — unknown keys are dropped.
// Pure; browser-safe.
// ─────────────────────────────────────────────────────────────────────────────

import { EXECUTION_BRIEF_OPERATION, EXECUTION_BRIEF_SCHEMA, EXECUTION_BRIEF_VERSION, type BriefCitationReport, type ExecutionBriefV1 } from "./types";

type R = Record<string, unknown>;
class Invalid extends Error {}
const fail = (): never => {
  throw new Invalid();
};
const rec = (v: unknown): R => (v && typeof v === "object" && !Array.isArray(v) ? (v as R) : fail());
const str = (v: unknown, max = 4000): string => (typeof v === "string" && v.length <= max ? v : fail());
const nstr = (v: unknown, max = 4000): string | null => (v === null ? null : str(v, max));
const bool = (v: unknown): boolean => (typeof v === "boolean" ? v : fail());
const num = (v: unknown): number => (typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : fail());
const arr = <T>(v: unknown, max: number, item: (x: unknown) => T): T[] => (Array.isArray(v) && v.length <= max ? v.map(item) : fail());
const oneOf = <T extends string>(v: unknown, allowed: readonly T[]): T => (typeof v === "string" && (allowed as readonly string[]).includes(v) ? (v as T) : fail());
const ALIAS = /^[SR]\d+$/i;
const id = (v: unknown): string => {
  const s = str(v, 200);
  return s.length === 0 || ALIAS.test(s.trim()) ? fail() : s;
};
const ids = (v: unknown) => arr(v, 16, id);

const ORIGINS = ["project_record", "reported", "suggested"] as const;
const ALL_ORIGINS = ["project_record", "reported", "policy", "suggested"] as const;

function supported(origin: string, sourceIds: string[], reportedTurnIds: string[]) {
  if (origin === "project_record" && sourceIds.length === 0) fail();
  if (origin === "reported" && reportedTurnIds.length === 0) fail();
}

function citations(v: unknown): BriefCitationReport {
  const c = rec(v);
  return {
    rejectedCitations: num(c.rejectedCitations),
    rejectedReports: num(c.rejectedReports),
    unsupportedReferences: num(c.unsupportedReferences),
    credentialFindings: num(c.credentialFindings),
    droppedItems: num(c.droppedItems),
    demotedItems: num(c.demotedItems),
    blockedCommands: num(c.blockedCommands),
  };
}

function build(value: unknown): ExecutionBriefV1 {
  const b = rec(value);
  if (b.schema !== EXECUTION_BRIEF_SCHEMA || b.version !== EXECUTION_BRIEF_VERSION) fail();

  const i = rec(b.identity);
  const g = rec(i.generator);
  if (g.mode !== "generative" || g.operation !== EXECUTION_BRIEF_OPERATION) fail();
  const identity: ExecutionBriefV1["identity"] = {
    briefId: id(i.briefId),
    workspaceId: id(i.workspaceId),
    projectId: id(i.projectId),
    conversationId: id(i.conversationId),
    requestTurnId: id(i.requestTurnId),
    generatedAt: str(i.generatedAt, 40),
    contextFingerprint: /^sha256:[0-9a-f]{64}$/.test(String(i.contextFingerprint)) ? String(i.contextFingerprint) : fail(),
    briefContentHash: /^sha256:[0-9a-f]{64}$/.test(String(i.briefContentHash)) ? String(i.briefContentHash) : fail(),
    generator: { mode: "generative", provider: str(g.provider, 80), model: str(g.model, 120), operation: EXECUTION_BRIEF_OPERATION },
  };

  if (b.capability !== "code") fail();
  const capabilityFit = oneOf(b.capabilityFit, ["fits", "not_code", "unclear"] as const);

  const t = rec(b.targetRef);
  const targetRef: ExecutionBriefV1["targetRef"] =
    t.kind === "current_user_request"
      ? { kind: "current_user_request" }
      : t.kind === "project_brain_recommendation"
        ? { kind: "project_brain_recommendation", assistantTurnId: id(t.assistantTurnId), statementId: id(t.statementId), resolvedBy: oneOf(t.resolvedBy, ["explicit", "single_candidate"] as const) }
        : fail();

  const target = b.target === null ? null : (() => {
    const x = rec(b.target);
    return { title: str(x.title, 120), statement: str(x.statement, 400), sourceIds: ids(x.sourceIds), reportedTurnIds: ids(x.reportedTurnIds) };
  })();
  const objective = b.objective === null ? null : (() => {
    const x = rec(b.objective);
    const o = { text: str(x.text, 600), origin: oneOf(x.origin, ORIGINS), sourceIds: ids(x.sourceIds), reportedTurnIds: ids(x.reportedTurnIds) };
    supported(o.origin, o.sourceIds, o.reportedTurnIds);
    return o;
  })();
  const whyNow = b.whyNow === null ? null : (() => {
    const x = rec(b.whyNow);
    return { text: str(x.text, 400), sourceIds: ids(x.sourceIds), reportedTurnIds: ids(x.reportedTurnIds) };
  })();

  const knownContext = arr(b.knownContext, 16, (v) => {
    const x = rec(v);
    const item = { text: str(x.text, 280), sourceIds: ids(x.sourceIds) };
    if (item.sourceIds.length === 0) fail();
    return item;
  });
  const reportedContext = arr(b.reportedContext, 16, (v) => {
    const x = rec(v);
    const item = { text: str(x.text, 280), reportedTurnIds: ids(x.reportedTurnIds), executionSensitive: bool(x.executionSensitive) };
    if (item.reportedTurnIds.length === 0) fail();
    return item;
  });
  const assumptions = arr(b.assumptions, 32, (v) => ({ text: str(rec(v).text, 280) }));
  const unknowns = arr(b.unknowns, 96, (v) => {
    const x = rec(v);
    return { fact: str(x.fact, 400), why: str(x.why, 400), resolveBy: oneOf(x.resolveBy, ["user", "project_record", "repository_binding"] as const), blocking: bool(x.blocking) };
  });
  const s = rec(b.scope);
  const scope = { inScope: arr(s.inScope, 16, (v) => str(v, 280)), outOfScope: arr(s.outOfScope, 16, (v) => str(v, 280)) };
  const areasToInspect = arr(b.areasToInspect, 16, (v) => {
    const x = rec(v);
    const item = { text: str(x.text, 280), origin: oneOf(x.origin, ["project_record", "reported"] as const), sourceIds: ids(x.sourceIds), reportedTurnIds: ids(x.reportedTurnIds) };
    supported(item.origin, item.sourceIds, item.reportedTurnIds);
    return item;
  });
  const constraints = arr(b.constraints, 24, (v) => {
    const x = rec(v);
    const item = { text: str(x.text, 280), origin: oneOf(x.origin, ALL_ORIGINS), sourceIds: ids(x.sourceIds), reportedTurnIds: ids(x.reportedTurnIds) };
    supported(item.origin, item.sourceIds, item.reportedTurnIds);
    return item;
  });
  const acceptanceCriteria = arr(b.acceptanceCriteria, 16, (v) => {
    const x = rec(v);
    const item = { text: str(x.text, 280), origin: oneOf(x.origin, ORIGINS), sourceIds: ids(x.sourceIds), reportedTurnIds: ids(x.reportedTurnIds) };
    supported(item.origin, item.sourceIds, item.reportedTurnIds);
    return item;
  });
  const verificationPlan = arr(b.verificationPlan, 16, (v) => {
    const x = rec(v);
    const command = nstr(x.command, 200);
    const commandBasis = x.commandBasis === null ? null : oneOf(x.commandBasis, ["project_record", "reported"] as const);
    if ((command === null) !== (commandBasis === null)) fail();
    return {
      step: str(x.step, 240),
      kind: oneOf(x.kind, ["test", "build", "lint", "review", "manual_check", "other"] as const),
      command,
      commandBasis,
      sourceIds: ids(x.sourceIds),
      reportedTurnIds: ids(x.reportedTurnIds),
    };
  });

  const rc = rec(b.repositoryContext);
  const repositoryContext: ExecutionBriefV1["repositoryContext"] =
    rc.status === "not_established"
      ? { status: "not_established", note: str(rc.note, 400) }
      : rc.status === "reported"
        ? {
            status: "reported",
            provider: nstr(rc.provider, 40),
            repository: nstr(rc.repository, 200),
            baseRef: nstr(rc.baseRef, 100),
            baseSha: rc.baseSha === null ? null : /^[0-9a-f]{7,40}$/.test(String(rc.baseSha)) ? String(rc.baseSha) : fail(),
            reportedTurnIds: (() => {
              const t2 = ids(rc.reportedTurnIds);
              return t2.length === 0 ? fail() : t2;
            })(),
          }
        : fail();

  const h = rec(b.handoff);
  if (h.mode !== "manual" || h.executionAuthorized !== false || h.delegationEligible !== false) fail();
  const handoff: ExecutionBriefV1["handoff"] = {
    mode: "manual",
    executionAuthorized: false,
    delegationEligible: false,
    gitPolicy: arr(h.gitPolicy, 32, (v) => str(v, 400)),
    forbiddenOperations: arr(h.forbiddenOperations, 32, (v) => str(v, 400)),
    stopConditions: arr(h.stopConditions, 32, (v) => str(v, 400)),
    finalReport: arr(h.finalReport, 32, (v) => str(v, 400)),
  };
  if (handoff.gitPolicy.length === 0 || handoff.forbiddenOperations.length === 0 || handoff.stopConditions.length === 0 || handoff.finalReport.length === 0) fail();

  const readiness = oneOf(b.readiness, ["handoff_ready", "needs_input"] as const);
  const p = rec(b.provenance);
  if (p.aiGenerated !== true) fail();
  const provenance: ExecutionBriefV1["provenance"] = {
    sources: arr(p.sources, 64, (v) => {
      const x = rec(v);
      return {
        evidenceId: id(x.evidenceId),
        sourceSystem: str(x.sourceSystem, 80) as ExecutionBriefV1["provenance"]["sources"][number]["sourceSystem"],
        title: str(x.title, 400),
        evidenceType: str(x.evidenceType, 80),
        recordedAt: str(x.recordedAt, 40),
        excerpt: null,
        author: null,
        authorityLevel: oneOf(x.authorityLevel, ["primary", "secondary", "unverified"] as const),
        isPrimary: bool(x.isPrimary),
        href: null,
        workspaceId: str(x.workspaceId, 80),
        projectId: str(x.projectId, 80),
        sourceContextDigest: /^sha256:[0-9a-f]{64}$/.test(String(x.sourceContextDigest)) ? String(x.sourceContextDigest) : fail(),
      };
    }),
    reports: arr(p.reports, 64, (v) => {
      const x = rec(v);
      if (x.reportedBy !== "user") fail();
      return { turnId: id(x.turnId), createdAt: str(x.createdAt, 40), reportedBy: "user" as const };
    }),
    citations: citations(p.citations),
    groundingAdjusted: bool(p.groundingAdjusted),
    aiGenerated: true,
  };

  // Every cited id is one the brief's own provenance lists.
  const sourceSet = new Set(provenance.sources.map((x) => x.evidenceId));
  const reportSet = new Set(provenance.reports.map((x) => x.turnId));
  const everyCited = [target, objective, whyNow, ...knownContext, ...areasToInspect, ...constraints, ...acceptanceCriteria, ...verificationPlan].filter(Boolean) as Array<{ sourceIds: string[]; reportedTurnIds?: string[] }>;
  for (const item of everyCited) {
    if (item.sourceIds.some((x) => !sourceSet.has(x))) fail();
    if ((item.reportedTurnIds ?? []).some((x) => !reportSet.has(x))) fail();
  }
  for (const item of reportedContext) if (item.reportedTurnIds.some((x) => !reportSet.has(x))) fail();
  if (repositoryContext.status === "reported" && repositoryContext.reportedTurnIds.some((x) => !reportSet.has(x))) fail();

  return {
    schema: EXECUTION_BRIEF_SCHEMA,
    version: EXECUTION_BRIEF_VERSION,
    identity,
    capability: "code",
    capabilityFit,
    targetRef,
    target,
    objective,
    whyNow,
    knownContext,
    reportedContext,
    assumptions,
    unknowns,
    scope,
    areasToInspect,
    constraints,
    acceptanceCriteria,
    verificationPlan,
    repositoryContext,
    handoff,
    readiness,
    provenance,
  };
}

/** A validated brief, rebuilt from known keys only — or null for anything else. Never throws. */
export function parseExecutionBriefV1(value: unknown): ExecutionBriefV1 | null {
  try {
    return build(value);
  } catch {
    return null;
  }
}
