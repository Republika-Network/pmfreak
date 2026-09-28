// ─────────────────────────────────────────────────────────────────────────────
// Project Brain conversation — reported working context (PB-REASON-02)
//
//   Conversation ≠ Source      Reported ≠ Fact      Reported ≠ Evidence
//   …but what the human just told Project Brain is still useful.
//
// Builds the per-turn REPORT map: every authenticated USER turn in the already
// bounded history window, plus the message being answered now, gets an alias
// (R1, R2, …) the model may cite in `reportIds`. Output grounding resolves those
// ids ONLY against this map, exactly as source ids resolve only against S*.
//
//   * assistant turns are never reports — a past hallucination cannot vouch for
//     itself on the next turn;
//   * a user row with no authenticated author is never a report;
//   * nothing outside the bounded window (MAX_HISTORY_MESSAGES) becomes a report,
//     so "truth by chat" expires with the window;
//   * the map is built from THIS conversation's rows only (the store is scoped to
//     the project's thread), so a report cannot cross a project or a workspace.
//
// Pure and deterministic; no I/O, no model call, no write.
// ─────────────────────────────────────────────────────────────────────────────

import type { ProjectBrainContext, ProjectBrainContextReport } from "./context-types";

export type CurrentUserTurn = { id: string; createdAt: string };

export function buildReportedContext(context: ProjectBrainContext, current: CurrentUserTurn): ProjectBrainContext {
  const reports: ProjectBrainContextReport[] = [];
  const add = (turnId: string, createdAt: string, author: ProjectBrainContextReport["author"], isCurrent: boolean) => {
    reports.push({ alias: `R${reports.length + 1}`, author, current: isCurrent, reference: { turnId, createdAt, reportedBy: "user" } });
  };
  for (const message of context.history) {
    if (message.role === "user" && message.id && message.author && message.id !== current.id) {
      add(message.id, message.createdAt, message.author, false);
    }
  }
  // The current turn is always the requesting user's own authenticated message.
  add(current.id, current.createdAt, "you", true);
  return { ...context, reports };
}

/** Report alias for a history turn / the current turn, or null when it is not a report. */
export function reportAliasFor(context: ProjectBrainContext, turnId: string | undefined): ProjectBrainContextReport | null {
  if (!turnId) return null;
  return context.reports?.find((r) => r.reference.turnId === turnId) ?? null;
}
