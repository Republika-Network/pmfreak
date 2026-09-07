/**
 * UX-W3 — Needs You interaction quality.
 *
 * W2 made attention the Command Center's primary surface. It did not make an individual
 * attention item understandable: a card was a title and a badge reading "Governed ·
 * decision required", and the drawer led with a seven-row canonical lifecycle table,
 * provenance, evidence quality and an authority requirement before it ever asked the PM
 * what they thought.
 *
 * W3's job is one sentence: a PM should know what is being asked of them, why it matters,
 * what PMFreak recommends and what happens if they agree — without knowing PMFreak's
 * governance architecture, canonical vocabulary or data model.
 *
 * Nothing beneath the presentation moves. The two attention sources keep their own models,
 * their own write paths and their own authority language; every canonical detail is still
 * rendered, just after the judgment rather than in front of it. These assertions run
 * against REAL renders through the REAL read models, because whether a card can be
 * understood is a rendering question and source reading cannot answer it.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import {
  APPROVAL_ITEMS_AVAILABLE,
  HUMAN_JOB_GROUP_LABELS,
  groupAttentionItems,
} from "../src/modules/workspace/presentation/command-center/attention-presentation.ts";
import {
  DECISION_OPTIONS,
  TERMINAL_DECISION_STATUSES,
} from "../src/modules/workspace/presentation/command-center/attention-read-model.ts";

const read = (p) => readFileSync(p, "utf8");
const operationalData = read("src/modules/workspace/presentation/command-center/operational-data.ts");
const layout = read("src/modules/workspace/screens/command-center/command-center-layout.tsx");
const cardSrc = read("src/modules/workspace/presentation/command-center/attention-card.tsx");

const harness = JSON.parse(
  execFileSync(process.execPath, ["node_modules/tsx/dist/cli.mjs", "tests/ux-w3-needs-you-harness.tsx"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
    maxBuffer: 64 * 1024 * 1024,
  }),
);

/** Everything a card or drawer shows before the collapsed governance detail begins. */
function primarySurface(markup) {
  const at = markup.indexOf("Evidence &amp; governance");
  const body = at < 0 ? markup : markup.slice(0, at);
  return body.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

// ───────────────────────────── W3-A: human attention taxonomy ────────────────

test("W3-A: the fixture really exercises more than one human job and more than one source", () => {
  // Without this the taxonomy assertions below could pass against a single happy item.
  const all = harness.items.all;
  assert.ok(all.length >= 4, "several items");
  assert.deepEqual([...new Set(all.map((i) => i.humanJob))].sort(), ["decision", "review"]);
  assert.deepEqual([...new Set(all.map((i) => i.kind))].sort(), ["governed_recommendation", "raid_suggestion"]);
  // ...and one group genuinely holds more than one card.
  const decisions = harness.grouping.all.find((g) => g.job === "decision");
  assert.ok(decisions.ids.length > 1, "more than one item in a group");
});

test("W3-A: every item lands in exactly one group, and none is duplicated", () => {
  const grouped = harness.grouping.all.flatMap((group) => group.ids);
  assert.equal(grouped.length, harness.items.all.length, "every item is grouped");
  assert.equal(new Set(grouped).size, grouped.length, "no item appears twice");
  assert.deepEqual([...grouped].sort(), harness.items.all.map((i) => i.id).sort());
  // The rendered queue agrees with the projection.
  assert.equal(harness.queue.all.cards.length, harness.items.all.length);
});

test("W3-A: grouping preserves the order the queue supplied — it is not a new ranking", () => {
  // Grouping must not silently become prioritisation. Within each group the items appear
  // in the order the read models produced them.
  const order = harness.items.all.map((i) => i.id);
  for (const group of harness.grouping.all) {
    const positions = group.ids.map((id) => order.indexOf(id));
    assert.deepEqual(positions, [...positions].sort((a, b) => a - b), `${group.job} preserves queue order`);
  }
});

test("W3-A: a human job is read from the authority the server already evaluated", () => {
  // "Decision" means the actor may SETTLE the item — at least one terminal status is
  // permitted. "Review" means they may look at it but cannot close it. Both are the
  // contract's own verdicts, not a re-derivation from role names.
  for (const item of harness.items.all) {
    assert.equal(
      item.humanJob === "decision",
      item.terminalAllowed,
      `${item.id}: the job must follow the server's own terminal-authority verdict`,
    );
  }
  // Both sides of that equivalence are actually exercised by the fixture.
  assert.ok(harness.items.all.some((i) => i.terminalAllowed), "some item can be settled");
  assert.ok(harness.items.all.some((i) => !i.terminalAllowed), "some item cannot be settled");
  // The review item in the fixture is review-only for a real reason: a project manager
  // against a rule requiring sponsor authority may escalate but may not close.
  const review = harness.items.mixed.find((i) => i.humanJob === "review");
  assert.ok(review, "the fixture contains a genuinely review-only item");
  assert.equal(review.anyAllowed, true, "they can still record SOMETHING — this is not a read-only role");
  assert.equal(review.terminalAllowed, false, "...but nothing that closes the item");
  // Precisely the contract's behaviour: escalation and needs-more-evidence, nothing terminal.
  assert.deepEqual([...review.allowedStatuses].sort(), ["escalated", "needs_more_evidence"]);
  // A read-only actor is a review too, by the other route.
  assert.deepEqual(harness.items.reviewOnly.map((i) => i.humanJob), ["review"]);
  assert.equal(harness.items.reviewOnly[0].anyAllowed, false);
});

test("W3-A: only populated groups get a heading", () => {
  assert.deepEqual(harness.queue.decidable.headings, ["decision"]);
  assert.deepEqual(harness.queue.reviewOnly.headings, ["review"]);
  assert.deepEqual(harness.queue.raidOnly.headings, ["decision"]);
  assert.deepEqual(harness.queue.all.headings, ["decision", "review"]);
  // Nothing to show means no headings at all, not a column of empty ones.
  assert.deepEqual(harness.queue.empty.headings, []);
  assert.deepEqual(harness.queue.failed.headings, []);
  assert.deepEqual(groupAttentionItems([]), []);
});

test("W3-A: no Approvals group is invented", () => {
  // Needs You is fed by governed Recommendations awaiting a Decision and RAID suggestions
  // awaiting triage. Neither is an authorization a human grants, so there is no honest
  // approval item — and an empty heading would tell a PM a kind of work exists that does
  // not. The label stays defined for the day a real approval source appears.
  assert.equal(APPROVAL_ITEMS_AVAILABLE, false);
  assert.equal(HUMAN_JOB_GROUP_LABELS.approval, "Approvals");
  for (const group of harness.grouping.all) assert.notEqual(group.job, "approval");
  assert.ok(!harness.queue.all.markup.includes("cc-attention-group-approval"));
  assert.ok(!harness.queue.all.text.includes("Approvals"));
});

test("W3-A: grouping does not merge the two attention sources", () => {
  // They may sit under one heading, because the PM's job is the same. Beneath it they stay
  // different business objects with different write paths and different authority language.
  const decisions = harness.grouping.all.find((g) => g.job === "decision");
  const byId = new Map(harness.items.all.map((i) => [i.id, i]));
  const kinds = decisions.ids.map((id) => byId.get(id).kind);
  assert.ok(kinds.includes("governed_recommendation") && kinds.includes("raid_suggestion"));
  // The badges, write paths and control vocabularies remain distinct.
  const governed = harness.items.all.find((i) => i.kind === "governed_recommendation");
  const raid = harness.items.all.find((i) => i.kind === "raid_suggestion");
  assert.notEqual(governed.badgeLabel, raid.badgeLabel);
  assert.notEqual(governed.writePathLabel, raid.writePathLabel);
  assert.match(raid.writePathLabel, /\/api\/recommended-actions\/decision/);
  assert.match(governed.writePathLabel, /operational_decision_records/);
  // `deferred` exists only on the bounded path; the governed path has no such status.
  assert.ok(raid.decisionStatuses.includes("deferred"));
  assert.ok(!governed.decisionStatuses.includes("deferred"));
  assert.ok(!DECISION_OPTIONS.some((option) => option.status === "deferred"));
  // The screen still calls two separate derivations with two separate handlers.
  assert.match(layout, /deriveNeedsYou\(flowData, handleDecide\)/);
  assert.match(layout, /deriveRaidNeedsYou\(raidActions, handleRaidDecide\)/);
});

// ───────────────────────────── W3-B: card anatomy ────────────────────────────

test("W3-B: a populated card tells the whole story without opening anything", () => {
  const card = harness.queue.all.cards[0];
  assert.equal(card.job, "decision");
  // Severity, human job, headline, why, recommendation, evidence, CTA.
  assert.match(card.body, /data-testid="cc-attention-severity"[^>]*>critical</);
  assert.match(card.body, /data-testid="cc-attention-job"[^>]*>Decision</);
  assert.match(card.text, /Work outside the agreed scope was requested\./);
  assert.match(card.text, /Why this matters The client requested additional scope without a formal change request\./);
  assert.match(card.text, /PMFreak recommends Raise a formal Change Request/);
  assert.match(card.text, /Based on: Client scope request/);
  assert.match(card.text, /Review recommendation/);
});

test("W3-B: a RAID suggestion tells the same story, in the same shape", () => {
  const card = harness.queue.all.cards.find((c) => c.text.includes("Confirm the integration owner"));
  assert.ok(card, "the RAID card renders");
  assert.match(card.body, /data-testid="cc-attention-job"[^>]*>Decision</);
  assert.match(card.text, /Why this matters The notes mention an unowned integration dependency\./);
  assert.match(card.text, /PMFreak recommends Suggested owner: Delivery lead\. Suggested timing: this week\./);
  assert.match(card.text, /Based on: Detected from your project notes/);
  // Its own severity vocabulary, rendered with the same weight, not remapped.
  assert.match(card.body, /data-testid="cc-attention-severity"[^>]*>medium</);
});

test("W3-B: a card with thin data is shorter, not invented", () => {
  // The fixture's third governed item has no linked signal and no evidence: no severity is
  // shown, no evidence line, and no recommendation is manufactured from the title.
  const thin = harness.items.mixed.find((i) => i.id === "governed-rec-rec-3");
  assert.ok(thin, "the thin-data fixture exists");
  assert.equal(thin.severity, null, "no severity is invented");
  assert.equal(thin.recommendation, null, "the headline IS the recommendation; it is not printed twice");
  const card = harness.queue.all.cards.find((c) => c.text.includes("Assign an owner to the integration dependency"));
  assert.ok(card);
  assert.ok(!card.body.includes("cc-attention-severity"), "no severity badge on a card with no severity");
  assert.ok(!card.body.includes("cc-attention-evidence"), "no evidence line without evidence");
  assert.ok(!card.body.includes("cc-attention-recommendation"), "no duplicated recommendation");
  // But the honest fallback `why` still tells the PM something true.
  assert.match(card.text, /Why this matters/);
  // And it still carries a job and a way in.
  assert.match(card.body, /data-testid="cc-attention-job"/);
  assert.match(card.text, /Review recommendation/);
});

test("W3-B: the card carries no canonical lifecycle, governance table or technical identifier", () => {
  const PROHIBITED = [
    "AOC-E", "P2-06", "P2-09", "canonical", "fixture", "Material Action", "sha256",
    "operational_decision_records", "Governed Recommendation", "Authority required", "Rule",
  ];
  for (const card of harness.queue.all.cards) {
    for (const term of PROHIBITED) {
      assert.ok(!card.text.toLowerCase().includes(term.toLowerCase()), `"${term}" must not be on a card: ${card.text.slice(0, 80)}`);
    }
    // No raw uuid-shaped or hash-shaped identifier either.
    assert.ok(!/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}/i.test(card.text), "no raw uuid on a card");
    assert.ok(!/\b[0-9a-f]{32,}\b/i.test(card.text), "no hash on a card");
  }
  // The card component reads only presentation fields; it never reaches into the drawer's
  // canonical rows to render them.
  assert.doesNotMatch(cardSrc, /drawer\.(chain|sections)/);
});

// ───────────────────────────── W3-C: the judgment surface ────────────────────

test("W3-C: the drawer leads with judgment, in the PM's order", () => {
  const markup = harness.drawers.governed.markup;
  const order = [...markup.matchAll(/<h3[^>]*>([^<]+)<\/h3>/g)].map((m) => m[1]);
  assert.deepEqual(order, ["Why this matters", "Evidence", "Your decision", "Evidence &amp; governance"]);
  // "PMFreak recommends" sits between the evidence and the decision.
  const at = (needle) => markup.indexOf(needle);
  assert.ok(at("Why this matters") < at("Evidence"));
  assert.ok(at("Evidence") < at("PMFreak recommends"));
  assert.ok(at("PMFreak recommends") < at("Your decision"));
  assert.ok(at("Your decision") < at("Evidence &amp; governance"));
});

test("W3-C: the recommendation is the recommendation, not the procedural caveat", () => {
  // This surface used to be headed "Suggested next step" and carried "Requires sponsor or
  // PMO. Recording a Decision does not create an Action..." — a caveat, presented as advice.
  const body = primarySurface(harness.drawers.governed.markup);
  assert.match(body, /PMFreak recommends Raise a formal Change Request/);
  // The caveat survives, beneath it, qualifying rather than impersonating the recommendation.
  assert.match(body, /Requires sponsor or PMO\./);
  assert.ok(body.indexOf("Raise a formal Change Request") < body.indexOf("Requires sponsor or PMO"));
  // The RAID drawer's recommendation is its own suggested owner and timing.
  assert.match(primarySurface(harness.drawers.raid.markup), /PMFreak recommends Suggested owner: Delivery lead\./);
});

test("W3-C: the primary judgment surface uses no internal vocabulary", () => {
  const PROHIBITED = ["AOC-E", "P2-06", "P2-09", "operational_decision_records", "canonical", "fixture", "sha256"];
  for (const [name, drawer] of Object.entries(harness.drawers)) {
    const body = primarySurface(drawer.markup);
    for (const term of PROHIBITED) {
      assert.ok(!body.toLowerCase().includes(term.toLowerCase()), `${name}: "${term}" must not precede the decision`);
    }
  }
});

// ───────────────────────────── decision action mapping ───────────────────────

test("W3: every decision control maps to an existing canonical status — nothing is invented", () => {
  const governed = harness.items.all.find((i) => i.kind === "governed_recommendation");
  const canonical = new Set(DECISION_OPTIONS.map((option) => option.status));
  for (const status of governed.decisionStatuses) {
    assert.ok(canonical.has(status), `${status} is a canonical decision status`);
  }
  // Approve, Reject and Modify each map onto a status that already existed.
  const byStatus = Object.fromEntries(governed.decisionStatuses.map((status, i) => [status, governed.decisionLabels[i]]));
  assert.equal(byStatus.accepted, "Accept");
  assert.equal(byStatus.rejected, "Reject");
  assert.equal(byStatus.modified, "Record modification");
  // `modified` is a real canonical status, and it is terminal — W3 did not add it.
  assert.ok(TERMINAL_DECISION_STATUSES.includes("modified"));
  // The write path is unchanged: one operation, the canonical status, the rationale.
  assert.match(layout, /operation: "record_decision"/);
  assert.match(layout, /decisionStatus/);
  assert.match(operationalData, /onDecide: \(status, rationale\) => onDecide\(item\.recommendationId, status, rationale\)/);
});

test("W3: the bounded RAID triage keeps its own three verbs", () => {
  const raid = harness.items.all.find((i) => i.kind === "raid_suggestion");
  assert.deepEqual(raid.decisionStatuses, ["accepted", "rejected", "deferred"]);
  assert.deepEqual(raid.decisionLabels, ["Accept", "Reject", "Defer"]);
  assert.match(layout, /postRaidActionDecision/);
});

test("W3: rationale requirements are unchanged by the new presentation", () => {
  const governed = harness.items.all.find((i) => i.kind === "governed_recommendation");
  const raid = harness.items.all.find((i) => i.kind === "raid_suggestion");
  // The governed path required a rationale before W3 and still does; the bounded path did
  // not and still does not. W3 changed no constraint in either direction.
  assert.equal(governed.requiresRationale, true);
  assert.equal(raid.requiresRationale, false);
  assert.match(primarySurface(harness.drawers.governed.markup), /Rationale \(required\)/);
  assert.match(primarySurface(harness.drawers.raid.markup), /Rationale \(optional\)/);
});

test("W3: an actor who cannot settle an item is told so, and no control is silently enabled", () => {
  const body = harness.drawers.reviewOnly.text;
  assert.match(body, /your role cannot record a Decision on it/i);
  assert.match(body, /sponsor or PMO/);
  assert.equal(harness.items.reviewOnly[0].anyAllowed, false);
});

// ───────────────────────────── progressive disclosure ────────────────────────

test("W3: the canonical record is preserved, complete, and behind disclosure", () => {
  const markup = harness.drawers.governed.markup;
  const detailAt = markup.indexOf("Evidence &amp; governance");
  assert.ok(detailAt > 0);
  const detail = markup.slice(detailAt);
  for (const disclosure of [
    "How PMFreak got here",
    "Provenance",
    "Evidence quality",
    "Governance",
    "Canonical references",
    "What this is, and what a decision records",
  ]) {
    assert.match(detail, new RegExp(`<summary[^>]*>${disclosure}</summary>`), `${disclosure} is preserved`);
  }
  // Collapsed by default: none of these carries `open`.
  for (const tag of detail.match(/<details[^>]*>/g) ?? []) {
    assert.doesNotMatch(tag, /\bopen\b/, "canonical detail must not be expanded by default");
  }
  // Nothing was deleted from the read model to achieve this.
  assert.match(operationalData, /id: "provenance", title: "Provenance"/);
  assert.match(operationalData, /id: "governance"/);
  assert.match(operationalData, /id: "references", title: "Canonical references"/);
});

// ───────────────────────────── honest states (W2 carried forward) ────────────

test("W3: the honest empty, partial and failed states survive the grouping layer", () => {
  // Complete zero: clear.
  assert.match(harness.queue.empty.text, /You&#x27;re clear\./);
  assert.match(harness.queue.empty.text, /Nothing currently requires your decision or review\./);
  // Partial: known items stay visible, and the surface says it is not finished.
  assert.equal(harness.queue.loadingWithKnown.cardCount, 2, "known items remain visible while loading");
  assert.match(harness.queue.loadingWithKnown.text, /Still checking suggested actions\./);
  assert.ok(!harness.queue.loadingWithKnown.text.includes("You&#x27;re clear."), "a partial read is never 'clear'");
  // Failure: a failure, never an empty success.
  assert.match(harness.queue.failed.text, /We couldn&#x27;t load project attention\./);
  assert.match(harness.queue.failed.text, /Try again/);
  assert.ok(!harness.queue.failed.text.includes("You&#x27;re clear."));
});

// ───────────────────────────── accessibility ─────────────────────────────────

test("W3: groups and cards are semantic and keyboard reachable", () => {
  const markup = harness.queue.all.markup;
  // Group headings are real headings inside labelled sections.
  assert.match(markup, /<section aria-labelledby="[^"]+" data-testid="cc-attention-group-decision"/);
  assert.match(markup, /<h3 id="[^"]+"[^>]*>Decisions<\/h3>/);
  assert.match(markup, /<h3 id="[^"]+"[^>]*>Reviews<\/h3>/);
  // Every card is a real button, so it is tabbable and activates on Enter/Space.
  for (const card of harness.queue.all.cards) {
    assert.match(card.body, /^<button type="button"/);
    assert.match(card.body, /focus-visible:ring/);
  }
  // No interactive element nested inside another, in the queue or the drawer.
  for (const html of [markup, harness.drawers.governed.markup]) {
    assert.doesNotMatch(html, /<button(?:(?!<\/button>)[\s\S])*<button/);
  }
});

// ───────────────────────────── nothing beneath moved ─────────────────────────

test("W3: no backend semantics, authority or audit behaviour changed", () => {
  // The canonical decision vocabulary is untouched.
  assert.deepEqual(
    DECISION_OPTIONS.map((option) => option.status),
    ["accepted", "rejected", "modified", "needs_more_evidence", "escalated"],
  );
  assert.deepEqual([...TERMINAL_DECISION_STATUSES], ["accepted", "rejected", "modified"]);
  // Authority is still read from the server-evaluated map, never re-derived from a role.
  const attentionModel = read("src/modules/workspace/presentation/command-center/attention-read-model.ts");
  assert.match(attentionModel, /actor_authority/);
  const grouping = read("src/modules/workspace/presentation/command-center/attention-presentation.ts");
  const groupingCode = grouping.replace(/\/\*[\s\S]*?\*\//g, "").split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
  // The grouping READS the server's verdict and never re-derives it: no role name appears
  // in its code, and it assigns nothing to `allowed`.
  assert.doesNotMatch(groupingCode, /\b(admin|viewer|sponsor|owner|pm)\b/i, "grouping must not reason about roles");
  assert.doesNotMatch(groupingCode, /allowed\s*[:=]\s*(true|false)/, "grouping must never set a control's authority");
  assert.match(groupingCode, /control\.terminal && control\.allowed/, "it reads the evaluated authority");
  // The screen's write calls are unchanged.
  assert.match(layout, /await postOperationalFlow\(workspaceId, selectedProject\?\.id \?\? "", \{/);
  assert.match(layout, /await postRaidActionDecision\(\{/);
});

test("W3 added no dependency", () => {
  const pkg = JSON.parse(read("package.json"));
  for (const banned of ["jsdom", "@types/jsdom", "@testing-library/react", "@testing-library/dom"]) {
    assert.ok(!pkg.dependencies?.[banned], `${banned} must not be a dependency`);
    assert.ok(!pkg.devDependencies?.[banned], `${banned} must not be a devDependency`);
  }
});
