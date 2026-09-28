/**
 * PB-PRESENT-01 — progressive disclosure for Project Brain answers.
 *
 * Before: every assistant turn rendered "AI-written answer", the prose, a "Claims about this
 * project" ledger of uppercase epistemic badges, a "Records cited" chip row and, when
 * relevant, a grounding notice — the whole epistemic machinery, always open.
 *
 * After: the answer comes first, followed by ONE compact "Sources & verification" row
 * (native <details>, closed by default). The claims, their labels and the cited records open
 * from it. What is material stays visible while closed: a record conflict, claims that need
 * review, reliance on reported chat context, limited mode and the general-answer note.
 *
 * Presentation only. The prompt, output contract, grounding, persistence and the turn API
 * are unchanged — pinned by the diff guard at the bottom.
 *
 * Renders are real (`pb-present-01-harness.tsx`: persisted row → toProjectBrainMessageView →
 * ProjectBrainAnswer). Open/close in a live browser is proven by the P-scenarios in
 * tests/e2e/pb-chat-01-project-brain.spec.ts; here, "hidden until expanded" means rendered
 * only inside a <details> that carries no `open` attribute — which the browser does not show.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const harness = JSON.parse(
  execFileSync(process.execPath, ["node_modules/tsx/dist/cli.mjs", "tests/pb-present-01-harness.tsx"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
    maxBuffer: 64 * 1024 * 1024,
  }),
);

const COMPONENT = "src/components/pmfreak/project-brain/project-brain-conversation.tsx";
const HELPER = "src/components/pmfreak/project-brain/answer-disclosure.ts";
const code = (file) =>
  readFileSync(file, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n");

/** Splits one rendered answer into what is always visible and what is behind the disclosure. */
function parts(markup) {
  const open = markup.indexOf("<details");
  if (open < 0) return { details: null, outside: markup, summary: "", panel: "", text: (s) => s };
  const close = markup.indexOf("</details>", open);
  const details = markup.slice(open, close + "</details>".length);
  const tag = details.slice(0, details.indexOf(">") + 1);
  const summaryEnd = details.indexOf("</summary>");
  return {
    details,
    tag,
    isOpen: /\sopen(=|\s|>)/.test(tag),
    outside: markup.slice(0, open) + markup.slice(close + "</details>".length),
    summary: details.slice(details.indexOf("<summary"), summaryEnd),
    panel: details.slice(summaryEnd),
  };
}
// The ▸/▾ glyphs are decorative (aria-hidden) disclosure indicators.
const visibleText = (html) => html.replace(/<[^>]+>/g, "").replace(/[▸▾]/g, "").replace(/\u00a0/g, " ").replace(/&amp;/g, "&").replace(/&#x27;/g, "'").replace(/\s+/g, " ").trim();
const ONTOLOGY = /\b(FACT|INFERENCE|RECOMMENDATION|UNKNOWN|ASSUMPTION|OPEN_QUESTION|CONTRADICTION|CITES PROJECT RECORDS|epistemic|alias|R\d+|S\d+)\b/;

// ═══ A/B. An ordinary answer is answer-first, details closed ═══════════════════

test("A: an ordinary answer shows its prose and one closed disclosure — no claims, badges or chips in view", () => {
  const p = parts(harness.surface.normal);
  assert.ok(p.details, "a project answer with claims has a disclosure");
  assert.equal(p.isOpen, false, "closed by default");
  assert.match(p.outside, /The next target is P14\./, "the answer is outside the disclosure");
  assert.ok(p.outside.indexOf("The next target is P14") < harness.surface.normal.indexOf("<details"), "the answer comes first");
  for (const hidden of ['data-testid="project-brain-statements"', 'data-testid="project-brain-sources"', "data-source-id=", "data-epistemic-type=", "Cites project records", "Inference"]) {
    assert.equal(p.outside.includes(hidden), false, `${hidden} is not in view before expanding`);
    assert.equal(p.summary.includes(hidden), false, `${hidden} is not in the summary`);
    assert.ok(p.panel.includes(hidden), `${hidden} is available once expanded`);
  }
  assert.match(p.summary, /data-testid="project-brain-answer-details-summary"/);
  assert.doesNotMatch(visibleText(p.summary), ONTOLOGY, "no ontology jargon on the collapsed row");
  assert.equal(visibleText(p.summary), "AI-generated · Sources & verification · 3 records");
});

test("B: expanding and collapsing is native <details> state — no React state, nothing persisted, transcript content untouched", () => {
  const component = code(COMPONENT);
  assert.match(component, /<details\b/);
  assert.match(component, /<summary\b/);
  assert.doesNotMatch(component, /\bopen=\{|defaultOpen|setOpen|useState\([^)]*open/i, "the open state is the browser's, not ours");
  assert.doesNotMatch(component, /localStorage|sessionStorage|disclosureOpen|expanded:/, "open/closed is never stored");
  // Toggling a <details> changes no message: the only auto-scroll trigger is the message count.
  assert.match(component, /scrollTo\(\{ top: scrollRef\.current\.scrollHeight \}\);\n\s*\}, \[messages\.length, sending\]\);/);
  assert.equal(harness.unchanged, true);
});

// ═══ C. Counts come from the view model ═══════════════════════════════════════

test("C: the summary counts unique cited records — the view model's deduplicated list, not statement references", () => {
  const normal = harness.views.normal.brain;
  const references = normal.statements.flatMap((s) => s.sourceIds).length;
  assert.equal(references, 4, "fixture: 3 unique records cited 4 times");
  assert.equal(harness.disclosure.normal.sourceCount, 3);
  assert.deepEqual(harness.disclosure.normal.counts, ["3 records"]);
  assert.match(visibleText(parts(harness.surface.hostile).summary), /· 1 record(?!s)/, "singular");
  // With no record cited, the summary counts the claims instead — never "0 records".
  assert.deepEqual(harness.disclosure.adjusted.counts, ["1 record"]);
});

// ═══ D. Reported chat context ═══════════════════════════════════════════════════

test("D: a report-backed answer says so while closed; expanded, its claim reads 'Reported in chat · not verified'", () => {
  const p = parts(harness.surface.reported);
  assert.equal(p.isOpen, false);
  assert.match(p.tag, /data-reported-context="true"/);
  assert.equal(visibleText(p.summary), "AI-generated · Sources & verification · 2 records · uses 2 reported chat updates · not verified");
  assert.match(p.summary, /data-testid="project-brain-answer-reported"/);
  const reported = /<li[^>]*data-epistemic-type="REPORTED"[^>]*>([\s\S]*?)<\/li>/.exec(p.panel);
  assert.ok(reported, "the report-backed claim is in the details");
  assert.match(reported[0], /data-reported-in-conversation="true"/);
  assert.match(reported[1], /Reported in chat · not verified/);
  assert.doesNotMatch(reported[1], /Cites project records/, "a report never reads as citing records");
  // A suggestion that rests on a report says so too.
  const suggestion = /<li[^>]*data-epistemic-type="RECOMMENDATION"[^>]*>([\s\S]*?)<\/li>/.exec(p.panel);
  assert.match(suggestion[1], /Suggestion · needs your approval/);
  assert.match(suggestion[1], /Uses a chat report · not verified/);
  assert.match(p.panel, /data-testid="project-brain-reported-note"/);
  // Reports are not sources: no chip for a chat turn, and no internal alias anywhere.
  assert.doesNotMatch(p.panel, /data-source-id="u-/);
  assert.doesNotMatch(visibleText(harness.surface.reported), /\bR\d+\b|\bu-\d\b/);
  assert.equal(harness.disclosure.reported.reportTurnCount, 2, "distinct turns, not claim references");
  assert.equal(harness.disclosure.reported.reportedClaimCount, 2);
});

// ═══ E/F. Material cautions stay visible while closed ════════════════════════════

test("E: grounding adjustments show a warning on the closed row; the precise notice is inside", () => {
  const p = parts(harness.surface.adjusted);
  assert.equal(p.isOpen, false);
  assert.match(p.tag, /data-tone="caution"/);
  assert.match(p.summary, /data-caution="review"[^>]*>[\s\S]*Some claims need review/);
  assert.match(p.panel, /data-testid="project-brain-grounding-notice"[^>]*>Some generated claims could not be fully linked to project records\./);
  assert.doesNotMatch(visibleText(harness.surface.adjusted), /rejectedCitations|downgradedStatements|droppedStatements|unsupportedReferences|=\d/);
  // Nothing to open, yet adjusted: the notice cannot hide in a panel that is not there.
  const bare = parts(harness.surface.adjustedNothingToOpen);
  assert.equal(bare.details, null);
  assert.match(bare.outside, /data-testid="project-brain-grounding-notice"/);
});

test("F: a record conflict is the most salient cue on the closed row", () => {
  const p = parts(harness.surface.contradiction);
  assert.match(p.tag, /data-tone="caution"/);
  assert.match(p.summary, /data-caution="conflict"[^>]*>[\s\S]*Project records conflict/);
  assert.match(p.panel, /data-epistemic-type="CONTRADICTION"[\s\S]*Records conflict/);
  assert.match(p.panel, /data-testid="project-brain-conflict-notice"/);
  // Priority: conflict before review, both before the neutral label.
  const both = harness.disclosure;
  assert.deepEqual(both.contradiction.cautions, ["conflict"]);
  const summary = visibleText(p.summary);
  assert.ok(summary.indexOf("Project records conflict") < summary.indexOf("Sources & verification"));
  // Cautions are styled apart from routine provenance (amber, from the existing palette).
  assert.match(p.summary, /data-testid="project-brain-answer-caution"[^>]*/);
  assert.match(harness.surface.contradiction, /border-amber-200 bg-amber-50 text-amber-900/);
});

// ═══ G/H/I/J. General, limited, old and empty ══════════════════════════════════

test("G: a general answer shows its note and no disclosure at all", () => {
  const p = parts(harness.surface.conversational);
  assert.equal(p.details, null, "no empty Sources & verification");
  assert.match(p.outside, /data-testid="project-brain-conversational-note"/);
  assert.match(visibleText(p.outside), /AI-generated · General answer — not linked to this project's records\./);
  assert.doesNotMatch(p.outside, /project-brain-statements|project-brain-sources|Sources &amp; verification/);
});

test("H: limited mode stays in view; its records may sit behind the disclosure; retry remains", () => {
  const withSources = parts(harness.surface.degradedWithSources);
  assert.match(withSources.outside, /data-testid="project-brain-limited-answer"[^>]*>Limited mode</);
  assert.match(withSources.outside, />Try again with Project Brain<\/button>/);
  assert.ok(withSources.details, "its records are disclosable");
  assert.doesNotMatch(withSources.summary, /AI-generated/, "a deterministic limited-mode reply is not labelled AI-generated");
  const bare = parts(harness.surface.degradedBare);
  assert.equal(bare.details, null);
  assert.match(bare.outside, />Limited mode</);
  assert.match(bare.outside, />Try again with Project Brain<\/button>/);
  // The retry condition is unchanged: never offered for a plan limit, nor after an upgrade.
  assert.match(code(COMPONENT), /message\.brain\?\.mode === "degraded" && message\.brain\.reason !== "not_entitled" && !upgraded\.has\(message\.replyToMessageId\)/);
});

test("I: a row written before PB-REASON-02 renders — no reports, no reported cue", () => {
  const p = parts(harness.surface.preReason02);
  assert.ok(p.details);
  assert.equal(visibleText(p.summary), "AI-generated · Sources & verification · 1 record");
  assert.doesNotMatch(p.summary, /reported/i);
  // A source-backed REPORTED (a stakeholder report on record) is not "reported in chat".
  const reported = /<li[^>]*data-epistemic-type="REPORTED"[^>]*>([\s\S]*?)<\/li>/.exec(p.panel);
  assert.doesNotMatch(reported[0], /data-reported-in-conversation/);
  assert.match(reported[1], />Reported</);
});

test("J: nothing structured → no disclosure; legacy and malformed rows render honestly", () => {
  for (const name of ["conversational", "degradedBare", "legacy", "malformed"]) {
    assert.doesNotMatch(harness.surface[name], /<details/, `${name}: no empty disclosure`);
  }
  assert.match(harness.surface.legacy, /data-mode="legacy"/);
  assert.match(harness.surface.legacy, /Earlier rule-based Project Chat reply/);
  assert.doesNotMatch(harness.surface.legacy, /AI-generated|forged|data-source-id/, "a legacy reply never looks like a generative, sourced answer");
  assert.match(harness.surface.malformed, /<p>Answer\.<\/p>/);
});

// ═══ K. One presentation, two layouts ═════════════════════════════════════════

test("K: the panel layout uses the same progressive disclosure", () => {
  for (const name of Object.keys(harness.surface)) {
    const surface = parts(harness.surface[name]);
    const panel = parts(harness.panel[name]);
    assert.equal(Boolean(panel.details), Boolean(surface.details), `${name}: same disclosure decision`);
    assert.equal(visibleText(panel.summary), visibleText(surface.summary), `${name}: same summary`);
    assert.equal(panel.isOpen ?? false, false);
  }
  assert.match(harness.panel.adjusted, /border-amber-500\/30 bg-amber-500\/10 text-amber-200/, "dark variant keeps its palette");
  assert.equal((code(COMPONENT).match(/<ProjectBrainAnswer\b/g) ?? []).length, 1, "one answer renderer, mounted once for both layouts");
});

// ═══ L. Presentation never rewrites the answer ═════════════════════════════════

test("L: deriving and rendering leave content, statements, source ids and reported turn ids unchanged", () => {
  assert.equal(harness.unchanged, true, "frozen views, identical before and after");
  const view = harness.views.reported;
  assert.equal(view.content, "Based on your update, P14 is the working next target.");
  assert.deepEqual(view.brain.statements.map((s) => s.reportedTurnIds), [["u-1"], ["u-1", "u-3"], []]);
  assert.deepEqual(view.brain.sources.map((s) => s.id), ["project_milestones:m13", "projects:p1"]);
  const helper = code(HELPER);
  assert.doesNotMatch(helper, /fetch\(|import\(|runInference|\.push\(\s*\{|epistemicType\s*=[^=]|\.sort\(/, "the helper reads; it never re-types, reorders or requests");
  assert.doesNotMatch(helper, /from "react"|use client/, "a pure function, not a component");
});

// ═══ Copy, reasoning, security ═════════════════════════════════════════════════

test("copy: no reasoning exposure, no overclaim, no ontology on the collapsed surface", () => {
  const component = code(COMPONENT);
  const helper = code(HELPER);
  for (const source of [component, helper]) {
    assert.doesNotMatch(source, /Reasoning|Thought process|How I reasoned|Chain of thought|Model reasoning/i);
    assert.doesNotMatch(source, /Verified by|Proven by|Fully verified|Fact-checked|fully sourced|fully grounded/i);
  }
  assert.doesNotMatch(component, /Claims about this project|uppercase tracking-\[0\.08em\]/, "badges are sentence case, not a debug console");
  assert.doesNotMatch(component, /AI-written answer/, "the per-answer label is the literal ADR-PMF-066 label");
  assert.match(component, /const AI_GENERATED_LABEL = "AI-generated";/);
  // ADR-PMF-066 §5 (Accepted): every AI-generated answer carries the label at its point of display.
  for (const name of ["normal", "reported", "adjusted", "contradiction", "conversational", "hostile", "preReason02"]) {
    assert.equal((harness.surface[name].match(/data-testid="project-brain-synthesis-label"/g) ?? []).length, 1, `${name}: labelled exactly once`);
  }
  for (const [name, markup] of Object.entries(harness.surface)) {
    const summary = parts(markup).summary;
    if (summary) assert.doesNotMatch(visibleText(summary), ONTOLOGY, `${name}: collapsed row speaks customer language`);
  }
});

test("security: all answer, claim and source text stays React-escaped", () => {
  const hostile = harness.surface.hostile;
  assert.doesNotMatch(hostile, /<img src=x|<script>|<b onmouseover/);
  assert.match(hostile, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(hostile, /&lt;script&gt;/);
  assert.match(hostile, /&lt;b onmouseover=x&gt;Evil&lt;\/b&gt;/);
  assert.doesNotMatch(code(COMPONENT) + code(HELPER), /dangerouslySetInnerHTML/);
});

test("opening details is entirely client-side: the only requests are the existing transcript GET and turn POST", () => {
  const component = code(COMPONENT);
  const fetches = component.match(/fetch\(/g) ?? [];
  assert.equal(fetches.length, 2, "load + send, unchanged");
  const answer = component.slice(component.indexOf("function AnswerDetails("), component.indexOf("type ConversationProps = {"));
  assert.doesNotMatch(answer, /fetch\(|useEffect|onToggle|navigator\.sendBeacon|analytics/);
});

test("the global disclosure is shorter, still says a citation is not proof, and still says it cannot change the project", () => {
  const component = code(COMPONENT);
  const disclosure = /data-testid="project-brain-disclosure">\s*([\s\S]*?)\s*<\/p>/.exec(component)[1];
  assert.match(disclosure, /AI-generated/);
  assert.match(disclosure, /sources &amp; verification/);
  assert.match(disclosure, /a citation is not proof of every sentence/);
  assert.match(disclosure, /It cannot change the project\./);
  assert.doesNotMatch(disclosure, /Listed claims/, "claims are no longer always listed");
});

// ═══ Regression boundary ══════════════════════════════════════════════════════

/** Shallow CI checkouts have no origin/main: these checks skip explicitly, never pass vacuously. */
const BASE_REF = (() => {
  try {
    execFileSync("git", ["rev-parse", "--verify", "--quiet", "origin/main"], { stdio: "ignore" });
    return "origin/main";
  } catch {
    return null;
  }
})();

test("presentation only: reasoning, grounding, contract, persistence and the turn API are unchanged", { skip: BASE_REF ? false : "no origin/main in this checkout" }, () => {
  for (const file of [
    "src/lib/project-brain/conversation/prompt.ts",
    "src/lib/project-brain/conversation/output.ts",
    "src/lib/project-brain/conversation/turn-service.ts",
    "src/lib/project-brain/conversation/transcript-view.ts",
    "src/lib/project-brain/conversation/context-types.ts",
    "src/lib/project-brain/conversation/context-builder.ts",
    "src/lib/project-brain/conversation/reported-context.ts",
    "src/lib/project-brain/conversation/assistant-message-writer.ts",
    "src/lib/project-brain/conversation/generative-access.ts",
    "src/lib/project-brain/conversation/degraded.ts",
    "src/lib/project-brain/guardrails.ts",
    "src/lib/project-brain/constitution.ts",
    "src/app/api/projects/[id]/brain/turns/route.ts",
  ]) {
    assert.ok(existsSync(file), `${file} exists`);
    const diff = execFileSync("git", ["diff", "--name-only", BASE_REF, "--", file], { encoding: "utf8" }).trim();
    assert.equal(diff, "", `${file} must be unchanged by PB-PRESENT-01`);
  }
});

test("no schema change and no migration", { skip: BASE_REF ? false : "no origin/main in this checkout" }, () => {
  const changed = execFileSync("git", ["diff", "--name-only", BASE_REF, "--", "supabase"], { encoding: "utf8" }).trim();
  const untracked = execFileSync("git", ["ls-files", "--others", "--exclude-standard", "supabase"], { encoding: "utf8" }).trim();
  assert.equal(changed, "");
  assert.equal(untracked, "");
});
