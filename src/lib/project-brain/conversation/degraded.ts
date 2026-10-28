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
// PD-24: discovery RAID (setup / intake / upload findings, the only risks most
// projects have) is its own section, so the reply never says "no open risks" while
// those exist; governed and discovery items are never merged. Uploaded-document
// excerpts that matched the question are quoted verbatim as unverified text.
//
// It never answers the question itself, never claims to be AI output, and never
// goes near the retired Command Center gateway.
// ─────────────────────────────────────────────────────────────────────────────

import type { ProjectBrainSourceReference } from "../types";
import { SUPPLEMENTAL_READ_LIMIT } from "./context-budget";
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
  { families: ["RISK", "ISSUE"], heading: "Risks and issues on record", empty: "No governed risks or issues appear in the loaded records; this is not a complete risk assessment." },
  { families: ["RAID_DISCOVERY"], heading: "Discovery RAID (unverified)", empty: "No open discovery RAID items appear in the loaded records." },
  { families: ["DECISION"], heading: "Recent decisions", empty: "No decisions appear among the most recent records." },
  { families: ["RECOMMENDATION"], heading: "Recommendations", empty: "No recommendations appear among the loaded records." },
  { families: ["TASK"], heading: "Tasks", empty: "No tasks appear among the most recent records." },
  { families: ["MILESTONE"], heading: "Milestones", empty: "No milestones are recorded." },
];

const MAX_ITEMS_PER_SECTION = 3;
const MAX_DOCUMENT_EXCERPTS = 3;

const itemText = (s: ProjectBrainContextSource) =>
  `${s.label.replace(/^[^—]+—\s*/, "")}${s.trust === "DERIVED" ? " (derived suggestion)" : ""}`;

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
    const partial = section.families.some((family) => context.unavailable.includes(family));
    const loaded = context.sources.filter((s) => section.families.includes(s.family));
    if (loaded.length === 0) {
      const discoveryFollows = section.families.includes("RISK") && context.sources.some((s) => s.family === "RAID_DISCOVERY");
      const empty = discoveryFollows ? "No governed risks or issues are recorded yet; the open discovery RAID items below have not been reviewed." : section.empty;
      lines.push(`• ${partial ? `${section.heading}: I couldn't check these right now.` : empty}`);
      continue;
    }
    const items = loaded.slice(0, MAX_ITEMS_PER_SECTION);
    // The real number loaded (before the context budget), never just the number that fit.
    const counts = section.families.map((family) => context.loadedCounts?.[family]);
    const total = counts.every((n) => typeof n === "number") ? Math.max(loaded.length, counts.reduce((a, n) => a + (n ?? 0), 0)) : loaded.length;
    const atReadLimit = section.families.includes("RAID_DISCOVERY") && total >= SUPPLEMENTAL_READ_LIMIT;
    const more = total - items.length;
    lines.push(`• ${section.heading}: ${items.map(itemText).join("; ")}${more > 0 ? `; and ${atReadLimit ? "at least " : ""}${more} more` : ""}.${partial ? " Some of these records couldn't be checked right now." : ""}`);
    cited.push(...items);
  }

  if (context.unavailable.includes("DOCUMENT")) {
    lines.push("• Uploaded documents: I couldn't check these right now.");
  } else {
    const documents = context.sources.filter((s) => s.family === "DOCUMENT").slice(0, MAX_DOCUMENT_EXCERPTS);
    if (documents.length > 0) {
      lines.push("• From uploaded documents (unverified excerpts matching your question, quoted as written):");
      for (const document of documents) {
        lines.push(`  – ${document.reference.title}: ${JSON.stringify(document.content)}`);
        cited.push(document);
      }
    }
  }
  if (context.truncated) lines.push("• This summary covers a bounded selection of records; other records may exist.");

  if (!notEntitled) lines.push("", "Please try your question again shortly for a full answer.");
  return { content: lines.join("\n"), sources: cited.map((s) => s.reference) };
}
