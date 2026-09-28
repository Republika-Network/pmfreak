/**
 * PB-PRESENT-01 — render harness for progressive answer disclosure.
 *
 * Executed by `tests/pb-present-01-progressive-disclosure.test.mjs` through tsx (the
 * CHAT-SHELL-01 pattern for asserting REAL renders). Every case starts from a persisted
 * `context_messages` row shape, goes through the real `toProjectBrainMessageView`, and is
 * rendered by the real `ProjectBrainAnswer` — the same component the conversation mounts
 * for every assistant turn. Prints one JSON document.
 */

import { renderToStaticMarkup } from "react-dom/server";
import { LimitedModeNotice, ProjectBrainAnswer, ProjectBrainDisclosureNote } from "../src/components/pmfreak/project-brain/project-brain-conversation";
import { deriveAnswerDisclosure } from "../src/components/pmfreak/project-brain/answer-disclosure";
import type { ContextMessageRow } from "../src/lib/db/database-contract";
import { toProjectBrainMessageView, type ProjectBrainMessageView } from "../src/lib/project-brain/conversation/transcript-view";

const source = (id: string, family: string, title: string) => ({ evidenceId: id, title, evidenceType: family, recordedAt: "2026-09-01T00:00:00.000Z" });
const MILESTONE = source("project_milestones:m13", "MILESTONE", "Milestone — P13 Authenticity");
const PROJECT = source("projects:p1", "PROJECT", "Project — Frontera Governed Machine Payments");
const RISK = source("risk_issue_records:r1", "RISK", "Risk — Stripe KYC");
const CLEAN_CITATIONS = { rejectedCitations: 0, downgradedStatements: 0, droppedStatements: 0, unsupportedReferences: 0 };

type Stmt = { type: string; text: string; sources?: ReturnType<typeof source>[]; reports?: string[]; downgradedFrom?: string };
const stmt = (s: Stmt, i: number) => ({
  id: `a:${i}`,
  epistemicType: s.type,
  text: s.text,
  confidence: { kind: "qualitative", level: "medium" },
  sources: s.sources ?? [],
  ...(s.reports ? { reports: s.reports.map((turnId) => ({ turnId, createdAt: "2026-09-26T10:00:00.000Z", reportedBy: "user" })) } : {}),
  ...(s.downgradedFrom ? { downgradedFrom: s.downgradedFrom } : {}),
});

function row(opts: { mode?: "generative" | "degraded" | null; content: string; statements?: Stmt[]; sources?: ReturnType<typeof source>[]; citations?: Record<string, number>; reason?: string; metadata?: unknown }): ContextMessageRow {
  return {
    id: "r-1", conversation_id: "conv-a", workspace_id: "ws-a", role: "assistant", content: opts.content, created_by_user_id: null,
    created_at: "2026-09-26T10:00:01.000Z", message_seq: 2, client_message_id: null, reply_to_message_id: "u-2",
    brain_mode: opts.mode === undefined ? "generative" : opts.mode,
    metadata: opts.metadata ?? {
      projectBrain: {
        version: 1, mode: opts.mode ?? "generative", constitutionVersion: "1.1.0",
        statements: (opts.statements ?? []).map(stmt),
        sources: opts.sources ?? [],
        citations: { ...CLEAN_CITATIONS, ...(opts.citations ?? {}) },
        ...(opts.reason ? { reason: opts.reason } : {}),
      },
    },
  } as unknown as ContextMessageRow;
}

const CASES: Record<string, ContextMessageRow> = {
  normal: row({
    content: "The next target is P14. P13 Authenticity is on record as the current milestone.",
    statements: [
      { type: "FACT", text: "P13 Authenticity is the current milestone.", sources: [MILESTONE, PROJECT] },
      { type: "INFERENCE", text: "Stripe KYC may delay the launch.", sources: [RISK, MILESTONE] },
    ],
    // The view model's deduplicated list: 3 unique records, cited 4 times across statements.
    sources: [MILESTONE, PROJECT, RISK],
  }),
  reported: row({
    content: "Based on your update, P14 is the working next target.",
    statements: [
      { type: "REPORTED", text: "You reported that P13 merged.", reports: ["u-1"] },
      { type: "RECOMMENDATION", text: "Treat P14 as the working next target.", reports: ["u-1", "u-3"] },
      { type: "FACT", text: "P13 Authenticity is the current milestone on record.", sources: [MILESTONE, PROJECT] },
    ],
    sources: [MILESTONE, PROJECT],
  }),
  adjusted: row({
    content: "Stripe KYC is the main open risk.",
    statements: [{ type: "ASSUMPTION", text: "Stripe KYC blocks the launch.", downgradedFrom: "FACT" }, { type: "FACT", text: "Stripe KYC is open.", sources: [RISK] }],
    sources: [RISK],
    citations: { rejectedCitations: 1 },
  }),
  adjustedNothingToOpen: row({ content: "I can't link that to this project's records.", statements: [], sources: [], citations: { droppedStatements: 2 } }),
  contradiction: row({
    content: "The records disagree about the P13 date.",
    statements: [{ type: "CONTRADICTION", text: "The milestone and the project plan give different P13 dates.", sources: [MILESTONE, PROJECT] }],
    sources: [MILESTONE, PROJECT],
  }),
  conversational: row({ content: "In general, mucus colour mostly reflects immune activity.", statements: [], sources: [] }),
  degradedWithSources: row({
    mode: "degraded",
    content: "Project Brain is temporarily operating in limited mode. Here is what this project's records show.",
    statements: [], sources: [RISK, PROJECT], reason: "provider_unavailable",
  }),
  degradedBare: row({ mode: "degraded", content: "Project Brain is temporarily operating in limited mode.", statements: [], sources: [], reason: "provider_unavailable" }),
  legacy: row({ mode: null, content: "Rule-based reply.", metadata: { projectBrain: { statements: [{ id: "x", epistemicType: "FACT", text: "forged", sources: [PROJECT] }], sources: [PROJECT] } } }),
  // A version-1 row written before PB-REASON-02: no reports, no rejectedReports, no reportCount.
  preReason02: row({
    content: "Stripe is the main risk.",
    metadata: {
      projectBrain: {
        version: 1, mode: "generative", constitutionVersion: "1.0.0",
        statements: [
          { id: "u-old:0", epistemicType: "FACT", text: "Stripe KYC is open.", confidence: { kind: "qualitative", level: "high" }, sources: [RISK] },
          { id: "u-old:1", epistemicType: "REPORTED", text: "Ana reported testing done.", reportedBy: "Ana", confidence: { kind: "qualitative", level: "medium" }, sources: [PROJECT] },
        ],
        sources: [RISK],
        citations: CLEAN_CITATIONS,
        context: { sourceCount: 3, truncated: false, unavailable: [] },
      },
    },
  }),
  malformed: row({ content: "Answer.", metadata: { projectBrain: { statements: "nope", sources: [{ evidenceId: 3 }, null], citations: null } } }),
  hostile: row({
    content: "<img src=x onerror=alert(1)> answer",
    statements: [
      { type: "FACT", text: "<script>alert('claim')</script>", sources: [source("projects:p1", "PROJECT", "Project — <b onmouseover=x>Evil</b>")] },
      { type: "INFERENCE", text: "<SCRIPT SRC=//x></SCRIPT><IMG SRC=x ONERROR=alert(2)>", sources: [source("projects:p1", "PROJECT", "Project — <b onmouseover=x>Evil</b>")] },
    ],
    sources: [source("projects:p1", "PROJECT", "Project — <b onmouseover=x>Evil</b>")],
  }),
};

const views = Object.fromEntries(Object.entries(CASES).map(([name, r]) => [name, toProjectBrainMessageView(r)!])) as Record<string, ProjectBrainMessageView>;

// Frozen deep copies: rendering and deriving must not modify the message they present.
const deepFreeze = <T,>(value: T): T => {
  if (value && typeof value === "object") {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
};
const before = JSON.stringify(views);
Object.values(views).forEach(deepFreeze);

const render = (view: ProjectBrainMessageView, variant: "dark" | "light", layout: "panel" | "surface") =>
  renderToStaticMarkup(
    <ProjectBrainAnswer message={view} variant={variant} layout={layout} onRetry={view.brain?.mode === "degraded" ? () => {} : undefined} />,
  );

// The composer's persistent note and the limited-mode notice, in each generative-availability
// state the transcript GET can report (generative-access.ts decides; nothing here changes it).
const MODES = {
  generative: { generativeAvailable: true, limitedModeReason: null },
  notIncluded: { generativeAvailable: false, limitedModeReason: "not_included" },
  unavailable: { generativeAvailable: false, limitedModeReason: "unavailable" },
} as const;
const footer = Object.fromEntries(
  Object.entries(MODES).map(([name, mode]) => [
    name,
    Object.fromEntries(
      (["light", "dark"] as const).map((variant) => [
        variant,
        {
          notice: renderToStaticMarkup(<LimitedModeNotice {...mode} variant={variant} />),
          note: renderToStaticMarkup(<ProjectBrainDisclosureNote variant={variant} />),
        },
      ]),
    ),
  ]),
);

const out = {
  footer,
  surface: Object.fromEntries(Object.entries(views).map(([name, view]) => [name, render(view, "light", "surface")])),
  panel: Object.fromEntries(Object.entries(views).map(([name, view]) => [name, render(view, "dark", "panel")])),
  disclosure: Object.fromEntries(Object.entries(views).map(([name, view]) => [name, deriveAnswerDisclosure(view.brain)])),
  views,
  unchanged: JSON.stringify(views) === before,
};

process.stdout.write(JSON.stringify(out));
