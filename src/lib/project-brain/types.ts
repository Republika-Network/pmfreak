// ─────────────────────────────────────────────────────────────────────────────
// Project Brain — Type Definitions
// Sprint 0: Birth of the Project Brain
//
// This module defines the epistemic model, provenance model, and structured
// response contract every future Project Brain capability (Listener,
// Historian, Detective, Skeptic, Investigator, PM, Advisor, Strategist,
// Executive) must speak through instead of inventing its own shape.
//
// It does not duplicate evidence storage. `ProjectBrainSourceReference` is an
// adapter shape over the two existing evidence pipelines:
//   - `project_evidence` / `project_evidence_content` (raw upload + extraction)
//   - `evidence_items` (governed operational evidence, `src/lib/operational-flow`)
// See `source-reference.ts` for the adapters that build one from a DB row.
// ─────────────────────────────────────────────────────────────────────────────

// ─── Epistemic classification ──────────────────────────────────────────────

export const EPISTEMIC_TYPES = [
  "FACT",
  "REPORTED",
  "INFERENCE",
  "ASSUMPTION",
  "OPEN_QUESTION",
  "CONTRADICTION",
  "RECOMMENDATION",
  "UNKNOWN",
] as const;

export type EpistemicType = (typeof EPISTEMIC_TYPES)[number];

// ─── Provenance / source attribution ───────────────────────────────────────

export type SourceAuthorityLevel = "primary" | "secondary" | "unverified";

/**
 * Reusable source-reference model. Every field maps back to columns that
 * already exist on `project_evidence` or `evidence_items` — this type never
 * stores evidence content itself, only a pointer to it plus the metadata a
 * Project Brain statement needs to cite it honestly.
 */
/**
 * The persisted table a source reference points into. The first three are the
 * Sprint 0 pipelines; the rest were added by PB-CHAT-01 so a conversational
 * answer can cite the canonical operational records it was grounded in. Each
 * value is the literal table name — no parallel vocabulary.
 */
export type ProjectBrainSourceSystem =
  | "project_evidence"
  | "evidence_items"
  | "project_configuration"
  | "projects"
  | "operational_signals"
  | "risk_issue_records"
  | "recommended_actions"
  | "operational_decision_records"
  | "material_action_proposals"
  | "execution_tasks"
  | "canonical_task_outcomes"
  | "canonical_outcome_observations"
  | "project_milestones"
  | "raid_items";

export type ProjectBrainSourceReference = {
  evidenceId: string;
  sourceSystem: ProjectBrainSourceSystem;
  title: string;
  evidenceType: string;
  recordedAt: string;
  excerpt?: string | null;
  author?: string | null;
  authorityLevel: SourceAuthorityLevel;
  isPrimary: boolean;
  href?: string | null;
  workspaceId?: string;
  projectId?: string;
};

// ─── Uncertainty model ──────────────────────────────────────────────────────

export type QualitativeConfidenceLevel = "high" | "medium" | "low" | "unknown";

/**
 * Confidence is always qualitative language first. A numeric score is only
 * ever allowed alongside the documented method that produced it — never a
 * bare percentage — matching `evidence_items.confidence_level` /
 * `operational_signals.confidence_score` + `detected_by` conventions already
 * shipped in `operational-flow`.
 */
export type ProjectBrainConfidence =
  | { kind: "qualitative"; level: QualitativeConfidenceLevel }
  | {
      kind: "scored";
      level: QualitativeConfidenceLevel;
      score: number;
      method: string;
      scoredBy: string;
    };

// ─── Project-context boundary ──────────────────────────────────────────────

/** Every statement and source is anchored to exactly one workspace/project — never blended across projects. */
export type ProjectContextScope = {
  workspaceId: string;
  projectId: string;
};

// ─── Structured response contract ──────────────────────────────────────────

export type ContradictingClaim = {
  sourceEvidenceId: string;
  claim: string;
};

export type ProjectBrainStatement = {
  id: string;
  scope: ProjectContextScope;
  epistemicType: EpistemicType;
  /** The statement text, written in the Project Brain voice (see constitution.ts). */
  text: string;
  confidence: ProjectBrainConfidence;
  sources: ProjectBrainSourceReference[];
  /** REPORTED only: who reported it, when the reporter is known. */
  reportedBy?: string | null;
  /** INFERENCE only: the reasoning that connects the sources to the conclusion. */
  inferenceBasis?: string | null;
  /** CONTRADICTION only: the conflicting claims, each traceable to a source in `sources`. */
  contradictingClaims?: ContradictingClaim[];
  /** RECOMMENDATION only: always true — a Recommendation is never auto-applied. */
  requiresHumanApproval?: boolean;
  generatedAt: string;
  constitutionVersion: string;
};

export type KnowledgeGapPriority = "critical" | "high" | "medium" | "low";

export type ProjectBrainKnowledgeGap = {
  id: string;
  scope: ProjectContextScope;
  /** UNKNOWN when nothing points toward an answer; OPEN_QUESTION when the question itself is identified but unresolved. */
  epistemicStatus: Extract<EpistemicType, "UNKNOWN" | "OPEN_QUESTION">;
  /** Short label, e.g. "Approved delivery timeline". */
  title: string;
  /** First-person, e.g. "I have not identified an approved delivery timeline." — see constitution.ts KNOWLEDGE_GAP_VOICE. */
  question: string;
  /** Why it matters — never omitted; an unexplained gap reads as arbitrary. */
  reason: string;
  priority: KnowledgeGapPriority;
  suggestedEvidenceTypes: string[];
  /** Source references (evidenceId) this gap was derived from, e.g. an onboarding field that was left empty. Empty when the gap is a generic starting recommendation. */
  sourceIds: string[];
  identifiedAt: string;
};

export type ProjectBrainResponse = {
  scope: ProjectContextScope;
  generatedAt: string;
  constitutionVersion: string;
  statements: ProjectBrainStatement[];
  knowledgeGaps: ProjectBrainKnowledgeGap[];
};
