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

/**
 * Splits one rendered answer into what is always visible and what is behind the disclosure.
 * Structural slicing of React's own output by known markers — never HTML sanitizing or
 * unescaping. Visible text as a browser computes it is asserted in the Playwright scenarios.
 */
function parts(markup) {
  const open = markup.indexOf("<details");
  if (open < 0) return { details: null, outside: markup, summary: "", panel: "", isOpen: false };
  const close = markup.indexOf("</details>", open);
  const details = markup.slice(open, close + "</details>".length);
  const tag = details.slice(0, details.indexOf(">") + 1);
  const summaryEnd = details.indexOf("</summary>");
  return {
    details,
    tag,
    isOpen: tag.includes(" open"),
    outside: markup.slice(0, open) + markup.slice(close + "</details>".length),
    summary: details.slice(details.indexOf("<summary"), summaryEnd),
    panel: details.slice(summaryEnd),
  };
}

/** The rendered <li> for the first claim of an epistemic type, sliced by its marker attribute. */
function claimItem(panel, type) {
  const at = panel.indexOf(`data-epistemic-type="${type}"`);
  if (at < 0) return null;
  return panel.slice(panel.lastIndexOf("<li", at), panel.indexOf("</li>", at) + "</li>".length);
}

/**
 * The exact fragments React renders for a collapsed row, derived from the pure disclosure
 * model — so the summary is asserted as a function of the model, not by re-reading HTML.
 */
const NB = " · ";
const AI_LABEL_FRAGMENT = '<span data-testid="project-brain-synthesis-label">AI-generated</span>';
const CAUTION_TEXT = { conflict: "Project records conflict", review: "Some claims need review" };
function summaryFragments(disclosure, { aiLabel }) {
  return [
    ...(aiLabel ? [AI_LABEL_FRAGMENT] : []),
    ...disclosure.cautions.map((c) => `data-caution="${c}">`),
    ...disclosure.cautions.map((c) => `${CAUTION_TEXT[c]}</span>`),
    `>Sources &amp; verification</span>${disclosure.counts.map((c) => `${NB}${c}`).join("")}`,
    ...(disclosure.reportedNote ? [`data-testid="project-brain-answer-reported">${disclosure.reportedNote}</span>`] : []),
  ];
}
function assertSummary(summary, disclosure, opts, label = "") {
  for (const fragment of summaryFragments(disclosure, opts)) {
    assert.ok(summary.includes(fragment), `${label} summary renders ${JSON.stringify(fragment)}`);
  }
  if (!opts.aiLabel) assert.equal(summary.includes("AI-generated"), false, `${label} no AI label`);
  if (!disclosure.reportedNote) assert.equal(summary.includes("project-brain-answer-reported"), false, `${label} no reported cue`);
}

/** Internal vocabulary that must not appear anywhere in a collapsed row's markup. */
const ONTOLOGY = ["FACT", "INFERENCE", "RECOMMENDATION", "UNKNOWN", "ASSUMPTION", "OPEN_QUESTION", "CONTRADICTION", "Cites project records", "epistemic", "alias", "R1", "R2", "S1", "S2", "u-1", "u-3"];
const assertNoOntology = (summary, label) => {
  for (const term of ONTOLOGY) assert.equal(summary.includes(term), false, `${label}: collapsed row does not say ${term}`);
};

// ═══ A/B. An ordinary answer is answer-first, details closed ═══════════════════

test("A: an ordinary answer shows its prose and one closed disclosure — no claims, badges or chips in view", () => {
  const p = parts(harness.surface.normal);
  assert.ok(p.details, "a project answer with claims has a disclosure");
  assert.equal(p.isOpen, false, "closed by default");
  assert.ok(p.outside.includes("<p>The next target is P14. P13 Authenticity is on record as the current milestone.</p>"), "the answer is outside the disclosure");
  assert.ok(harness.surface.normal.indexOf("The next target is P14") < harness.surface.normal.indexOf("<details"), "the answer comes first");
  for (const hidden of ['data-testid="project-brain-statements"', 'data-testid="project-brain-sources"', "data-source-id=", "data-epistemic-type=", "Cites project records", "Inference"]) {
    assert.equal(p.outside.includes(hidden), false, `${hidden} is not in view before expanding`);
    assert.equal(p.summary.includes(hidden), false, `${hidden} is not in the summary`);
    assert.ok(p.panel.includes(hidden), `${hidden} is available once expanded`);
  }
  assert.ok(p.summary.includes('data-testid="project-brain-answer-details-summary"'));
  assertNoOntology(p.summary, "normal");
  assert.deepEqual(harness.disclosure.normal.cautions, []);
  assertSummary(p.summary, harness.disclosure.normal, { aiLabel: true });
  assert.ok(p.summary.includes(`${AI_LABEL_FRAGMENT} <span aria-hidden="true">·</span> <span class="min-w-0"><span class="font-medium">Sources &amp; verification</span>${NB}3 records<`), "AI-generated · Sources & verification · 3 records");
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
  assert.deepEqual(harness.disclosure.hostile.counts, ["1 record"], "singular");
  assert.ok(parts(harness.surface.hostile).summary.includes(`${NB}1 record<`));
  assert.deepEqual(harness.disclosure.adjusted.counts, ["1 record"]);
});

// ═══ D. Reported chat context ═══════════════════════════════════════════════════

test("D: a report-backed answer says so while closed; expanded, its claim reads 'Reported in chat · not verified'", () => {
  const p = parts(harness.surface.reported);
  assert.equal(p.isOpen, false);
  assert.ok(p.tag.includes('data-reported-context="true"'));
  assert.equal(harness.disclosure.reported.reportedNote, "uses 2 reported chat updates · not verified");
  assertSummary(p.summary, harness.disclosure.reported, { aiLabel: true });
  const reported = claimItem(p.panel, "REPORTED");
  assert.ok(reported, "the report-backed claim is in the details");
  assert.ok(reported.includes('data-reported-in-conversation="true"'));
  assert.ok(reported.includes(">Reported in chat · not verified</span>"));
  assert.equal(reported.includes("Cites project records"), false, "a report never reads as citing records");
  // A suggestion that rests on a report says so too.
  const suggestion = claimItem(p.panel, "RECOMMENDATION");
  assert.ok(suggestion.includes(">Suggestion · needs your approval</span>"));
  assert.ok(suggestion.includes(">Uses a chat report · not verified</span>"));
  assert.ok(p.panel.includes('data-testid="project-brain-reported-note"'));
  // Reports are not sources: no chip for a chat turn, and no internal alias or turn id anywhere.
  assert.equal(p.panel.includes('data-source-id="u-'), false);
  for (const internal of ["R1", "R2", "u-1", "u-3"]) assert.equal(harness.surface.reported.includes(internal), false, `${internal} is not rendered`);
  assert.equal(harness.disclosure.reported.reportTurnCount, 2, "distinct turns, not claim references");
  assert.equal(harness.disclosure.reported.reportedClaimCount, 2);
});

// ═══ E/F. Material cautions stay visible while closed ════════════════════════════

test("E: grounding adjustments show a warning on the closed row; the precise notice is inside", () => {
  const p = parts(harness.surface.adjusted);
  assert.equal(p.isOpen, false);
  assert.ok(p.tag.includes('data-tone="caution"'));
  assert.deepEqual(harness.disclosure.adjusted.cautions, ["review"]);
  assertSummary(p.summary, harness.disclosure.adjusted, { aiLabel: true });
  assert.ok(p.panel.includes('data-testid="project-brain-grounding-notice">Some generated claims could not be fully linked to project records.'));
  for (const counter of ["rejectedCitations", "downgradedStatements", "droppedStatements", "unsupportedReferences"]) {
    assert.equal(harness.surface.adjusted.includes(counter), false, `${counter} is not rendered`);
  }
  // Nothing to open, yet adjusted: the notice cannot hide in a panel that is not there.
  const bare = parts(harness.surface.adjustedNothingToOpen);
  assert.equal(bare.details, null);
  assert.ok(bare.outside.includes('data-testid="project-brain-grounding-notice"'));
});

test("F: a record conflict is the most salient cue on the closed row", () => {
  const p = parts(harness.surface.contradiction);
  assert.ok(p.tag.includes('data-tone="caution"'));
  assert.deepEqual(harness.disclosure.contradiction.cautions, ["conflict"]);
  assertSummary(p.summary, harness.disclosure.contradiction, { aiLabel: true });
  assert.ok(claimItem(p.panel, "CONTRADICTION").includes(">Records conflict</span>"));
  assert.ok(p.panel.includes('data-testid="project-brain-conflict-notice"'));
  // Priority: the conflict cue precedes the neutral label.
  assert.ok(p.summary.indexOf("Project records conflict") < p.summary.indexOf("Sources &amp; verification"));
  // Cautions are styled apart from routine provenance (amber, from the existing palette).
  assert.ok(p.summary.includes('data-testid="project-brain-answer-caution"'));
  assert.ok(harness.surface.contradiction.includes("border-amber-200 bg-amber-50 text-amber-900"));
});

// ═══ G/H/I/J. General, limited, old and empty ══════════════════════════════════

test("G: a general answer shows its note and no disclosure at all", () => {
  const p = parts(harness.surface.conversational);
  assert.equal(p.details, null, "no empty Sources & verification");
  assert.ok(p.outside.includes(`data-testid="project-brain-conversational-note">${AI_LABEL_FRAGMENT} · General answer — not linked to this project&#x27;s records.</p>`));
  for (const absent of ["project-brain-statements", "project-brain-sources", "Sources &amp; verification"]) assert.equal(p.outside.includes(absent), false);
});

test("H: limited mode stays in view; its records may sit behind the disclosure; retry remains", () => {
  const withSources = parts(harness.surface.degradedWithSources);
  assert.ok(withSources.outside.includes('data-testid="project-brain-limited-answer">Limited mode</p>'));
  assert.ok(withSources.outside.includes(">Try again with Project Brain</button>"));
  assert.ok(withSources.details, "its records are disclosable");
  assertSummary(withSources.summary, harness.disclosure.degradedWithSources, { aiLabel: false }, "degraded");
  const bare = parts(harness.surface.degradedBare);
  assert.equal(bare.details, null);
  assert.ok(bare.outside.includes(">Limited mode</p>"));
  assert.ok(bare.outside.includes(">Try again with Project Brain</button>"));
  // The retry condition is unchanged: never offered for a plan limit, nor after an upgrade.
  assert.match(code(COMPONENT), /message\.brain\?\.mode === "degraded" && message\.brain\.reason !== "not_entitled" && !upgraded\.has\(message\.replyToMessageId\)/);
});

test("I: a row written before PB-REASON-02 renders — no reports, no reported cue", () => {
  const p = parts(harness.surface.preReason02);
  assert.ok(p.details);
  assert.equal(harness.disclosure.preReason02.reportedNote, null);
  assertSummary(p.summary, harness.disclosure.preReason02, { aiLabel: true });
  assert.equal(p.summary.toLowerCase().includes("reported"), false);
  // A source-backed REPORTED (a stakeholder report on record) is not "reported in chat".
  const reported = claimItem(p.panel, "REPORTED");
  assert.equal(reported.includes("data-reported-in-conversation"), false);
  assert.ok(reported.includes(">Reported</span>"));
});

test("J: nothing structured → no disclosure; legacy and malformed rows render honestly", () => {
  for (const name of ["conversational", "degradedBare", "legacy", "malformed"]) {
    assert.equal(harness.surface[name].includes("<details"), false, `${name}: no empty disclosure`);
  }
  assert.ok(harness.surface.legacy.includes('data-mode="legacy"'));
  assert.ok(harness.surface.legacy.includes("Earlier rule-based Project Chat reply"));
  for (const absent of ["forged", "data-source-id"]) assert.equal(harness.surface.legacy.includes(absent), false, "a legacy reply never looks sourced");
  assert.ok(harness.surface.malformed.includes("<p>Answer.</p>"));
});

// ═══ K. One presentation, two layouts ═════════════════════════════════════════

test("K: the panel layout uses the same progressive disclosure", () => {
  for (const name of Object.keys(harness.surface)) {
    const surface = parts(harness.surface[name]);
    const panel = parts(harness.panel[name]);
    assert.equal(Boolean(panel.details), Boolean(surface.details), `${name}: same disclosure decision`);
    assert.equal(panel.isOpen, false);
    if (!surface.details) continue;
    const aiLabel = harness.views[name].brain?.mode === "generative";
    assertSummary(surface.summary, harness.disclosure[name], { aiLabel }, `${name} surface`);
    assertSummary(panel.summary, harness.disclosure[name], { aiLabel }, `${name} panel`);
  }
  assert.ok(harness.panel.adjusted.includes("border-amber-500/30 bg-amber-500/10 text-amber-200"), "dark variant keeps its palette");
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

// ═══ AI label: exactly where the text is AI-generated ══════════════════════════

test("AI label: every generative answer carries 'AI-generated' once; degraded and legacy replies never do", () => {
  const component = code(COMPONENT);
  assert.doesNotMatch(component, /AI-written answer/, "the per-answer label is the literal ADR-PMF-066 §5 / ADR-PMF-071 §5 label");
  assert.match(component, /const AI_GENERATED_LABEL = "AI-generated";/);
  for (const layout of ["surface", "panel"]) {
    for (const [name, view] of Object.entries(harness.views)) {
      const markup = harness[layout][name];
      const labels = markup.split('data-testid="project-brain-synthesis-label"').length - 1;
      if (view.brain?.mode === "generative") {
        assert.equal(labels, 1, `${layout}/${name}: a generative answer is labelled exactly once`);
        assert.ok(markup.includes(AI_LABEL_FRAGMENT), `${layout}/${name}: the literal label`);
      } else {
        assert.equal(labels, 0, `${layout}/${name}: a ${view.brain?.mode ?? "legacy"} reply is not AI-generated`);
        assert.equal(markup.includes("AI-generated"), false, `${layout}/${name}: no AI-generated text at all`);
      }
    }
  }
  // The fixture covers every mode.
  const modes = new Set(Object.values(harness.views).map((v) => v.brain?.mode ?? "legacy"));
  assert.deepEqual([...modes].sort(), ["degraded", "generative", "legacy"]);
});

// ═══ The composer's persistent note (PR #630 F1) ═══════════════════════════════

test("footer: in every generative-availability state the persistent note is true — it never calls limited-mode output AI-generated", () => {
  const states = harness.footer;
  assert.deepEqual(Object.keys(states), ["generative", "notIncluded", "unavailable"]);
  for (const [state, byVariant] of Object.entries(states)) {
    for (const [variant, { notice, note }] of Object.entries(byVariant)) {
      const where = `${state}/${variant}`;
      assert.ok(note.includes('data-testid="project-brain-disclosure"'), `${where}: the note is shown`);
      // True in all modes: it describes GENERATIVE answers, never all of them.
      assert.ok(note.includes("Generative Project Brain answers are AI-generated"), `${where}: scoped to generative answers`);
      for (const falseUniversal of ["Project Brain&#x27;s answers are AI-generated", "answers are AI-generated from", "Each project answer", "every answer", "All answers"]) {
        assert.equal(note.includes(falseUniversal), false, `${where}: no universal claim "${falseUniversal}"`);
      }
      // Details only where there is project support; a citation is not semantic proof.
      assert.ok(note.includes("When an answer has project support, its sources &amp; verification open beneath it"), `${where}: details are conditional`);
      assert.ok(note.includes("a citation is not proof of every sentence"), `${where}: citation boundary`);
      assert.ok(note.includes("Project Brain cannot change the project."), `${where}: no project writes`);
      for (const overclaim of ["verified by", "proven", "fact-checked", "fully sourced"]) assert.equal(note.toLowerCase().includes(overclaim), false, `${where}: no "${overclaim}"`);
      // The limited-mode notice appears exactly when answers will be deterministic.
      const limited = state !== "generative";
      assert.equal(notice.includes('data-testid="project-brain-limited-mode"'), limited, `${where}: limited-mode notice`);
      if (limited) assert.equal((notice + note).includes("answers are AI-generated from"), false, `${where}: limited mode is never described as AI-generated`);
    }
  }
  assert.ok(states.notIncluded.light.notice.includes("aren&#x27;t included in your current plan"));
  assert.ok(states.unavailable.light.notice.includes("temporarily operating in limited mode"));
  assert.equal(states.generative.light.notice, "");
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
  for (const [name, markup] of Object.entries(harness.surface)) {
    const summary = parts(markup).summary;
    if (summary) assertNoOntology(summary, name);
  }
});

test("security: hostile answer, claim and source text renders escaped — never as markup", () => {
  const hostile = harness.surface.hostile;
  // Exact escaped output at each of the three places untrusted text is rendered.
  assert.ok(hostile.includes("<p>&lt;img src=x onerror=alert(1)&gt; answer</p>"), "answer prose");
  assert.ok(hostile.includes("&lt;script&gt;alert(&#x27;claim&#x27;)&lt;/script&gt;</li>"), "claim text");
  assert.ok(hostile.includes("&lt;SCRIPT SRC=//x&gt;&lt;/SCRIPT&gt;&lt;IMG SRC=x ONERROR=alert(2)&gt;</li>"), "upper-case claim text");
  assert.ok(hostile.includes("· &lt;b onmouseover=x&gt;Evil&lt;/b&gt;</span>"), "source label");
  // No raw element from any of them, in any letter case, in either layout.
  for (const layout of ["surface", "panel"]) {
    const lower = harness[layout].hostile.toLowerCase();
    for (const raw of ["<script", "<img", "<b onmouseover", "onerror=alert(1)>", "onerror=alert(2)>"]) {
      assert.equal(lower.includes(raw), false, `${layout}: no raw ${raw}`);
    }
  }
  assert.doesNotMatch(code(COMPONENT) + code(HELPER), /dangerouslySetInnerHTML/);
});

test("opening details is entirely client-side: the only requests are the existing transcript GET and turn POST", () => {
  const component = code(COMPONENT);
  const fetches = component.match(/fetch\(/g) ?? [];
  assert.equal(fetches.length, 2, "load + send, unchanged");
  const answer = component.slice(component.indexOf("function AnswerDetails("), component.indexOf("type ConversationProps = {"));
  assert.doesNotMatch(answer, /fetch\(|useEffect|onToggle|navigator\.sendBeacon|analytics/);
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

/**
 * The files PB-PRESENT-01 declared unchanged. PB-EXEC-01 (execution briefs) deliberately
 * extends some of them — output.ts (exported grounding helpers), turn-service.ts (the
 * `execution_brief` operation), transcript-view.ts (validated brief view), context-types.ts
 * / context-builder.ts (internal revision marker) and the turn route (intent/targetRef) —
 * and pins those changes in tests/pb-exec-01-execution-brief.test.ts. So the guard is split:
 * PB-PRESENT-01's OWN merge must have left every file untouched (permanent proof that it was
 * presentation-only), and the files no later increment has had reason to change stay frozen.
 */
const PB_PRESENT_01_FROZEN = [
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
];
const CHANGED_BY_PB_EXEC_01 = new Set([
  "src/lib/project-brain/conversation/output.ts",
  "src/lib/project-brain/conversation/turn-service.ts",
  "src/lib/project-brain/conversation/transcript-view.ts",
  "src/lib/project-brain/conversation/context-types.ts",
  "src/lib/project-brain/conversation/context-builder.ts",
  "src/app/api/projects/[id]/brain/turns/route.ts",
]);
const PB_PRESENT_01_MERGE = "20e1532b";
const hasCommit = (ref) => {
  try {
    execFileSync("git", ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
};

test("presentation only: PB-PRESENT-01's own merge changed no reasoning, grounding, contract, persistence or turn-API file", { skip: hasCommit(PB_PRESENT_01_MERGE) ? false : "PB-PRESENT-01 merge commit not in this checkout" }, () => {
  for (const file of PB_PRESENT_01_FROZEN) {
    const diff = execFileSync("git", ["diff", "--name-only", `${PB_PRESENT_01_MERGE}^1`, PB_PRESENT_01_MERGE, "--", file], { encoding: "utf8" }).trim();
    assert.equal(diff, "", `${file} must be unchanged by PB-PRESENT-01`);
  }
});

test("presentation only: reasoning, grounding, contract, persistence and the turn API are unchanged", { skip: BASE_REF ? false : "no origin/main in this checkout" }, () => {
  for (const file of PB_PRESENT_01_FROZEN.filter((f) => !CHANGED_BY_PB_EXEC_01.has(f))) {
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
