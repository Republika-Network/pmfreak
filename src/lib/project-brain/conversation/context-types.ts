// ─────────────────────────────────────────────────────────────────────────────
// Project Brain conversation — context vocabulary (PB-CHAT-01)
// ─────────────────────────────────────────────────────────────────────────────

import type { ProjectBrainSourceReference, ProjectContextScope } from "../types";

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
};
