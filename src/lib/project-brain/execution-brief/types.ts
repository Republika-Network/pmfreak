// ─────────────────────────────────────────────────────────────────────────────
// Project Brain — Execution Brief v1 (PB-EXEC-01)
//
// The canonical, executor-neutral contract of docs/project-brain-execution.md §9.4.
//
//   Execution Brief ≠ authorization to execute      Execution Brief ≠ Agent Proposal
//   Brief ≠ Project State ≠ Memory ≠ Decision ≠ Action ≠ Outcome
//
// Pure types and constants only — safe in the browser bundle. The model never
// writes this shape: it fills the transient narrative schema in schema.ts, and the
// server assembles this (assemble.ts). Server-owned: identity, capability,
// targetRef, repositoryContext, handoff, readiness, provenance.
// ─────────────────────────────────────────────────────────────────────────────

import type { ProjectBrainSourceReference } from "../types";

export const EXECUTION_BRIEF_SCHEMA = "pmfreak.execution-brief" as const;
export const EXECUTION_BRIEF_VERSION = 1 as const;
/** Cost attribution / provider idempotency: never `project_brain.turn`. */
export const EXECUTION_BRIEF_OPERATION = "project_brain.execution_brief" as const;
/**
 * Version of the source-context representation hashed into `sourceContextDigest`
 * (§9.8). Bump it whenever what is hashed — or how — changes; a different version
 * makes every earlier fingerprint stale, which is the safe side.
 */
export const EXECUTION_BRIEF_SERIALIZER_VERSION = "execution-brief-context-v1" as const;

// ─── Request-side vocabulary (§9.2, §13) ─────────────────────────────────────

/** Execution-selection metadata: WHICH work a brief is about. Grants nothing. */
export type ExecutionBriefTargetRef =
  | { kind: "project_brain_recommendation"; assistantTurnId: string; statementId: string }
  | { kind: "current_user_request" };

/** How the target was actually selected — recorded in the brief, not in the turn identity. */
export type ResolvedExecutionBriefTargetRef =
  | { kind: "project_brain_recommendation"; assistantTurnId: string; statementId: string; resolvedBy: "explicit" | "single_candidate" }
  | { kind: "current_user_request" };

export type ProjectBrainOperation = "answer" | "execution_brief";

/**
 * Turn operation identity (§13), persisted on the user row as
 * `metadata.projectBrainRequest`. `targetRef` is the REQUESTED one (null when the
 * phrase matcher supplied none). A row without it is `{ answer, null }`.
 */
export type ProjectBrainRequestIdentity = { operation: ProjectBrainOperation; targetRef: ExecutionBriefTargetRef | null };

export const ANSWER_REQUEST_IDENTITY: ProjectBrainRequestIdentity = Object.freeze({ operation: "answer", targetRef: null }) as ProjectBrainRequestIdentity;

/** A candidate for deterministic target selection (§9.2.1). Built from persisted statements only. */
export type ExecutionBriefTargetCandidate = { assistantTurnId: string; statementId: string; text: string };

// ─── Canonical brief (§9.4) ──────────────────────────────────────────────────

export type BriefOrigin = "project_record" | "reported" | "policy" | "suggested";
export type ExecutionCapability = "code";
export type CapabilityFit = "fits" | "not_code" | "unclear";
export type BriefReadiness = "handoff_ready" | "needs_input";
export type UnknownResolveBy = "user" | "project_record" | "repository_binding";
export type VerificationKind = "test" | "build" | "lint" | "review" | "manual_check" | "other";
export type CommandBasis = "project_record" | "reported";

export type BriefCitationReport = {
  rejectedCitations: number;
  rejectedReports: number;
  /** Items removed whole because they named an execution-shaped reference nothing supplied. */
  unsupportedReferences: number;
  /** Items removed whole because they carried credential-like content. Categories only, never values. */
  credentialFindings: number;
  /** Items dropped for exceeding a count or length bound, or for being empty. */
  droppedItems: number;
  /** Items whose claimed origin lost its support and were demoted or moved. */
  demotedItems: number;
  /** Supplied commands removed because they would change shared state. */
  blockedCommands: number;
};

export type BriefProvenanceSource = ProjectBrainSourceReference & { sourceContextDigest: string };

export type RepositoryContext =
  | { status: "not_established"; note: string }
  | {
      status: "reported";
      provider: string | null;
      repository: string | null;
      baseRef: string | null;
      baseSha: string | null;
      reportedTurnIds: string[];
    };

export type ExecutionBriefV1 = {
  schema: typeof EXECUTION_BRIEF_SCHEMA;
  version: typeof EXECUTION_BRIEF_VERSION;
  identity: {
    briefId: string;
    workspaceId: string;
    projectId: string;
    conversationId: string;
    requestTurnId: string;
    generatedAt: string;
    contextFingerprint: string;
    briefContentHash: string;
    generator: { mode: "generative"; provider: string; model: string; operation: typeof EXECUTION_BRIEF_OPERATION };
  };
  capability: ExecutionCapability;
  capabilityFit: CapabilityFit;
  targetRef: ResolvedExecutionBriefTargetRef;
  /** null when grounding removed it (the brief is then needs_input). */
  target: { title: string; statement: string; sourceIds: string[]; reportedTurnIds: string[] } | null;
  /** null when grounding removed it (the brief is then needs_input). */
  objective: { text: string; origin: Exclude<BriefOrigin, "policy">; sourceIds: string[]; reportedTurnIds: string[] } | null;
  whyNow: { text: string; sourceIds: string[]; reportedTurnIds: string[] } | null;
  knownContext: Array<{ text: string; sourceIds: string[] }>;
  reportedContext: Array<{ text: string; reportedTurnIds: string[]; executionSensitive: boolean }>;
  assumptions: Array<{ text: string }>;
  unknowns: Array<{ fact: string; why: string; resolveBy: UnknownResolveBy; blocking: boolean }>;
  scope: { inScope: string[]; outOfScope: string[] };
  areasToInspect: Array<{ text: string; origin: "project_record" | "reported"; sourceIds: string[]; reportedTurnIds: string[] }>;
  constraints: Array<{ text: string; origin: BriefOrigin; sourceIds: string[]; reportedTurnIds: string[] }>;
  acceptanceCriteria: Array<{ text: string; origin: Exclude<BriefOrigin, "policy">; sourceIds: string[]; reportedTurnIds: string[] }>;
  verificationPlan: Array<{
    step: string;
    kind: VerificationKind;
    command: string | null;
    commandBasis: CommandBasis | null;
    sourceIds: string[];
    reportedTurnIds: string[];
  }>;
  repositoryContext: RepositoryContext;
  handoff: {
    mode: "manual";
    executionAuthorized: false;
    delegationEligible: false;
    gitPolicy: string[];
    forbiddenOperations: string[];
    stopConditions: string[];
    finalReport: string[];
  };
  readiness: BriefReadiness;
  provenance: {
    sources: BriefProvenanceSource[];
    reports: Array<{ turnId: string; createdAt: string; reportedBy: "user" }>;
    citations: BriefCitationReport;
    groundingAdjusted: boolean;
    aiGenerated: true;
  };
};

// ─── Renderers (client-side choice only — never in a request, brief or hash) ─

export const EXECUTION_BRIEF_RENDERERS = ["generic", "claude_code", "codex"] as const;
export type ExecutionBriefRenderer = (typeof EXECUTION_BRIEF_RENDERERS)[number];
export const RENDERER_LABEL: Readonly<Record<ExecutionBriefRenderer, string>> = {
  generic: "Generic",
  claude_code: "Claude Code",
  codex: "Codex",
};
