// ─────────────────────────────────────────────────────────────────────────────
// PB-PRESENT-01 — what a Project Brain answer shows before it is opened.
//
// A pure derivation from the already-validated transcript view model. It decides
// PRESENTATION only: whether an answer has details to disclose, how the collapsed
// row summarises them, and which material cautions must stay visible while the
// details are closed. It holds no business truth — it never re-types, re-counts or
// re-validates a claim, and it never mutates the message it reads.
//
// Priority of what the collapsed row surfaces (most salient first):
//   record conflict → claims that need review → reported chat context → routine sources.
// ─────────────────────────────────────────────────────────────────────────────

import type { ProjectBrainMessageView } from "@/lib/project-brain/conversation/transcript-view";

export type AnswerCaution = "conflict" | "review";

export type AnswerDisclosure = {
  /** There is at least one structured claim or cited record to disclose. */
  hasDetails: boolean;
  claimCount: number;
  /** Unique cited project records — the view model's own deduplicated list. */
  sourceCount: number;
  /** Claims resting on something said in this conversation (PB-REASON-02). */
  reportedClaimCount: number;
  /** Distinct conversation turns those claims rest on. */
  reportTurnCount: number;
  /** Material cautions, most salient first. Visible while the details are closed. */
  cautions: AnswerCaution[];
  /** Routine, count-only parts of the collapsed row ("3 records", …). */
  counts: string[];
  /** Customer wording for the reported-context dependency, or null when none. */
  reportedNote: string | null;
  tone: "normal" | "caution";
};

export const ANSWER_DETAILS_LABEL = "Sources & verification";

export const CAUTION_LABEL: Record<AnswerCaution, string> = {
  conflict: "Project records conflict",
  review: "Some claims need review",
};

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

export function deriveAnswerDisclosure(brain: ProjectBrainMessageView["brain"]): AnswerDisclosure {
  const statements = brain?.statements ?? [];
  const sources = brain?.sources ?? [];
  const reported = statements.filter((s) => s.reportedTurnIds.length > 0);
  const reportTurnCount = new Set(reported.flatMap((s) => s.reportedTurnIds)).size;

  const cautions: AnswerCaution[] = [];
  if (statements.some((s) => s.epistemicType === "CONTRADICTION")) cautions.push("conflict");
  if (brain?.groundingAdjusted) cautions.push("review");

  const counts: string[] = [];
  if (sources.length > 0) counts.push(plural(sources.length, "record", "records"));
  // With no record cited, the claims themselves are what the details hold.
  else if (statements.length > 0) counts.push(plural(statements.length, "claim", "claims"));

  return {
    hasDetails: statements.length > 0 || sources.length > 0,
    claimCount: statements.length,
    sourceCount: sources.length,
    reportedClaimCount: reported.length,
    reportTurnCount,
    cautions,
    counts,
    reportedNote: reportTurnCount > 0 ? `uses ${plural(reportTurnCount, "reported chat update", "reported chat updates")} · not verified` : null,
    tone: cautions.length > 0 ? "caution" : "normal",
  };
}
