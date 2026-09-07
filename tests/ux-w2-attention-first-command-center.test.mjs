/**
 * UX-W2 — the Command Center is attention-first.
 *
 * Before W2 the Command Center answered "what would you like to type?": `CommandFeed`
 * owned `<main>`, and Needs You / After Your Decision / the nine-agent dock were a
 * 320px right rail that a phone could only reach through an overlay.
 *
 * W2 inverts that. The five questions a PM actually opens this screen with —
 * what needs me, why, what changed, what is under way, what is being watched — are the
 * document, in that order, at every width. Chat is the last section and starts collapsed.
 *
 * This file asserts that against a RENDER, not against source. Which component a module
 * imports is not the same fact as which section the browser lays out first, and only the
 * second one is the product claim. The harness (`ux-w2-command-center-harness.tsx`) renders
 * the real screen and the real canvas through the real read models against canonical-shaped
 * fixtures; everything below reads its output.
 *
 * W2 is a RECOMPOSITION. No canonical semantics, no new intelligence, no migration — the
 * last section of this file is the guard for that.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { SIGNAL_TYPES } from "../src/lib/operational-flow/types.ts";
import { SIGNAL_CHANGE_LABELS, deriveWhatChanged } from "../src/modules/workspace/presentation/command-center/change-read-model.ts";
import { getPrimaryNavigation } from "../src/lib/workspace/navigation-hierarchy.ts";

const read = (p) => readFileSync(p, "utf8");
const layout = read("src/modules/workspace/screens/command-center/command-center-layout.tsx");
const canvasSrc = read("src/modules/workspace/presentation/command-center/command-center-canvas.tsx");

/** Real render output of the Command Center, produced by the harness. */
const harness = JSON.parse(
  execFileSync(process.execPath, ["node_modules/tsx/dist/cli.mjs", "tests/ux-w2-command-center-harness.tsx"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
    maxBuffer: 64 * 1024 * 1024,
  }),
);

/** Visible text of a markup fragment — what the reader actually gets. */
const text = (markup) => markup.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

/**
 * The frozen hierarchy. Order is the requirement; styling is not.
 * Project context/health is the header, asserted separately because it is not a section.
 */
const ATTENTION_FIRST_ORDER = [
  "cc-section-needs-you",
  "cc-section-what-changed",
  "cc-section-in-progress",
  "cc-section-monitoring",
  "cc-section-ask-pmfreak",
];

// ───────────────────────── 1-2. the primary surface is attention ─────────────────────────

test("W2: Needs You is the first section of the Command Center's main canvas", () => {
  // The real screen, mounted the way the route mounts it.
  assert.equal(harness.screen.mainHasCanvas, true, "the attention canvas must be inside <main>");
  assert.equal(harness.screen.mainOrder[0], "cc-section-needs-you", "attention must open the main region");
  assert.equal(harness.screen.primarySurface, "NEEDS_YOU");
  // Project context/health precedes it; it is the header, not a competing section.
  assert.equal(harness.screen.headerBeforeCanvasBody, true);
});

test("W2: the conversation is the last section, and it does not open the viewport", () => {
  assert.equal(harness.screen.chatRole, "COPILOT");
  assert.equal(harness.screen.mainOrder.at(-1), "cc-section-ask-pmfreak");
  // Collapsed by default: the composer, its prompt suggestions and its disclosure are all
  // absent from the first paint. Chat is one click away, not the canvas.
  const collapsed = harness.canvas.askPmfreak;
  assert.doesNotMatch(collapsed, /<input\b/, "the chat composer must not render while collapsed");
  assert.doesNotMatch(collapsed, /chat-determinism-disclosure/);
  assert.match(text(collapsed), /Ask PMFreak about this project/);
  // ...and nothing was removed: expanding renders the real CommandFeed, disclosure and all.
  const expanded = harness.chatExpanded.askPmfreak;
  assert.match(expanded, /<input\b/);
  assert.match(expanded, /chat-determinism-disclosure/);
  assert.match(text(expanded), /answers are composed from your project data by deterministic rules/);
  // The transcript is not discarded by collapsing — the collapsed control says what it holds.
  assert.match(text(collapsed), /2 messages/);
});

// ───────────────────────── 3. what changed, from existing signals ────────────────────────

test("W2: What Changed renders the project's real signal rows", () => {
  const rendered = text(harness.canvas.whatChanged);
  const changes = harness.readModels.changes;
  assert.ok(changes.length > 0, "the fixture carries real signals");
  for (const change of changes) {
    assert.ok(rendered.includes(change.title), `"${change.title}" must be rendered`);
    if (change.detail) assert.ok(rendered.includes(change.detail), `the signal's own summary must be rendered`);
  }
});

test("W2: What Changed speaks PM language, never the canonical signal type or row id", () => {
  const rendered = text(harness.canvas.whatChanged);
  for (const signalType of SIGNAL_TYPES) {
    assert.ok(!rendered.includes(signalType), `raw canonical type "${signalType}" must not be shown to a PM`);
  }
  for (const change of harness.readModels.changes) {
    assert.ok(!rendered.includes(change.id), `signal id "${change.id}" must not be shown to a PM`);
  }
});

test("W2: the change display map covers the canonical vocabulary exactly — it does not extend it", () => {
  assert.deepEqual(Object.keys(SIGNAL_CHANGE_LABELS).sort(), [...SIGNAL_TYPES].sort());
});

test("W2: changes are deterministically ordered and each row is shown once", () => {
  const ids = harness.readModels.changes.map((c) => c.id);
  // Newest first; the undated row sorts last rather than being promoted to "now".
  assert.deepEqual(ids, ["sig-scope", "sig-schedule", "sig-cost", "sig-undated"]);
  assert.deepEqual(harness.readModels.changesRepeat, ids, "the same payload must render the same order");
  // Input order is not the output order — the sort is real, not incidental.
  assert.deepEqual(harness.readModels.changesFromReversedInput, ids);
  // The fixture delivers one canonical row twice; it is one change.
  assert.equal(new Set(ids).size, ids.length);
  assert.equal((harness.canvas.whatChanged.match(/cc-change-item/g) ?? []).length, ids.length);
});

test("W2: a signal with no persisted timestamp is shown without one, never with an invented one", () => {
  const undated = harness.readModels.changes.find((c) => c.id === "sig-undated");
  assert.ok(undated, "the undated fixture row must still be surfaced");
  assert.equal(undated.occurredAt, null);
  assert.equal(undated.whenLabel, null);
  // And no impact statement is attached to any row — the read model computes none.
  for (const change of harness.readModels.changes) {
    assert.deepEqual(Object.keys(change).sort(), ["detail", "id", "occurredAt", "severityLabel", "title", "tone", "whenLabel"]);
  }
});

// ───────────────────────── 4. in progress, from execution chains ─────────────────────────

test("W2: In Progress renders the governed chains that follow a recorded Decision", () => {
  const rendered = text(harness.canvas.inProgress);
  const chains = harness.readModels.chainIds;
  assert.ok(chains.length > 0, "the fixture carries a decided chain");
  for (const chain of chains) {
    assert.ok(rendered.includes(chain.title), `"${chain.title}" must be rendered`);
  }
  // The section is named for the PM, and the post-decision meaning is stated, not lost.
  assert.match(rendered, /^In Progress/);
  assert.match(rendered, /after your decisions/i);
});

// ───────────────────────── 5-6. monitoring, not a roster of personas ─────────────────────

test("W2: PMFreak Monitoring is the same state the specialist agents already derive", () => {
  const monitoring = harness.readModels.monitoring;
  const rendered = text(harness.canvas.monitoring);
  assert.equal(
    (harness.canvas.monitoring.match(/cc-monitoring-area/g) ?? []).length,
    monitoring.areas.length,
    "every monitored family is stated",
  );
  for (const area of monitoring.areas) {
    assert.ok(rendered.includes(area.label), `"${area.label}" coverage must be visible`);
  }
  // The total is counted, never characterised as "new" — nothing records what this PM has seen.
  assert.match(rendered, new RegExp(`${monitoring.totalSignals} signals detected`));
  assert.ok(!/\bnew signals?\b/i.test(rendered), "novelty would be invented");
});

test("W2: monitoring counts reconcile with the existing agent derivation, row for row", () => {
  // Proof that this is a second projection of state that already existed, not a new
  // intelligence: the count behind every coverage line is the count the specialist carries.
  const agentText = text(harness.canvas.monitoring);
  for (const area of harness.readModels.monitoring.areas) {
    assert.ok(agentText.includes(area.statusLabel), `"${area.statusLabel}" must be readable`);
  }
  assert.equal(
    harness.readModels.monitoring.areas.reduce((total, a) => total + a.signalCount, 0),
    harness.readModels.monitoring.totalSignals,
  );
});

test("W2: the specialist agents are not the default experience, and are not deleted", () => {
  const monitoringMarkup = harness.canvas.monitoring;
  const detailStart = monitoringMarkup.indexOf('data-testid="cc-monitoring-detail"');
  assert.ok(detailStart > 0, "the specialist roster must still exist, behind a disclosure");
  // Collapsed: `<details>` without `open`.
  const detailsTag = monitoringMarkup.slice(monitoringMarkup.lastIndexOf("<details", detailStart), detailStart + 80);
  assert.doesNotMatch(detailsTag, /\bopen\b/, "the roster must be collapsed by default");
  // Every agent name lives inside that disclosure and nowhere before it.
  for (const name of harness.readModels.agentNames) {
    const first = monitoringMarkup.indexOf(name);
    assert.ok(first > detailStart, `"${name}" must not appear before the collapsed disclosure`);
  }
  // And no agent name reaches the rest of the canvas at all.
  const beforeMonitoring = harness.canvas.populated.slice(0, harness.canvas.populated.indexOf('data-testid="cc-section-monitoring"'));
  for (const name of harness.readModels.agentNames) {
    assert.ok(!beforeMonitoring.includes(name), `"${name}" must not be part of the primary canvas`);
  }
});

// ───────────────────────── 7-8. desktop and mobile order ─────────────────────────────────

test("W2: the desktop Command Center is attention-first", () => {
  assert.deepEqual(harness.screen.mainOrder, ATTENTION_FIRST_ORDER);
  assert.deepEqual(harness.canvas.populatedOrder, ATTENTION_FIRST_ORDER);
  // The two-column desktop cockpit is CSS placement over this one tree, not a second tree.
  assert.match(canvasSrc, /xl:col-start-1 xl:row-start-1/);
  assert.match(canvasSrc, /xl:col-start-2 xl:row-start-1/);
});

test("W2: the mobile Command Center is the same order, and no attention content sits behind an overlay", () => {
  // One tree: the mobile order IS the document order, so a phone cannot end up with a
  // different priority than a desktop.
  assert.deepEqual(harness.screen.order, ATTENTION_FIRST_ORDER);
  // Each attention section is mounted exactly once — nothing is duplicated into a drawer.
  assert.equal(harness.screen.canvasCount, 1);
  assert.equal(harness.screen.needsYouCount, 1);
  // The right-hand overlay that used to hold Needs You / After Your Decision / the agent
  // dock is gone; project navigation may still be an overlay, attention may not.
  assert.doesNotMatch(layout, /MobileOverlay open=\{rightOpen\}/);
  assert.match(layout, /MobileOverlay open=\{leftOpen\}/);
});

// ───────────────────────── project header hierarchy ──────────────────────────────────────

test("W2: the header leads with the project's own name, its health and what is waiting", () => {
  const header = text(harness.canvas.header);
  assert.match(header, /^ERP Transformation/, "the human name comes first");
  assert.match(header, /1 needs your attention/);
  assert.match(header, /Updated 8 minutes ago/);
  assert.match(header, /Health: At Risk/);
  // The generated code is preserved for the surfaces that need it, below the name.
  assert.ok(header.includes("ERP-9F3A2"), "the identifier must not be deleted");
  assert.ok(
    header.indexOf("ERP Transformation") < header.indexOf("ERP-9F3A2"),
    "the generated project code must not outrank the project name",
  );
});

// ───────────────────────── 9-11. honest states ───────────────────────────────────────────

test("W2: an empty attention queue says so plainly, with real monitoring context", () => {
  const empty = harness.emptyAttention.needsYou;
  assert.match(empty, /You&#x27;re clear\./);
  assert.match(empty, /Nothing currently requires your decision or review\./);
  // The context beneath it is the real monitored families, not a reassurance.
  assert.match(empty, /PMFreak is still monitoring risks, schedule, scope, budget, stakeholders/);
  assert.deepEqual(harness.emptyAttention.order, ATTENTION_FIRST_ORDER, "the hierarchy does not change when clear");
});

test("W2: no signals means no changes, and no invented ones", () => {
  assert.match(harness.emptySignals.whatChanged, /No meaningful changes detected yet\./);
  assert.equal(harness.emptySignals.changeItemCount, 0);
  assert.deepEqual(harness.readModels.changesEmpty, []);
  assert.deepEqual(harness.readModels.changesUndefined, []);
});

test("W2: a project with no evidence yet says monitoring has not started, rather than 'all clear'", () => {
  assert.match(harness.noProjectData.monitoring, /Monitoring starts with your first project evidence\./);
  assert.match(harness.noProjectData.inProgress, /Nothing is in progress yet\./);
});

test("W2: a failed read is never rendered as a successful empty", () => {
  const { needsYou, whatChanged, monitoring, header } = harness.readFailed;
  for (const [name, body] of Object.entries({ needsYou, whatChanged, monitoring })) {
    assert.match(body, /We couldn&#x27;t load project attention\./, `${name} must state the failure`);
    assert.match(body, /Try again/, `${name} must offer a retry`);
  }
  // None of the "there is nothing" copy may appear on a read that never landed.
  assert.doesNotMatch(needsYou, /You&#x27;re clear\./);
  assert.doesNotMatch(whatChanged, /No meaningful changes detected yet\./);
  assert.doesNotMatch(monitoring, /signals detected/);
  // Nor may the roster be shown as universally "Clear" on the strength of a payload that
  // never arrived.
  assert.doesNotMatch(monitoring, /Risk Agent/);
  // And the header states no attention count at all rather than answering "0".
  assert.ok(!/needs? your attention/.test(header), "a failed read must not produce a count");
  assert.ok(!/Nothing needs your attention/.test(header));
});

// ───────────────────────── 12-14. nothing else moved ─────────────────────────────────────

test("W2: no internal certification vocabulary reached the new customer surfaces", () => {
  // The durable, repository-wide version of this guard is
  // tests/ux-w0-public-launch-blockers.test.mjs, which walks the customer import graph.
  // This is the W2-specific slice: the surfaces this workstream introduced.
  const PROHIBITED = ["AOC-E", "P2-06", "P2-09", "DEMO / FIXTURE"];
  const NEW_SURFACES = [
    "src/modules/workspace/presentation/command-center/command-center-canvas.tsx",
    "src/modules/workspace/presentation/command-center/what-changed-panel.tsx",
    "src/modules/workspace/presentation/command-center/monitoring-panel.tsx",
    "src/modules/workspace/presentation/command-center/ask-pmfreak-panel.tsx",
    "src/modules/workspace/presentation/command-center/change-read-model.ts",
  ];
  for (const file of NEW_SURFACES) {
    const rendered = read(file).replace(/\/\*[\s\S]*?\*\//g, "").split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
    for (const term of PROHIBITED) {
      assert.ok(!rendered.includes(term), `${file} must not put "${term}" in front of a customer`);
    }
  }
  // And the rendered Command Center itself carries none of it.
  const rendered = text(harness.canvas.populated);
  for (const term of PROHIBITED) assert.ok(!rendered.includes(term), `"${term}" must not be rendered`);
});

test("W2: the W1 four-item navigation contract is untouched", () => {
  assert.deepEqual(
    getPrimaryNavigation().map((n) => ({ label: n.label, href: n.href })),
    [
      { label: "Command Center", href: "/command-center" },
      { label: "Projects", href: "/projects" },
      { label: "Execution", href: "/execution" },
      { label: "Portfolio", href: "/portfolio" },
    ],
  );
});

test("W2: the canonical post-decision chain is unchanged — W2 moved it, it did not redesign it", () => {
  // The drawer still states the same six canonical steps, in the same order.
  const chainRows = [...layout.matchAll(/\blabel: "([^"]+)",\s+value:/g)].map((m) => m[1]);
  assert.deepEqual(chainRows, ["Decision", "Material action", "Task", "Execution", "Expected outcome", "Observation"]);
  // Canonical writes are still the only writes, and they still go through the same seams.
  assert.match(layout, /operation: "record_decision"/);
  assert.match(layout, /runExecutionOperation/);
  assert.match(layout, /postRaidActionDecision/);
  // Governed recommendations and RAID suggestions remain two collections with two write
  // paths — W2 changed placement, not the data model.
  assert.match(layout, /deriveNeedsYou\(flowData, handleDecide\)/);
  assert.match(layout, /deriveRaidNeedsYou\(raidActions, handleRaidDecide\)/);
});

test("W2: the new sections add no request of their own", () => {
  // Every W2 surface is a projection of the one operational summary the screen already
  // loads. A fetch, a SWR hook or an endpoint in any of them would mean W2 built
  // intelligence rather than recomposing it.
  for (const file of [
    "src/modules/workspace/presentation/command-center/change-read-model.ts",
    "src/modules/workspace/presentation/command-center/what-changed-panel.tsx",
    "src/modules/workspace/presentation/command-center/monitoring-panel.tsx",
    "src/modules/workspace/presentation/command-center/command-center-canvas.tsx",
  ]) {
    const src = read(file);
    assert.doesNotMatch(src, /\bfetch\(/, `${file} must not issue a request`);
    assert.doesNotMatch(src, /useSWR/, `${file} must not load its own data`);
    assert.doesNotMatch(src, /\/api\//, `${file} must not name an endpoint`);
  }
});

test("W2: the change projection is pure — the same payload and instant always give the same answer", () => {
  const payload = { signals: harness.readModels.changes.map((c) => ({ id: c.id, signal_type: "schedule_risk", severity: "high", summary: c.detail, created_at: c.occurredAt })) };
  const at = new Date("2026-09-06T12:00:00.000Z");
  assert.deepEqual(deriveWhatChanged(payload, at), deriveWhatChanged(payload, at));
});
