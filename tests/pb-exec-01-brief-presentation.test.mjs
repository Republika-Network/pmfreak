/**
 * PB-EXEC-01 — presentation of Execution Briefs and the "Prepare execution brief" controls.
 *
 * Renders are real (`pb-exec-01-harness.tsx`: brief produced by the real turn service →
 * persisted row → toProjectBrainMessageView → ProjectBrainAnswer). Interaction — renderer
 * switch, copy, copy blocked, keyboard, narrow viewport — is proven in a real browser by
 * tests/e2e/pb-exec-01-brief-card.spec.ts and the PB-EXEC scenarios of
 * tests/e2e/pb-chat-01-project-brain.spec.ts.
 *
 * Assertions slice React's own output by known markers (data-testid); nothing here parses,
 * sanitizes or unescapes HTML.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

const harness = JSON.parse(
  execFileSync(process.execPath, ["node_modules/tsx/dist/cli.mjs", "tests/pb-exec-01-harness.tsx"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
    maxBuffer: 64 * 1024 * 1024,
  }),
);
const { markup, views, disclosure, rendered } = harness;

const count = (text, needle) => text.split(needle).length - 1;
/** The element carrying `data-testid`, up to its balanced closing tag (React's own output). */
const section = (html, testId) => {
  const at = html.indexOf(`data-testid="${testId}"`);
  if (at < 0) return null;
  const start = html.lastIndexOf("<", at);
  const tag = html.slice(start + 1, html.slice(start).search(/[\s>]/) + start);
  const open = new RegExp(`<${tag}[\\s>]`, "g");
  const close = `</${tag}>`;
  let depth = 0;
  for (let i = start; i < html.length; ) {
    open.lastIndex = i;
    const nextOpen = open.exec(html);
    const nextClose = html.indexOf(close, i);
    if (nextClose < 0) break;
    if (nextOpen && nextOpen.index < nextClose) {
      depth += 1;
      i = nextOpen.index + 1;
    } else {
      depth -= 1;
      i = nextClose + close.length;
      if (depth === 0) return html.slice(start, i);
    }
  }
  return html.slice(start);
};

test("a handoff-ready brief: answer sentence first, then the card with banner, title and readiness", () => {
  const html = markup.ready;
  assert.ok(html.indexOf("I prepared an execution brief for this recommendation.") < html.indexOf('data-testid="execution-brief-card"'), "answer first");
  assert.match(html, /data-readiness="handoff_ready"/);
  assert.match(section(html, "execution-brief-readiness"), />Handoff ready<\/span>$/);
  const banner = section(html, "execution-brief-banner");
  assert.match(banner, /AI-generated<\/span> · manual handoff · not an authorization to execute, merge or deploy/);
  assert.equal(count(html, ">AI-generated<"), 1, "one AI-generated label per brief — on the card, not repeated in the disclosure row");
  assert.match(html, /Not executed · nothing was run, merged or deployed/);
  for (const part of ["execution-brief-objective", "execution-brief-known", "execution-brief-repository", "execution-brief-scope", "execution-brief-constraints", "execution-brief-acceptance", "execution-brief-verification", "execution-brief-unknowns"]) {
    assert.ok(section(html, part), `${part} rendered`);
  }
});

test("provenance stays visible per item, in customer words — no internal ontology", () => {
  const html = markup.ready;
  assert.match(section(html, "execution-brief-objective"), /data-origin="project_record">Project record</);
  const acceptance = section(html, "execution-brief-acceptance");
  assert.match(acceptance, /data-origin="suggested">Suggested by Project Brain<\/span>An empty period produces a CSV with only the header row\./, "a suggested criterion is never an unmarked requirement");
  assert.match(section(html, "execution-brief-constraints"), /data-origin="policy">PMFreak policy</);
  const card = section(html, "execution-brief-card");
  for (const jargon of ["RECOMMENDATION", "project_record<", "knownContext", "reportedTurnIds", "sourceIds", "S1", "R1", "Reasoning", "Thought process", "Chain of thought"]) {
    assert.equal(card.includes(jargon), false, `card does not say ${jargon}`);
  }
});

test("needs input: readiness says so and the blocking open input is visible", () => {
  const html = markup.needsInput;
  assert.match(html, /data-readiness="needs_input"/);
  assert.match(section(html, "execution-brief-readiness"), />Needs input<\/span>$/);
  assert.match(html, /I prepared a draft execution brief, but it needs additional input before handoff\./);
  assert.match(section(html, "execution-brief-unknowns"), /data-blocking="true"[\s\S]*Confirm the objective/);
});

test("reported context: VERIFY BEFORE ACTING is visible with the reported label; the disclosure counts the chat update", () => {
  const verify = section(markup.reported, "execution-brief-verify");
  assert.ok(verify, "a verify-before-acting section");
  assert.match(verify, /Reported in chat · not verified<\/span>P13 was merged this morning\./);
  assert.match(verify, /if this is not true in the repository, stop/);
  assert.equal(disclosure.reported.reportTurnCount, 1);
  assert.match(markup.reported, /uses 1 reported chat update · not verified/);
  assert.equal(markup.reported.includes("Evidence · P13"), false, "a report is never labelled Evidence");
});

test("grounding adjusted: a visible notice; the removed item and its token never render", () => {
  const html = markup.adjusted;
  assert.ok(section(html, "execution-brief-grounding-notice"));
  assert.equal(html.includes("src/unsupplied"), false);
  assert.match(section(html, "execution-brief-unknowns"), /A file path or directory that the project records and this conversation do not establish/);
});

test("Sources & verification lists the brief's cited records from its provenance", () => {
  const details = section(markup.ready, "project-brain-answer-details");
  assert.ok(details, "the disclosure row exists for a brief with cited records");
  assert.equal(details.includes(" open"), false, "closed by default");
  assert.match(details, /Sources &amp; verification/);
  assert.equal(views.ready.brain.sources.length, views.ready.brain.executionBrief.provenance.sources.length);
  for (const source of views.ready.brain.sources) assert.ok(details.includes(`data-source-id="${source.id}"`));
});

test("copy and renderer controls: accessible labels, keyboard-native radios, a live status region, no execution control", () => {
  const html = markup.ready;
  const renderer = section(html, "execution-brief-renderer");
  assert.match(renderer, /<legend[^>]*>Format for<\/legend>/);
  assert.equal(count(renderer, 'type="radio"'), 3);
  assert.match(renderer, /checked="" value="generic"/, "Generic by default");
  assert.match(html, /aria-label="Copy brief formatted for Generic"[^>]*data-testid="execution-brief-copy">Copy brief<\/button>/);
  assert.match(html, /role="status" aria-live="polite" data-testid="execution-brief-copy-status"/);
  for (const forbidden of [">Run with", ">Send to", ">Execute<", ">Delegate<", ">Open PR<", ">Merge<", ">Deploy<"]) assert.equal(html.includes(forbidden), false, forbidden);
});

test("the preview shows the exact guarded renderer text; a credential-bearing brief is not displayed at all", () => {
  const preview = section(markup.ready, "execution-brief-preview");
  assert.ok(preview.includes("AI-generated by PMFreak Project Brain · manual handoff · NOT an authorization to execute, merge or deploy"));
  const poisoned = section(markup.poisoned, "execution-brief-card");
  assert.match(poisoned, /data-blocked="true"/);
  assert.match(poisoned, /This brief contains credential-like content and cannot be displayed or copied safely\./);
  assert.equal(markup.poisoned.includes("ghp_"), false, "no field, preview or copy text shows the value");
  assert.equal(poisoned.includes("execution-brief-copy"), false, "nothing to copy");
  assert.equal(poisoned.includes("execution-brief-preview"), false);
});

test("long content wraps: overflow-wrap on items and on the preview", () => {
  const html = markup.long;
  assert.match(html, /\[overflow-wrap:anywhere\][^>]*>.{0,200}Very long identifier/);
  assert.match(section(html, "execution-brief-preview"), /whitespace-pre-wrap[^"]*\[overflow-wrap:anywhere\]/);
});

test("a malformed stored brief is omitted safely — no card, a notice, never 'General answer'", () => {
  const html = markup.malformed;
  assert.equal(html.includes('data-testid="execution-brief-card"'), false);
  assert.ok(section(html, "execution-brief-unavailable"));
  assert.equal(html.includes("General answer"), false);
  assert.equal(views.malformed.brain.conversationalOnly, false);
});

test("limited mode: a degraded brief turn says so, is labelled Limited mode and carries no AI label or card", () => {
  const html = markup.degraded;
  assert.match(html, /data-testid="project-brain-limited-answer">Limited mode</);
  assert.match(html, /execution briefs require generative Project Brain/);
  assert.equal(html.includes("AI-generated"), false);
  assert.equal(html.includes("execution-brief-card"), false);
});

test("one 'Prepare execution brief' control per recommendation, each bound to its exact statement id", () => {
  const html = markup.threeRecommendations;
  const actions = section(html, "project-brain-prepare-actions");
  assert.ok(actions, "visible without opening the details");
  const ids = [...actions.matchAll(/data-statement-id="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(ids, views.threeRecommendations.brain.statements.filter((s) => s.epistemicType === "RECOMMENDATION").map((s) => s.id));
  assert.equal(count(actions, ">Prepare execution brief</button>"), 3);
  assert.match(actions, /aria-label="Prepare execution brief for: Close the P13 review\."/);
  assert.equal(html.indexOf("project-brain-prepare-actions") < html.indexOf("project-brain-answer-details"), true, "controls sit above the disclosure");
  assert.equal(markup.ready.includes("project-brain-prepare-actions"), false, "a brief reply offers no further prepare control");
});

test("renderer outputs for the same brief differ in framing only", () => {
  const texts = rendered.ready;
  const lines = (t) => new Set(t.split("\n").filter((l) => /\[(project record|suggested|policy|reported · unverified)\]/.test(l)).map((l) => l.replace(/^.*?(\[[^\]]+\])/, "$1").replace(/ — .*$/, "")));
  const generic = lines(texts.generic);
  for (const r of ["claude_code", "codex"]) {
    const other = lines(texts[r]);
    for (const l of generic) assert.ok([...other].some((x) => x.startsWith(l.slice(0, 60))), `${r} carries: ${l}`);
  }
});
