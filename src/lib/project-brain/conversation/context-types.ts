// ─────────────────────────────────────────────────────────────────────────────
// Project Brain conversation — context vocabulary (PB-CHAT-01)
// ─────────────────────────────────────────────────────────────────────────────

import type { ProjectBrainReportReference, ProjectBrainSourceReference, ProjectContextScope } from "../types";

/**
 * What kind of project record a context source is. The model sees this as the
 * `type` attribute of each source; the UI uses it to label source chips.
 * CONVERSATION is deliberately absent: prior turns are supplied as history, are
 * never citable, and are never treated as project fact.
 */
export const PROJECT_BRAIN_SOURCE_FAMILIES = [
  "PROJECT",
  "ONBOARDING",
  "EVIDENCE",
  "SIGNAL",
  "RISK",
  "ISSUE",
  "RECOMMENDATION",
  "DECISION",
  "ACTION",
  "TASK",
  "OUTCOME",
  "MILESTONE",
  "RAID_DISCOVERY",
] as const;

export type ProjectBrainSourceFamily = (typeof PROJECT_BRAIN_SOURCE_FAMILIES)[number];

/**
 * How far a source may be trusted, stated to the model and mapped onto the
 * existing `SourceAuthorityLevel`:
 *   RECORD         a canonical persisted record, authoritative about itself → primary
 *   SELF_REPORTED  typed by a person into project setup, not verified        → secondary
 *   DERIVED        produced by PMFreak's deterministic detectors             → secondary
 *   UNVERIFIED     discovery/legacy suggestion data or sample data          → unverified
 */
export type ProjectBrainTrust = "RECORD" | "SELF_REPORTED" | "DERIVED" | "UNVERIFIED";

/**
 * What a source says about time (PB-REASON-01), stated to the model as the `kind`
 * attribute so an old plan cannot pass for the project's current position:
 *   plan        setup answers — intentions, target dates, contractual milestones and
 *               declarations typed when the project was created
 *   state       records of what exists or happened — project, milestone and task
 *               status, decisions, outcomes, evidence
 *   assessment  judgements about the project — risks, issues, detector signals,
 *               recommendations, proposed actions, discovery items
 * Derived from the family alone (server-side, deterministic); never from content.
 */
export type ProjectBrainSourceKind = "plan" | "state" | "assessment";

export const SOURCE_KIND_BY_FAMILY: Readonly<Record<ProjectBrainSourceFamily, ProjectBrainSourceKind>> = {
  PROJECT: "state",
  ONBOARDING: "plan",
  EVIDENCE: "state",
  SIGNAL: "assessment",
  RISK: "assessment",
  ISSUE: "assessment",
  RECOMMENDATION: "assessment",
  DECISION: "state",
  ACTION: "assessment",
  TASK: "state",
  OUTCOME: "state",
  MILESTONE: "state",
  RAID_DISCOVERY: "assessment",
};

export type ProjectBrainContextSource = {
  /** Short per-turn citation handle ("S1"). The model cites these and nothing else. */
  alias: string;
  family: ProjectBrainSourceFamily;
  trust: ProjectBrainTrust;
  /** Human label, built by the server from the record — never by the model. */
  label: string;
  /** Bounded plain-text content. */
  content: string;
  reference: ProjectBrainSourceReference;
};

export type ProjectBrainHistoryMessage = {
  role: "user" | "assistant";
  content: string;
  createdAt: string;
  /** context_messages.id — set by the turn service; absent in older/synthetic history. */
  id?: string;
  /**
   * PB-REASON-02, user turns only: who wrote it relative to the requesting user.
   * Set by the turn service from `created_by_user_id`; a user row without an
   * authenticated author (or any assistant row) has none and can never be a report.
   */
  author?: "you" | "another project member";
};

/**
 * PB-REASON-02 — a human user turn the model may use as REPORTED working context.
 * NOT a source: it has its own alias namespace (R1, R2, …, never S*), it is never a
 * `ProjectBrainSourceReference`, and it is built only from authenticated USER turns
 * of THIS conversation inside the bounded history window, plus the current turn.
 * Its content is not repeated to the model: the alias is an attribute on the turn.
 */
export type ProjectBrainContextReport = {
  /** Per-turn report handle ("R1"). */
  alias: string;
  author: "you" | "another project member";
  /** True for the message being answered right now. */
  current: boolean;
  reference: ProjectBrainReportReference;
};

export type ProjectBrainContext = {
  scope: ProjectContextScope;
  projectName: string;
  sources: ProjectBrainContextSource[];
  /** Families whose read failed — the model must say it could not load them. */
  unavailable: ProjectBrainSourceFamily[];
  /** True when any family or the total budget dropped records. */
  truncated: boolean;
  history: ProjectBrainHistoryMessage[];
  /**
   * PB-REASON-02: the report map for THIS turn (see reported-context.ts). Absent
   * means no conversational report can support any claim.
   */
  reports?: ProjectBrainContextReport[];
};
