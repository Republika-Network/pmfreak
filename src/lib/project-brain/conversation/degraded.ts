// ─────────────────────────────────────────────────────────────────────────────
// Project Brain conversation — degraded (limited) mode (PB-CHAT-01)
//
// Used when generative inference cannot produce a valid answer: provider not
// configured, timeout, circuit open, quota/cost ceiling, or output that failed
// validation — and when generative Project Brain is not included for this user
// (no provider call is made at all; see generative-access.ts). It is
// deterministic, it says so in its first sentence, and it only repeats what this
// turn's project-scoped context actually loaded:
//
//   * a family that loaded with records → the records are named (and cited);
//   * a family that loaded empty        → "none appear among the most recent
//                                          records" (the reads are windows);
//   * a family whose read failed        → "I couldn't check …", never "none".
//
// It never answers the question itself, never claims to be AI output, and never
// goes near the retired Command Center gateway.
// ─────────────────────────────────────────────────────────────────────────────

import type { ProjectBrainSourceReference } from "../types";
import type { ProjectBrainContext, ProjectBrainContextSource, ProjectBrainSourceFamily } from "./context-types";

export type DegradedReason =
  | "provider_unavailable"
  | "provider_error"
  | "timeout"
  | "rate_limited"
  | "usage_limit"
  | "invalid_output"
  /** Generative Project Brain is not included for this user; the provider was never called. */
  | "not_entitled";

export const DEGRADED_NOTICE =
  "Project Brain is temporarily operating in limited mode, so I can't compose a full answer to your question right now.";

/** Not temporary, so it must not say "temporarily" or invite a retry. */
export const NOT_ENTITLED_NOTICE =
  "Project Brain is in limited mode because full generative answers aren't included in your current plan, so I can't compose a full answer to your question.";

const SECTIONS: Array<{ families: ProjectBrainSourceFamily[]; heading: string; empty: string }> = [
  { families: ["RISK", "ISSUE"], heading: "Risks and issues on record", empty: "No open risks or issues appear among the most recent records." },
  { families: ["DECISION"], heading: "Recent decisions", empty: "No decisions appear among the most recent records." },
  { families: ["RECOMMENDATION"], heading: "Recommendations", empty: "No governed recommendations appear among the most recent records." },
  { families: ["TASK"], heading: "Tasks", empty: "No tasks appear among the most recent records." },
  { families: ["MILESTONE"], heading: "Milestones", empty: "No milestones are recorded." },
];

const MAX_ITEMS_PER_SECTION = 3;

export function buildDegradedReply(
  context: ProjectBrainContext,
  reason?: DegradedReason,
): { content: string; sources: ProjectBrainSourceReference[] } {
  const notEntitled = reason === "not_entitled";
  const lines: string[] = [notEntitled ? NOT_ENTITLED_NOTICE : DEGRADED_NOTICE, "", "Here is what this project's records show:"];
  const cited: ProjectBrainContextSource[] = [];

  const project = context.sources.find((s) => s.family === "PROJECT");
  if (project) {
    lines.push(`• ${project.content}`);
    cited.push(project);
  } else if (context.unavailable.includes("PROJECT")) {
    lines.push("• I couldn't load the project record.");
  }

  for (const section of SECTIONS) {
    if (section.families.some((family) => context.unavailable.includes(family))) {
      lines.push(`• ${section.heading}: I couldn't check these right now.`);
      continue;
    }
    const items = context.sources.filter((s) => section.families.includes(s.family)).slice(0, MAX_ITEMS_PER_SECTION);
    if (items.length === 0) {
      lines.push(`• ${section.empty}`);
      continue;
    }
    lines.push(`• ${section.heading}: ${items.map((s) => s.label.replace(/^[^—]+—\s*/, "")).join("; ")}.`);
    cited.push(...items);
  }

  if (!notEntitled) lines.push("", "Please try your question again shortly for a full answer.");
  return { content: lines.join("\n"), sources: cited.map((s) => s.reference) };
}
