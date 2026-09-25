/**
 * UX-W2 — the Command Center is attention-first.
 *
 * Before W2 the Command Center answered "what would you like to type?": the chat feed
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
 *
 * CHAT-SHELL-01 — WHAT THIS FILE NOW PINS
 * ---------------------------------------
 * CHAT-SHELL-01 deliberately reversed W2's top-level claim. The project's primary
 * surface is now its Project Brain conversation, in the centre of the product shell;
 * the Command Center's sections are the TOOLS of the inspector beside it, and the
 * nested canvas, its top bar, its inner project sidebar and the collapsible Project
 * Brain panel are gone. Everything W2 established ABOUT those sections still holds and
 * is still asserted here against real renders — their honesty rules, their empty and
 * failed states, attention leading them — and the composition tests now pin the new
 * contract: conversation first, attention the first tool, nothing nested.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { SIGNAL_TYPES } from "../src/lib/operational-flow/types.ts";
import { SIGNAL_CHANGE_LABELS, deriveWhatChanged } from "../src/modules/workspace/presentation/command-center/change-read-model.ts";
import { assessAttentionCompleteness } from "../src/modules/workspace/presentation/command-center/attention-completeness.ts";
import { ACTIVITY_TIMESTAMP_FIELDS, ACTIVITY_COLLECTIONS } from "../src/modules/workspace/presentation/command-center/activity-read-model.ts";
import { getPrimaryNavigation } from "../src/lib/workspace/navigation-hierarchy.ts";

const read = (p) => readFileSync(p, "utf8");
const layout = read("src/modules/workspace/screens/command-center/command-center-layout.tsx");
const toolsSrc = read("src/components/pmfreak/conversation-shell/operational-tools.ts");
const viewSrc = read("src/components/pmfreak/conversation-shell/project-conversation-view.tsx");
const executionQueueSrc = read("src/modules/workspace/presentation/command-center/execution-queue.tsx");
const chainReadModel = read("src/modules/workspace/presentation/command-center/execution-read-model.ts");

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
 * The inspector's tool order for the four Command Center sections. Attention leads.
 * (Tasks, Schedule, Evidence and Project are tools too; they are not W2 sections.)
 */
const ATTENTION_FIRST_ORDER = [
  "cc-section-needs-you",
  "cc-section-what-changed",
  "cc-section-in-progress",
  "cc-section-monitoring",
];

// ───────────────────── 1-2. the primary surface (CHAT-SHELL-01) ─────────────────────

test("CHAT-SHELL-01: Project Brain is the project's primary surface, and Needs You leads the tools beside it", () => {
  const { closed } = harness.conversation;
  // The conversation is the centre: rendered once, in its full-surface layout, with its
  // composer in the centre region — not a panel in a canvas.
  assert.equal(closed.conversationInstances, 1);
  assert.equal(closed.conversationLayout, "surface");
  assert.equal(closed.composerInCenter, true);
  assert.equal(closed.composerInstances, 1);
  // No Command Center section competes for the centre.
  assert.deepEqual(closed.sectionsInCenter, []);
  // The tools sit beside it, attention first.
  assert.deepEqual(closed.railTools.slice(0, 3), ["attention", "activity", "execution"]);
  assert.equal(closed.inspectorHidden, true, "no tool steals the screen until asked for");
});

test("CHAT-SHELL-01: nothing of the nested Command Center application survives around the conversation", () => {
  for (const state of [harness.conversation.closed, harness.conversation.withAttention]) {
    assert.equal(state.hasCanvas, false, "no attention canvas");
    assert.equal(state.hasProjectBrainPanel, false, "no collapsible Project Brain panel");
    assert.equal(state.hasInnerProjectList, false, "no inner project sidebar — the shell's tree is the one selector");
    assert.equal(state.hasOwnShell, false, "no second application shell");
  }
  for (const removed of ["command-center-canvas", "project-sidebar", "project-top-bar", "project-brain-panel"]) {
    assert.equal(existsSync(`src/modules/workspace/presentation/command-center/${removed}.tsx`), false, `${removed} is gone`);
  }
});

// ───────────────────────── 3. what changed, from existing signals ────────────────────────

test("W2: What Changed renders the project's real signal rows", () => {
  const rendered = text(harness.tools.whatChanged);
  const changes = harness.readModels.changes;
  assert.ok(changes.length > 0, "the fixture carries real signals");
  for (const change of changes) {
    assert.ok(rendered.includes(change.title), `"${change.title}" must be rendered`);
    if (change.detail) assert.ok(rendered.includes(change.detail), `the signal's own summary must be rendered`);
  }
});

test("W2: What Changed speaks PM language, never the canonical signal type or row id", () => {
  const rendered = text(harness.tools.whatChanged);
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
  assert.equal((harness.tools.whatChanged.match(/cc-change-item/g) ?? []).length, ids.length);
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
  const rendered = text(harness.tools.inProgress);
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
  const rendered = text(harness.tools.monitoring);
  assert.equal(
    (harness.tools.monitoring.match(/cc-monitoring-area/g) ?? []).length,
    monitoring.areas.length,
    "every monitored family is stated",
  );
  for (const area of monitoring.areas) {
    assert.ok(rendered.includes(area.label), `"${area.label}" coverage must be visible`);
  }
  // The total is counted, never characterised as "new" — nothing records what this PM has seen.
  assert.match(rendered, new RegExp(`${monitoring.recentSignalCount} recent signals`));
  assert.ok(!/\bnew signals?\b/i.test(rendered), "novelty would be invented");
});

test("W2: monitoring counts reconcile with the existing agent derivation, row for row", () => {
  // Proof that this is a second projection of state that already existed, not a new
  // intelligence: the count behind every coverage line is the count the specialist carries.
  const agentText = text(harness.tools.monitoring);
  for (const area of harness.readModels.monitoring.areas) {
    assert.ok(agentText.includes(area.statusLabel), `"${area.statusLabel}" must be readable`);
  }
  assert.equal(
    harness.readModels.monitoring.areas.reduce((total, a) => total + a.recentSignalCount, 0),
    harness.readModels.monitoring.recentSignalCount,
  );
});

test("W2: the specialist agents are not the default experience, and are not deleted", () => {
  const monitoringMarkup = harness.tools.monitoring;
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
  // And no agent name reaches any other tool at all.
  const beforeMonitoring = harness.tools.populated.slice(0, harness.tools.populated.indexOf('data-testid="cc-section-monitoring"'));
  for (const name of harness.readModels.agentNames) {
    assert.ok(!beforeMonitoring.includes(name), `"${name}" must not be part of the attention tools`);
  }
});

// ───────────────────────── 7-8. desktop and mobile ────────────────────────────────────

test("W2: the desktop Command Center is attention-first", () => {
  // CHAT-SHELL-01: the sections are ordered tools; attention leads them.
  assert.deepEqual(harness.tools.populatedOrder, ATTENTION_FIRST_ORDER);
  const order = [...toolsSrc.matchAll(/key: "([a-z]+)", label:/g)].map((m) => m[1]);
  assert.deepEqual(order.slice(0, 3), ["attention", "activity", "execution"]);
  assert.ok(order.indexOf("monitoring") > order.indexOf("execution"));
  // Opening a tool puts it beside the conversation, which stays first in the document.
  const open = harness.conversation.withAttention;
  assert.equal(open.inspectorHidden, false);
  assert.equal(open.inspectorTool, "attention");
  assert.equal(open.operationsTool, "attention");
  assert.deepEqual(open.railPressed, ["attention"]);
  assert.equal(open.centerBeforeInspector, true);
});

test("W2: the mobile Command Center is the same order, and no attention content sits behind an overlay", () => {
  // CHAT-SHELL-01 changes the second half deliberately: on a phone the CONVERSATION
  // consumes the viewport and the tools open in a sheet — one tap, from the header's
  // Tools button, which opens Needs You by default. What is kept: ONE inspector element
  // at every width (inline on a wide screen, a sheet below), so nothing is duplicated
  // into a mobile copy with its own props, and every section is mounted once.
  assert.match(viewSrc, /md:hidden[\s\S]{0,40}>\s*Tools\s*</);
  assert.match(viewSrc, /switchTool\(lastOperationalTool \?\? "attention"\)/);
  const inspector = read("src/components/pmfreak/conversation-shell/operational-inspector.tsx");
  assert.equal((inspector.match(/<aside/g) ?? []).length, 1);
  assert.match(inspector, /xl:static/);
  for (const component of ["<NeedsYouQueue", "<WhatChangedPanel", "<ExecutionQueue", "<MonitoringPanel"]) {
    assert.equal((layout.match(new RegExp(component, "g")) ?? []).length, 1, `${component} is mounted once`);
  }
  // Below `md` the rail gives way to an in-sheet tool switcher, so every tool stays reachable.
  assert.match(inspector, /aria-label="Switch project tool"/);
});

// ───────────────────────── project header hierarchy ──────────────────────────────────────

test("W2: the header leads with the project's own name, its health and what is waiting", () => {
  // CHAT-SHELL-01: the conversation header is orientation, not analytics — ancestry, the
  // project's own name and its status. The attention count and freshness moved into the
  // tools that own them (Needs You states its own count; Evidence states freshness).
  const header = harness.conversation.closed.header;
  assert.match(header, /^Republika \/ Delivery PMO ERP Transformation active/);
  assert.doesNotMatch(header, /needs your attention|Health:|Updated /);
});

// ───────────────────────── 9-11. honest states ───────────────────────────────────────────

test("W2: an empty attention queue says so plainly, with real monitoring context", () => {
  const empty = harness.emptyAttention.needsYou;
  assert.match(empty, /You&#x27;re clear\./);
  assert.match(empty, /Nothing currently requires your decision or review\./);
  // The context beneath it is the real monitored families, not a reassurance.
  assert.match(empty, /PMFreak is still monitoring risks, schedule, scope, budget, stakeholders/);
  assert.deepEqual(harness.emptyAttention.order, ATTENTION_FIRST_ORDER, "the tool order does not change when clear");
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
  const { needsYou, whatChanged, monitoring, headingCount } = harness.readFailed;
  for (const [name, body] of Object.entries({ needsYou, whatChanged, monitoring })) {
    assert.match(body, /We couldn&#x27;t load project attention\./, `${name} must state the failure`);
    assert.match(body, /Try again/, `${name} must offer a retry`);
  }
  // None of the "there is nothing" copy may appear on a read that never landed.
  assert.doesNotMatch(needsYou, /You&#x27;re clear\./);
  assert.doesNotMatch(whatChanged, /No meaningful changes detected yet\./);
  assert.doesNotMatch(monitoring, /recent signals?/);
  // Nor may the roster be shown as universally "Clear" on the strength of a payload that
  // never arrived.
  assert.doesNotMatch(monitoring, /Risk Agent/);
  // And the queue states no attention count at all rather than answering "0".
  assert.equal(headingCount, null, "a failed read must not produce a count");
});

// ───────────────────────── 12-14. nothing else moved ─────────────────────────────────────

test("W2: no internal certification vocabulary reached the new customer surfaces", () => {
  // The durable, repository-wide version of this guard is
  // tests/ux-w0-public-launch-blockers.test.mjs, which walks the customer import graph.
  // This is the W2-specific slice: the surfaces this workstream introduced.
  const PROHIBITED = ["AOC-E", "P2-06", "P2-09", "DEMO / FIXTURE"];
  const NEW_SURFACES = [
    "src/modules/workspace/presentation/command-center/what-changed-panel.tsx",
    "src/modules/workspace/presentation/command-center/monitoring-panel.tsx",
    "src/modules/workspace/presentation/command-center/change-read-model.ts",
    // CHAT-SHELL-01's surfaces are held to the same rule.
    "src/components/pmfreak/conversation-shell/operational-tools.ts",
    "src/components/pmfreak/conversation-shell/operational-rail.tsx",
    "src/components/pmfreak/conversation-shell/operational-inspector.tsx",
    "src/components/pmfreak/conversation-shell/project-conversation-view.tsx",
    "src/components/pmfreak/conversation-shell/context-tree.tsx",
  ];
  for (const file of NEW_SURFACES) {
    const rendered = read(file).replace(/\/\*[\s\S]*?\*\//g, "").split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
    for (const term of PROHIBITED) {
      assert.ok(!rendered.includes(term), `${file} must not put "${term}" in front of a customer`);
    }
  }
  // And the rendered Command Center itself carries none of it.
  const rendered = text(harness.tools.populated);
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
  // CODEX-P2-01: the RAID derivation also receives the server-evaluated project write
  // capability. Two derivations, two handlers, two models — unchanged.
  assert.match(layout, /deriveRaidNeedsYou\(raidActions\?\.actions, handleRaidDecide, raidActions\?\.canDecide === true\)/);
});

test("W2: the new sections add no request of their own", () => {
  // Every W2 surface is a projection of the one operational summary the screen already
  // loads. A fetch, a SWR hook or an endpoint in any of them would mean W2 built
  // intelligence rather than recomposing it.
  for (const file of [
    "src/modules/workspace/presentation/command-center/change-read-model.ts",
    "src/modules/workspace/presentation/command-center/what-changed-panel.tsx",
    "src/modules/workspace/presentation/command-center/monitoring-panel.tsx",
    // CHAT-SHELL-01: the rail and inspector only choose which tool is visible.
    "src/components/pmfreak/conversation-shell/operational-rail.tsx",
    "src/components/pmfreak/conversation-shell/operational-inspector.tsx",
    "src/components/pmfreak/conversation-shell/operational-tools.ts",
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


// ═══════════════════════════════════════════════════════════════════════════════
// W2 REVIEW REMEDIATION — three honesty defects found on 6fea049f
// ═══════════════════════════════════════════════════════════════════════════════

// ───────── W2-P1-01: "In Progress" contains actual progress only ─────────────
//
// `buildExecutionChains` deliberately projects EVERY decided chain, terminal ones
// included, and that completeness is correct. The defect was the heading: rendering a
// rejected Decision, an achieved Outcome and a superseded Outcome under the word
// "In Progress" makes the list say something false even though each badge is right.
//
// The original W2 fixture held one live chain, which is precisely the case that cannot
// expose this. These run against six chains — one per canonical outcome of the projection.

/** What each fixture chain is, by canonical status label. */
const CHAIN_EXPECTATIONS = [
  { decisionId: "dec-live", statusLabel: "In progress", group: "in_progress" },
  { decisionId: "dec-noaction", statusLabel: "No action yet", group: "not_progressing" },
  { decisionId: "dec-expired", statusLabel: "Authorization expired", group: "not_progressing" },
  { decisionId: "dec-rejected", statusLabel: "Decision rejected", group: "closed" },
  { decisionId: "dec-achieved", statusLabel: "Outcome achieved", group: "closed" },
  { decisionId: "dec-superseded", statusLabel: "Outcome superseded", group: "closed" },
  // One Decision, two Actions: one achieved, one still running. The chain is not finished.
  { decisionId: "dec-mixed", statusLabel: "Outcome achieved", group: "in_progress" },
  // One Decision, two Actions, both terminal. Nothing is moving anywhere.
  { decisionId: "dec-allterminal", statusLabel: "Outcome achieved", group: "closed" },
];

test("W2-P1-01: the fixture really does exercise every canonical chain outcome", () => {
  // Without this the rest of the section could pass vacuously against chains that never
  // reached the states in question.
  assert.deepEqual(
    harness.chainProgress.statuses.map((entry) => ({
      decisionId: entry.decisionId,
      statusLabel: entry.statusLabel,
      group: entry.group,
    })),
    CHAIN_EXPECTATIONS,
  );
});

test("W2-P1-01: no terminal or stopped chain is rendered as work in progress", () => {
  const rendered = harness.chainProgress.rendered;
  assert.deepEqual(rendered.inProgressTitles, ["LIVE work under way", "MIXED achieved and running"]);
  for (const terminal of ["REJECTED decision", "ACHIEVED outcome", "SUPERSEDED outcome"]) {
    assert.ok(!rendered.inProgressTitles.includes(terminal), `"${terminal}" must not be shown as in progress`);
  }
  // The count beside the heading counts the heading's own claim, not the section.
  assert.equal(rendered.headingCount, String(rendered.inProgressTitles.length));
});

test("W2-P1-01: the four non-live states are decided explicitly, not called progress", () => {
  // A Decision is not work, and an Action nothing may be dispatched against is not work
  // continuing. Both are open loops, so neither is buried with the terminal chains either.
  assert.deepEqual(harness.chainProgress.groups.notProgressing, ["dec-noaction", "dec-expired"]);
  assert.deepEqual(harness.chainProgress.rendered.notProgressingTitles, [
    "DECIDED with no action",
    "EXPIRED authorization",
  ]);
  // Expanded, not collapsed: requesting the first governed Action, or a replacement after
  // an authorization lapsed, is the PM's next move and this row is how they reach it.
  assert.equal(harness.chainProgress.rendered.notProgressingGroupPresent, true);
  assert.match(harness.chainProgress.rendered.markup, /Not progressing/);
});

test("W2-P1-01: terminal chains are preserved and reachable, behind a collapsed disclosure", () => {
  assert.deepEqual(harness.chainProgress.groups.closed, ["dec-rejected", "dec-achieved", "dec-superseded", "dec-allterminal"]);
  assert.deepEqual(harness.chainProgress.rendered.closedTitles, [
    "REJECTED decision",
    "ACHIEVED outcome",
    "SUPERSEDED outcome",
    "ALL BRANCHES terminal",
  ]);
  // Hiding them would be its own dishonesty; they are one click away, and closed by default.
  const tag = harness.chainProgress.rendered.closedDetailsTag;
  assert.ok(tag, "the closed disclosure must exist");
  assert.doesNotMatch(tag.slice(0, tag.indexOf(">")), /\bopen\b/, "closed chains must not be expanded by default");
  assert.match(harness.chainProgress.rendered.markup, /Closed \(4\)/);
});

test("W2-P1-01: every chain lands in exactly one group — the projection drops nothing", () => {
  const { inProgress, notProgressing, closed } = harness.chainProgress.groups;
  const all = [...inProgress, ...notProgressing, ...closed];
  assert.equal(all.length, harness.chainProgress.statuses.length);
  assert.equal(new Set(all).size, all.length, "no chain may appear in two groups");
  assert.deepEqual([...all].sort(), harness.chainProgress.statuses.map((s) => s.decisionId).sort());
});

test("W2-P1-01: grouping is decided by canonical branch facts, across ALL branches", () => {
  // The invariant, stated against the read model's own predicates rather than against the
  // selector's output: a chain is in progress exactly when some branch is live and not
  // itself terminal, and its Decision was not rejected.
  for (const entry of harness.chainProgress.statuses) {
    const shouldProgress = entry.decisionId !== "dec-rejected" && entry.progressingBranches > 0;
    assert.equal(entry.group === "in_progress", shouldProgress, `${entry.decisionId}: grouping must follow branch facts`);
  }
});

test("W2-P1-01: a single-branch chain still reconciles with the canonical status label", () => {
  // For one branch the chain reading and the branch reading are the same question, so the
  // two must still agree exactly. This is the guarantee the original W2 fixture proved, and
  // the mixed-chain fix does not weaken it.
  for (const entry of harness.chainProgress.statuses.filter((e) => e.branchCount <= 1)) {
    assert.equal(
      entry.group === "in_progress",
      entry.statusLabel === "In progress",
      `${entry.decisionId}: single-branch grouping and canonical status must agree`,
    );
  }
});

test("W2-P1-01: a mixed multi-action chain stays In Progress while any branch is still running", () => {
  const mixed = harness.chainProgress.statuses.find((e) => e.decisionId === "dec-mixed");
  assert.ok(mixed, "the mixed fixture must exist");
  // The fixture is genuinely mixed — otherwise this would pass for the wrong reason.
  assert.equal(mixed.branchCount, 2);
  assert.equal(mixed.achievedBranches, 1, "one branch really did achieve its Outcome");
  assert.equal(mixed.progressingBranches, 1, "another branch really is still running");
  // One finished branch does not finish the Decision.
  assert.equal(mixed.group, "in_progress");
  assert.ok(harness.chainProgress.rendered.inProgressTitles.includes("MIXED achieved and running"));
  assert.ok(!harness.chainProgress.rendered.closedTitles.includes("MIXED achieved and running"));
  assert.ok(!harness.chainProgress.groups.closed.includes("dec-mixed"));
  // The canonical status is untouched: the chain still reads "Outcome achieved", because a
  // branch did. Only the GROUP heading changed, which is what the finding was about.
  assert.equal(mixed.statusLabel, "Outcome achieved");
});

test("W2-P1-01: a multi-action chain whose branches are ALL terminal is closed", () => {
  // The companion case: the fix must not make every multi-action Decision permanently live.
  const all = harness.chainProgress.statuses.find((e) => e.decisionId === "dec-allterminal");
  assert.ok(all, "the all-terminal fixture must exist");
  assert.equal(all.branchCount, 2);
  assert.equal(all.progressingBranches, 0);
  assert.equal(all.group, "closed");
  assert.ok(harness.chainProgress.rendered.closedTitles.includes("ALL BRANCHES terminal"));
  assert.ok(!harness.chainProgress.rendered.inProgressTitles.includes("ALL BRANCHES terminal"));
  // And it is discriminating: `isBranchLive` alone is TRUE for its achieved branch, so a
  // naive "any live branch means in progress" would have mis-grouped this one.
  assert.ok(all.liveBranches > 0, "isBranchLive alone would have called this chain live");
});

test("W2-P1-01: the canonical execution read model is untouched", () => {
  // The fix is a selector over the projection, not a change to it: every decided chain,
  // terminal ones included, is still projected.
  assert.equal(harness.chainProgress.statuses.length, 8, "every decided chain is still projected");
  // Rejected Decisions are still built (the read model's own comment commits to this).
  assert.match(chainReadModel, /Rejected\s*\n?\s*\*\s*Decisions ARE included/);
  // The queue derives its groups; it does not filter by reading a display string.
  assert.match(executionQueueSrc, /projectChainProgress\(chains\)/);
  assert.doesNotMatch(executionQueueSrc, /status\.label ===/);
});

// ───────── W2-P1-02: attention completeness spans BOTH sources ────────────────
//
// "Needs your attention" is fed by two independent reads. The screen used to decide the
// whole section's state from the operational flow alone, so a still-loading or failed
// suggestion read could be reported as "You're clear."

test("W2-P1-02: completeness requires every attention source, not the first one", () => {
  const governed = { label: "governed recommendations", loading: false, failed: false };
  assert.equal(assessAttentionCompleteness([governed, { label: "suggested actions", loading: true, failed: false }]).complete, false);
  assert.equal(assessAttentionCompleteness([governed, { label: "suggested actions", loading: false, failed: true }]).complete, false);
  assert.equal(assessAttentionCompleteness([governed, { label: "suggested actions", loading: false, failed: false }]).complete, true);
  // A failure is reported as a failure, never as "still loading".
  const failed = assessAttentionCompleteness([governed, { label: "suggested actions", loading: false, failed: true }]);
  assert.equal(failed.failed, true);
  assert.equal(failed.loading, false);
  assert.deepEqual(failed.unresolved, ["suggested actions"]);
});

test("W2-P1-02 (A): zero governed items with suggestions still loading is not 'You're clear'", () => {
  const { completeness, needsYou, headingCount } = harness.attentionCompleteness.raidLoading;
  assert.equal(completeness.complete, false);
  assert.doesNotMatch(needsYou, /You&#x27;re clear\./);
  assert.match(needsYou, /Checking what needs your attention/);
  // No definitive count while an attention source is unresolved.
  assert.equal(headingCount, null);
});

test("W2-P1-02 (B): a failed suggestion read is a visible failure, not an empty success", () => {
  const { completeness, needsYou, headingCount } = harness.attentionCompleteness.raidFailed;
  assert.equal(completeness.failed, true);
  assert.match(needsYou, /We couldn&#x27;t load project attention\./);
  assert.match(needsYou, /Try again/);
  assert.doesNotMatch(needsYou, /You&#x27;re clear\./);
  assert.equal(headingCount, null);
});

test("W2-P1-02 (C): known governed items stay visible while suggestions are still loading", () => {
  const { needsYou, headingCount } = harness.attentionCompleteness.governedKnownRaidLoading;
  // Hiding real attention would be its own dishonesty.
  assert.match(needsYou, /Agree a replan for the delayed milestone/);
  // ...but the list says it is not the whole answer, and states no count.
  assert.match(needsYou, /Still checking suggested actions\./);
  assert.match(needsYou, /data-testid="cc-attention-incomplete"/);
  assert.equal(headingCount, null);
});

test("W2-P1-02 (D): only when both sources resolve may the product say 'You're clear'", () => {
  const { completeness, needsYou } = harness.attentionCompleteness.bothComplete;
  assert.equal(completeness.complete, true);
  assert.match(needsYou, /You&#x27;re clear\./);
});

test("W2-P1-02: the screen binds completeness to both reads, and merges neither model", () => {
  assert.match(layout, /const \{ data: raidActions, error: raidError, mutate: mutateRaidActions \}/);
  assert.match(layout, /const raidLoading = Boolean\(selectedProject\?\.id\) && raidActions === undefined && !raidError;/);
  // UX-W3 added a third fact to the governed source: a request that finished may still have
  // returned less than the project holds, proven against `assurance.openRecommendations`.
  // The binding is otherwise unchanged.
  assert.match(layout, /\{ label: "governed recommendations", loading: flowLoading, failed: Boolean\(flowError\), partial: governedAttentionPartial \}/);
  // CODEX-P2-05: absence of proof is not proof. Only an explicit `true` authorises a
  // definitive count or a clear state; an optional/absent field is partial, never complete.
  assert.match(layout, /const governedAttentionPartial = flowData !== undefined && flowData\.governedAttentionComplete !== true;/);
  assert.match(layout, /\{ label: "suggested actions", loading: raidLoading, failed: Boolean\(raidError\) \}/);
  assert.match(layout, /const attentionErrorMessage = attention\.failed \? "We couldn't load project attention\." : null;/);
  // The two collections stay distinct business objects with distinct write paths.
  assert.deepEqual(harness.attentionCompleteness.raidItemsAreStillTheirOwnKind, ["raid_suggestion"]);
  assert.match(layout, /deriveNeedsYou\(flowData, handleDecide\)/);
  // CODEX-P2-01: the RAID derivation also receives the server-evaluated project write
  // capability. Two derivations, two handlers, two models — unchanged.
  assert.match(layout, /deriveRaidNeedsYou\(raidActions\?\.actions, handleRaidDecide, raidActions\?\.canDecide === true\)/);
});

test("W2-P1-02: a suggestion failure does not make the activity sections claim they failed", () => {
  // What changed / In Progress / Monitoring read only the operational flow, so they must
  // not inherit an attention-only failure.
  assert.match(layout, /const activityErrorMessage = flowError \? "We couldn't load project attention\." : null;/);
  // CHAT-SHELL-01: bound directly on the tools that read them.
  assert.match(layout, /<WhatChangedPanel items=\{changes\} loading=\{flowLoading\} errorMessage=\{activityErrorMessage\}/);
  assert.match(layout, /errorMessage=\{activityErrorMessage\}\s*\n\s*onRetry=\{retryAll\}\s*\n\s*onAddContext/);
  assert.match(layout, /loading=\{attention\.loading\}/);
});

// ───────── W2-P1-03: header freshness reads real activity ────────────────────

test("W2-P1-03: freshness resolves from the newest activity, including everything downstream of a Decision", () => {
  // Evidence and the Decision are a day old; an execution completed five minutes ago and
  // an Observation was recorded two minutes ago. The header must say two minutes.
  assert.equal(harness.headerFreshness.downstreamLatest, "2026-09-06T11:58:00.000Z");
  assert.equal(harness.headerFreshness.downstreamLabel, "2 minutes ago");
  assert.match(harness.headerFreshness.renderedHeader, /Updated 2 minutes ago/);
});

test("W2-P1-03: the derivation reads every record collection, and no deadline field", () => {
  for (const collection of ["materialActions", "materialActionEvaluations", "tasks", "executions", "outcomes", "observations"]) {
    assert.ok(ACTIVITY_COLLECTIONS.includes(collection), `${collection} must contribute to freshness`);
  }
  for (const field of ["completed_at", "recorded_at", "observed_at", "evaluated_at", "last_transition_at"]) {
    assert.ok(ACTIVITY_TIMESTAMP_FIELDS.includes(field), `${field} records something that happened`);
  }
  // Deadlines are in the future. Reading them would date the project forward.
  for (const deadline of ["expires_at", "valid_until", "stale_at", "due_date", "deferred_until"]) {
    assert.ok(!ACTIVITY_TIMESTAMP_FIELDS.includes(deadline), `${deadline} is a deadline, not activity`);
  }
  // `observationEligibleEvidence` re-projects rows already counted through `evidence`.
  assert.ok(!ACTIVITY_COLLECTIONS.includes("observationEligibleEvidence"));
});

test("W2-P1-03: a captured Raw Input is activity, before anything downstream of it exists", () => {
  // `operational_raw_inputs` carries no `created_at`/`updated_at`. `captured_at` is its
  // persisted activity timestamp — the column `load_operational_summary` orders that query
  // by — so without it a capture stayed invisible to the header until it had produced a
  // Normalized Event and Evidence. Everything else in this fixture is a day old.
  assert.equal(harness.headerFreshness.rawInputCaptureLatest, "2026-09-06T11:58:00.000Z");
  assert.equal(harness.headerFreshness.rawInputCaptureLabel, "2 minutes ago");
  assert.match(harness.headerFreshness.rawInputCaptureHeader, /Updated 2 minutes ago/);
  assert.ok(ACTIVITY_TIMESTAMP_FIELDS.includes("captured_at"));
  // The fixture's `occurred_at` is a day old on purpose: when the event happened in the
  // world is a different fact from when PMFreak captured it, so reading only `occurred_at`
  // would still answer "yesterday". This is what makes the test discriminating.
  assert.notEqual(harness.headerFreshness.rawInputCaptureLatest, "2026-09-05T09:00:00.000Z");
});

test("W2-P1-03: a capture dated after the authoritative instant is ignored like any other future value", () => {
  assert.equal(harness.headerFreshness.futureCaptureLatest, null);
});

test("W2-P1-03: the allowlist was audited against the summary's own tables", () => {
  // Two columns look like omissions and are not: both are written in the SAME statement as
  // `updated_at = now()`, which is already read, so neither can carry activity this list
  // misses. Recorded as assertions so a future widening has to argue with them.
  const evidenceLoop = read("supabase/migrations/20260611000000_operational_evidence_decision_loop.sql");
  assert.match(evidenceLoop, /set frozen_at = coalesce\(frozen_at, now\(\)\), updated_at = now\(\)/);
  const raidDecision = read("src/lib/recommended-actions/decision-workflow.ts");
  assert.match(raidDecision, /decided_at: now,[\s\S]{0,120}updated_at: now,/);
  assert.ok(!ACTIVITY_TIMESTAMP_FIELDS.includes("frozen_at"));
  assert.ok(!ACTIVITY_TIMESTAMP_FIELDS.includes("decided_at"));
  // And the collection whose activity column this fix added is still read by that column
  // in the authoritative loader — the reason `captured_at` belongs here at all.
  const service = read("src/lib/operational-flow/operational-flow-service.ts");
  assert.match(service, /from\("operational_raw_inputs"\)[\s\S]{0,200}order\("captured_at"/);
});

test("W2-P1-03: absent, unparseable and future timestamps never become 'now'", () => {
  assert.equal(harness.headerFreshness.unusableLatest, null);
  assert.equal(harness.headerFreshness.unusableLabel, null);
  // A human-entered `observed_at` in the future is not an answer to "when was this updated".
  assert.equal(harness.headerFreshness.futureOnlyLatest, null);
});

test("W2-P1-03: the summary's fetch time is not reported as project activity", () => {
  // `generatedAt` is set on this fixture and every collection is empty. If fetch time were
  // being read, this would return a timestamp instead of null.
  assert.equal(harness.headerFreshness.fetchedButEmptyLatest, null);
  // `generatedAt` IS read — as the ceiling that decides what counts as already-happened, and
  // as the baseline "ago" is measured from (see the Codex clock-skew fix below). What it must
  // never be is a RECORD of project activity, and the collection list is where that is
  // decided: no summary metadata appears in it, so no scan can ever reach the field.
  assert.ok(!ACTIVITY_COLLECTIONS.includes("generatedAt"));
  assert.ok(!ACTIVITY_COLLECTIONS.includes("assurance"));
  assert.ok(!ACTIVITY_TIMESTAMP_FIELDS.includes("generatedAt"));
  assert.ok(!ACTIVITY_TIMESTAMP_FIELDS.includes("asOf"));
  // The screen no longer carries its own three-collection freshness helper.
  assert.doesNotMatch(layout, /function deriveLastUpdatedLabel/);
  assert.match(layout, /deriveLastUpdatedLabel\(flowData\)/);
});


// ───────── Codex P2 (carried into CHAT-SHELL-01): an unsent draft survives ─────────
//
// W2's Codex finding was that collapsing the Project Brain PANEL unmounted the
// conversation and threw the draft away. CHAT-SHELL-01 removed the panel: the
// conversation is never collapsed, and the thing that opens and closes is the tool
// inspector beside it. The property still has to hold for THAT interaction — a draft is
// the conversation's local state, and it survives exactly as long as the conversation
// stays the same element in the same place. These read real markup from both states.

test("W2-CODEX: the conversation is rendered in both states, so collapsing cannot unmount it", () => {
  const { closed, withAttention } = harness.conversation;
  for (const [state, shape] of Object.entries({ closed, withAttention })) {
    assert.equal(shape.conversationInstances, 1, `${state}: the conversation must be rendered`);
    assert.equal(shape.composerInCenter, true, `${state}: the composer must sit in the centre`);
  }
  // The conversation is byte-for-byte identical whether a tool is open or not: the
  // inspector is a SIBLING, so React reconciles the conversation as the same instance.
  // (Only the header's Tools button differs — it reports the inspector's state.)
  assert.ok(closed.conversation.length > 0);
  assert.equal(closed.conversation, withAttention.conversation);
});

test("W2-CODEX: a collapsed conversation is hidden, not merely invisible", () => {
  // Now it is the closed INSPECTOR that must be hidden rather than transparent — out of
  // the layout, the tab order and the accessibility tree — and the conversation that is
  // never hidden at all.
  assert.equal(harness.conversation.closed.inspectorHidden, true);
  assert.equal(harness.conversation.withAttention.inspectorHidden, false);
  assert.doesNotMatch(harness.conversation.closed.center, /\shidden\b/);
  const inspectorSrc = read("src/components/pmfreak/conversation-shell/operational-inspector.tsx");
  assert.match(inspectorSrc, /hidden=\{!open\}/);
});

test("W2-CODEX: there is exactly one conversation instance, in both states", () => {
  assert.equal(harness.conversation.closed.composerInstances, 1);
  assert.equal(harness.conversation.withAttention.composerInstances, 1);
  // Opening a tool mounts the tool, never a second conversation.
  assert.equal(harness.conversation.withAttention.conversationInstances, 1);
});

test("W2-CODEX: collapsing is presentation only — it sends nothing and owns no message state", () => {
  // Choosing, switching or closing a tool is local presentational state — no request,
  // no router navigation, no message state — so it cannot send or drop a turn.
  const toolHandlers = viewSrc.slice(viewSrc.indexOf("const selectTool"), viewSrc.indexOf("const operationalTool"));
  assert.doesNotMatch(toolHandlers, /fetch\(|router\.|useRouter|messages/);
  // It may drop the `?tool=` hint from the address bar, in place, without navigating.
  assert.match(viewSrc, /window\.history\.replaceState\(/);
});

// ───────── Codex P2: the future-activity ceiling is the SERVER's clock ────────
//
// W2 added the future-timestamp guard but the caller handed it `projectionNow`, which is
// floored on the browser's clock. A browser running fast therefore moved the accepted
// ceiling forward and let through timestamps the server considers future.

test("W2-CODEX: the activity ceiling comes from the server, not the browser", () => {
  const skew = harness.clockSkew;
  assert.equal(skew.serverCeiling, skew.serverGeneratedAt, "the ceiling is the server's own reading");
  assert.notEqual(skew.serverGeneratedAt, skew.clientClock, "the fixture really is skewed");
});

test("W2-CODEX: an observation the server calls future is rejected even on a fast browser", () => {
  // Server 12:00, browser 12:10, observed 12:07. Past to the browser, future to the server.
  const skew = harness.clockSkew;
  assert.notEqual(skew.futureToServerLatest, "2026-09-07T12:07:00.000Z", "a future observation must not be activity");
  // It falls back to the genuinely older record instead.
  assert.equal(skew.futureToServerLatest, "2026-09-06T12:00:00.000Z");
  assert.equal(skew.futureToServerLabel, "1 day ago");
});

test("W2-CODEX: a genuinely past observation is accepted, and its age is server-measured", () => {
  const skew = harness.clockSkew;
  assert.equal(skew.pastLatest, "2026-09-07T11:58:00.000Z");
  // Measured from the server's 12:00, not the browser's 12:10 — otherwise this would read
  // "12 minutes ago" and the header would age the project by the local clock's error.
  assert.equal(skew.pastLabel, "2 minutes ago");
  assert.match(skew.pastHeader, /Updated 2 minutes ago/);
});

test("W2-CODEX: with no trustworthy server anchor, no freshness claim is made at all", () => {
  // Substituting `new Date()` here would keep the label alive by dropping the guarantee it
  // depends on. Refusing to answer is the honest failure.
  const skew = harness.clockSkew;
  assert.equal(skew.noAnchorCeiling, null);
  assert.equal(skew.noAnchorLatest, null);
  assert.equal(skew.noAnchorLabel, null);
  const activitySrc = read("src/modules/workspace/presentation/command-center/activity-read-model.ts");
  const code = activitySrc.replace(/\/\*[\s\S]*?\*\//g, "").split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
  assert.doesNotMatch(code, /new Date\(\)/, "no clock may be read in this module");
  assert.doesNotMatch(code, /Date\.now\(\)/);
  // And the screen no longer hands it the client-floored projection clock.
  assert.match(layout, /deriveLastUpdatedLabel\(flowData\)/);
  assert.doesNotMatch(layout, /deriveLastUpdatedLabel\(flowData, projectionNow\)/);
});

// ───────── Codex P2: monitoring describes the window it actually read ────────
//
// `data.signals` is the newest-first presentation window the summary loads, not the whole
// project history. Per-area zero therefore means "none in the window", and the surface
// used to render it as "Clear" — a claim about the project it has no basis for.

/**
 * Everything derived from `data.signals` — the coverage list and the seven signal-family
 * specialists. Deliberately NOT the Dependency and Portfolio agents, which read the
 * project-wide `assurance` aggregate from `get_operational_assurance_summary` rather than
 * the window, and may therefore still speak in absolutes. That distinction is the whole
 * point of the finding, so the test draws it rather than banning a word everywhere.
 */
const windowedMonitoringText = (body) => body.slice(0, body.indexOf("Dependency Agent"));

test("W2-CODEX: no window-derived monitoring state is described as project-wide 'Clear'", () => {
  const monitoring = harness.monitoringWindow;
  for (const body of [monitoring.panelText, monitoring.emptyWindowPanelText]) {
    const windowed = windowedMonitoringText(body);
    assert.ok(windowed.length > 0, "the windowed portion must be found");
    assert.ok(!/\bClear\b/.test(windowed), `"Clear" overstates a bounded read: ${windowed.slice(0, 140)}`);
  }
  // Zero areas say what is true instead.
  const zeroAreas = monitoring.summary.areas.filter((area) => area.recentSignalCount === 0);
  assert.ok(zeroAreas.length > 0, "the fixture must contain an area with no signals in the window");
  for (const area of zeroAreas) assert.equal(area.statusLabel, "No recent signals");
});

test("W2-CODEX: the one remaining absolute is backed by a project-wide aggregate, not the window", () => {
  // Dependency Agent reads `assurance.incompleteChainCount`, which the server computes over
  // the whole project. It is allowed to say "Clear" precisely because it is not windowed.
  const operationalData = read("src/modules/workspace/presentation/command-center/operational-data.ts");
  const dependency = operationalData.slice(operationalData.indexOf("const dependencyAgent"));
  assert.match(dependency, /incompleteChains/);
  assert.match(operationalData, /const incompleteChains = assurance\?\.incompleteChainCount \?\? 0;/);
  // And it is not derived from `signalSlice`, which is the windowed reader.
  assert.doesNotMatch(dependency.slice(0, dependency.indexOf("};")), /signalSlice/);
});

test("W2-CODEX: monitoring counts are presented as recent activity, never as totals", () => {
  const monitoring = harness.monitoringWindow;
  assert.equal(monitoring.summary.windowed, true, "the read model states its own scope");
  assert.match(monitoring.panelText, /5 recent signals/);
  assert.ok(!/total/i.test(monitoring.panelText), "the window is not a total");
  assert.ok(!/detected/i.test(monitoring.panelText), "'detected' implied completeness");
  // The scope is disclosed rather than left to be inferred...
  assert.equal(monitoring.scopeNotePresent, true);
  assert.match(monitoring.panelText, /Based on the most recent signal activity available in this view/);
  // ...without inventing a row limit. The loader's cap is not a shared constant, so no
  // figure may be stated for it.
  assert.ok(!/\b30\b/.test(monitoring.panelText), "no invented window size");
});

test("W2-CODEX: an empty window says so, rather than saying the project is clear", () => {
  const body = harness.monitoringWindow.emptyWindowPanelText;
  assert.match(body, /No recent signals in this view/);
  assert.ok(!/\bClear\b/.test(windowedMonitoringText(body)));
  assert.equal(harness.monitoringWindow.emptyWindowSummary.recentSignalCount, 0);
});

test("W2-CODEX: the specialist roster inherits the same scope, and stays collapsible", () => {
  // It reads the same window through the same `signalSlice`, so it cannot claim more.
  const body = harness.monitoringWindow.panelText;
  assert.ok(!/\bClear\b/.test(windowedMonitoringText(body)));
  assert.match(body, /recent signal/);
  assert.match(harness.tools.monitoring, /data-testid="cc-monitoring-detail"/);
  assert.match(harness.tools.monitoring, /View monitors/);
});

test("W2-CODEX: no server-side aggregate was added to close the window gap", () => {
  // The honest fix was to describe what is read, not to build new intelligence.
  const operationalData = read("src/modules/workspace/presentation/command-center/operational-data.ts");
  assert.match(operationalData, /export function deriveMonitoring/);
  const monitoringSlice = operationalData.slice(operationalData.indexOf("export function deriveMonitoring"));
  assert.doesNotMatch(monitoringSlice, /fetch\(|useSWR|\/api\//, "monitoring must not gain a read of its own");
  const service = read("src/lib/operational-flow/operational-flow-service.ts");
  assert.match(service, /from\("operational_signals"\)[\s\S]{0,200}limit\(30\)/, "the loader is unchanged");
});
