// ─────────────────────────────────────────────────────────────────────────────
// Execution Brief — canonical assembly (PB-EXEC-01, §9.4, §9.7, §9.8). SERVER ONLY.
//
//   GroundedBrief (stable ids, narrative) + server-owned facts
//     → identity, capability, targetRef, policy constraints, repositoryContext,
//       handoff, readiness (computed — never the model's opinion), provenance
//     → sourceContextDigest per cited source, contextFingerprint, briefContentHash
//     → strict re-validation (validate.ts) and credential boundary 2 over EVERY
//       string (credential-guard.ts). Any failure throws: the caller degrades the
//       turn, and no partial brief is ever persisted.
// ─────────────────────────────────────────────────────────────────────────────

import { SOURCE_KIND_BY_FAMILY, type ProjectBrainContextSource } from "../conversation/context-types";
import { canonicalSet } from "./canonical-json";
import { scanBriefForCredentials } from "./credential-guard";
import type { GroundedBrief } from "./ground";
import { sha256Tag } from "./hash";
import { buildHandoff, POLICY_CONSTRAINTS } from "./policy";
import {
  EXECUTION_BRIEF_OPERATION,
  EXECUTION_BRIEF_SCHEMA,
  EXECUTION_BRIEF_SERIALIZER_VERSION,
  EXECUTION_BRIEF_VERSION,
  type BriefProvenanceSource,
  type BriefReadiness,
  type ExecutionBriefV1,
  type RepositoryContext,
  type ResolvedExecutionBriefTargetRef,
} from "./types";
import { parseExecutionBriefV1 } from "./validate";

export class ExecutionBriefAssemblyError extends Error {
  /** Categories and field paths only — never a matched value. */
  constructor(public readonly reason: "invalid_brief" | "credential_in_brief" | "guard_error", public readonly detail: string[] = []) {
    super(reason);
    this.name = "ExecutionBriefAssemblyError";
  }
}

/**
 * §9.8 — digest of EXACTLY what brief generation consumed for one source: the
 * post-budget label and content placed in <project_context>, its identity,
 * family/kind/trust, recordedAt, and the family's revision marker where one exists
 * (evidence_items { version, evidenceHash }). Never an alias, never model prose,
 * never the raw DB row.
 *
 *   * a family WITHOUT a revision marker changes digest only when the consumed
 *     representation changes;
 *   * a family WITH one may conservatively go stale even when the edit was outside
 *     the consumed excerpt (the marker moved) — the safe side.
 */
export function sourceContextDigest(source: ProjectBrainContextSource, serializerVersion: string = EXECUTION_BRIEF_SERIALIZER_VERSION): string {
  return sha256Tag({
    serializerVersion,
    evidenceId: source.reference.evidenceId,
    family: source.family,
    kind: SOURCE_KIND_BY_FAMILY[source.family],
    trust: source.trust,
    label: source.label,
    content: source.content,
    recordedAt: source.reference.recordedAt,
    revision: source.revisionMarker ?? null,
  });
}

/** §9.8 — stable inputs only: no alias, no model prose, no briefId, no generatedAt. */
export function computeContextFingerprint(input: {
  workspaceId: string;
  projectId: string;
  sources: Array<{ evidenceId: string; sourceContextDigest: string }>;
  reportedTurnIds: string[];
  targetRef: ResolvedExecutionBriefTargetRef;
  repositoryContext: RepositoryContext;
  serializerVersion?: string;
}): string {
  const target =
    input.targetRef.kind === "project_brain_recommendation"
      ? { kind: input.targetRef.kind, assistantTurnId: input.targetRef.assistantTurnId, statementId: input.targetRef.statementId }
      : { kind: input.targetRef.kind };
  const repo = input.repositoryContext.status === "reported"
    ? { provider: input.repositoryContext.provider, repository: input.repositoryContext.repository, baseRef: input.repositoryContext.baseRef, baseSha: input.repositoryContext.baseSha }
    : null;
  return sha256Tag({
    schema: EXECUTION_BRIEF_SCHEMA,
    version: EXECUTION_BRIEF_VERSION,
    serializerVersion: input.serializerVersion ?? EXECUTION_BRIEF_SERIALIZER_VERSION,
    workspaceId: input.workspaceId,
    projectId: input.projectId,
    sources: canonicalSet(input.sources.map((s) => ({ evidenceId: s.evidenceId, sourceContextDigest: s.sourceContextDigest }))),
    reportedTurnIds: [...new Set(input.reportedTurnIds)].sort(),
    target,
    repositoryContext: repo,
  });
}

/** §9.8 — everything except identity.briefContentHash itself. */
export function computeBriefContentHash(brief: ExecutionBriefV1): string {
  const { briefContentHash: _omit, ...identity } = brief.identity;
  void _omit;
  return sha256Tag({ ...brief, identity });
}

export const CONFIRM_OBJECTIVE_UNKNOWN = {
  fact: "Confirm the objective",
  why: "The objective is Project Brain's suggestion, not a project record or something you reported. Confirm it in chat and request a new brief.",
  resolveBy: "user" as const,
  blocking: true,
};

/** §9.7 — server-computed from the structured fields only. */
export function computeReadiness(brief: Pick<ExecutionBriefV1, "target" | "objective" | "acceptanceCriteria" | "capabilityFit" | "unknowns">): BriefReadiness {
  const targetGrounded = brief.target !== null && (brief.target.sourceIds.length > 0 || brief.target.reportedTurnIds.length > 0);
  const objectiveGrounded =
    brief.objective !== null &&
    ((brief.objective.origin === "project_record" && brief.objective.sourceIds.length > 0) || (brief.objective.origin === "reported" && brief.objective.reportedTurnIds.length > 0));
  const blocking = brief.unknowns.some((u) => u.blocking && u.resolveBy !== "repository_binding");
  return targetGrounded && objectiveGrounded && brief.acceptanceCriteria.length > 0 && brief.capabilityFit === "fits" && !blocking ? "handoff_ready" : "needs_input";
}

export type AssembleInput = {
  grounded: GroundedBrief;
  briefId: string;
  workspaceId: string;
  projectId: string;
  conversationId: string;
  requestTurnId: string;
  generatedAt: string;
  provider: string;
  model: string;
  targetRef: ResolvedExecutionBriefTargetRef;
  repositoryContext: RepositoryContext;
  /** Report map entries (turnId → createdAt) the repository context cites. */
  reportCreatedAt: ReadonlyMap<string, string>;
};

export function assembleExecutionBrief(
  input: AssembleInput,
  /** Boundary-2 scanner; injectable only so tests can prove a throwing guard fails closed. */
  options: { scanBrief?: typeof scanBriefForCredentials } = {},
): ExecutionBriefV1 {
  const g = input.grounded;
  const unknowns = [...g.unknowns];
  const addUnknown = (u: (typeof unknowns)[number]) => {
    if (!unknowns.some((x) => x.fact === u.fact)) unknowns.push(u);
  };
  if (g.objective?.origin === "suggested") addUnknown(CONFIRM_OBJECTIVE_UNKNOWN);
  if (g.capabilityFit === "not_code") {
    addUnknown({ fact: "Whether this work is software work", why: "It does not look like code work; PB-EXEC-01 prepares code briefs only. Describe the software change, or handle it outside a coding brief.", resolveBy: "user", blocking: true });
  } else if (g.capabilityFit === "unclear") {
    addUnknown({ fact: "Whether this work is software work", why: "Project Brain could not tell whether the target is a code change. Confirm it before handing it to a coding executor.", resolveBy: "user", blocking: true });
  }
  if (g.acceptanceCriteria.length === 0) {
    addUnknown({ fact: "How to tell the work is done", why: "No acceptance criterion could be kept. State what done means.", resolveBy: "user", blocking: true });
  }
  if (input.repositoryContext.status === "not_established") {
    addUnknown({ fact: "Which repository and base commit hold this code", why: "No repository is connected to this project; establish it locally and stop if it differs from this brief.", resolveBy: "repository_binding", blocking: false });
  }

  const sources: BriefProvenanceSource[] = g.sources.map((s) => ({
    ...s.reference,
    excerpt: null,
    author: null,
    href: null,
    workspaceId: s.reference.workspaceId ?? input.workspaceId,
    projectId: s.reference.projectId ?? input.projectId,
    sourceContextDigest: sourceContextDigest(s),
  }));

  const reports: ExecutionBriefV1["provenance"]["reports"] = g.reports.map((r) => ({ turnId: r.reference.turnId, createdAt: r.reference.createdAt, reportedBy: "user" as const }));
  if (input.repositoryContext.status === "reported") {
    for (const turnId of input.repositoryContext.reportedTurnIds) {
      if (!reports.some((r) => r.turnId === turnId)) reports.push({ turnId, createdAt: input.reportCreatedAt.get(turnId) ?? "", reportedBy: "user" });
    }
  }

  const constraints: ExecutionBriefV1["constraints"] = [
    ...g.constraints,
    ...POLICY_CONSTRAINTS.map((text) => ({ text, origin: "policy" as const, sourceIds: [], reportedTurnIds: [] })),
  ];

  const allReportedTurnIds = [
    ...(g.target?.reportedTurnIds ?? []),
    ...(g.objective?.reportedTurnIds ?? []),
    ...(g.whyNow?.reportedTurnIds ?? []),
    ...g.reportedContext.flatMap((x) => x.reportedTurnIds),
    ...g.areasToInspect.flatMap((x) => x.reportedTurnIds),
    ...g.constraints.flatMap((x) => x.reportedTurnIds),
    ...g.acceptanceCriteria.flatMap((x) => x.reportedTurnIds),
    ...g.verificationPlan.flatMap((x) => x.reportedTurnIds),
    ...(input.repositoryContext.status === "reported" ? input.repositoryContext.reportedTurnIds : []),
  ];

  const contextFingerprint = computeContextFingerprint({
    workspaceId: input.workspaceId,
    projectId: input.projectId,
    sources,
    reportedTurnIds: allReportedTurnIds,
    targetRef: input.targetRef,
    repositoryContext: input.repositoryContext,
  });

  const draft: ExecutionBriefV1 = {
    schema: EXECUTION_BRIEF_SCHEMA,
    version: EXECUTION_BRIEF_VERSION,
    identity: {
      briefId: input.briefId,
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      conversationId: input.conversationId,
      requestTurnId: input.requestTurnId,
      generatedAt: input.generatedAt,
      contextFingerprint,
      briefContentHash: "",
      generator: { mode: "generative", provider: input.provider, model: input.model, operation: EXECUTION_BRIEF_OPERATION },
    },
    capability: "code",
    capabilityFit: g.capabilityFit,
    targetRef: input.targetRef,
    target: g.target,
    objective: g.objective,
    whyNow: g.whyNow,
    knownContext: g.knownContext,
    reportedContext: g.reportedContext,
    assumptions: g.assumptions,
    unknowns,
    scope: g.scope,
    areasToInspect: g.areasToInspect,
    constraints,
    acceptanceCriteria: g.acceptanceCriteria,
    verificationPlan: g.verificationPlan,
    repositoryContext: input.repositoryContext,
    handoff: buildHandoff(),
    readiness: "needs_input",
    provenance: {
      sources,
      reports,
      citations: { ...g.citations },
      groundingAdjusted: g.groundingAdjusted,
      aiGenerated: true,
    },
  };
  draft.readiness = computeReadiness(draft);
  draft.identity.briefContentHash = computeBriefContentHash(draft);

  // Strict re-validation of what we are about to persist — not trusted because we built it.
  const validated = parseExecutionBriefV1(draft);
  if (!validated) throw new ExecutionBriefAssemblyError("invalid_brief");
  if (computeBriefContentHash(validated) !== validated.identity.briefContentHash) throw new ExecutionBriefAssemblyError("invalid_brief", ["briefContentHash"]);

  // Credential boundary 2: every string of the complete canonical brief. Model
  // narrative was already screened item by item (boundary 1), so a hit here means a
  // server-owned field or a source title carries one → the whole brief fails closed.
  let findings: ReturnType<typeof scanBriefForCredentials>;
  try {
    findings = (options.scanBrief ?? scanBriefForCredentials)(validated);
  } catch {
    throw new ExecutionBriefAssemblyError("guard_error");
  }
  if (findings.length > 0) throw new ExecutionBriefAssemblyError("credential_in_brief", findings.map((f) => `${f.path}:${f.category}`));
  return validated;
}
