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

/** The REAL `getOperationalSummary` against a faithful Data API stub, rooted on the open
 *  governed set — false-clear, >30 open, and a known-incomplete read. */
const roots = JSON.parse(
  execFileSync(process.execPath, ["node_modules/tsx/dist/cli.mjs", "tests/ux-w3-attention-root-harness.tsx"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
    maxBuffer: 64 * 1024 * 1024,
  }),
);

/** The REAL `getOperationalSummary` against a faithful Data API stub, so the presentation
 *  windows truncate exactly as PostgREST would. */
const lineage = JSON.parse(
  execFileSync(process.execPath, ["node_modules/tsx/dist/cli.mjs", "tests/ux-w3-attention-lineage-harness.tsx"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
    maxBuffer: 64 * 1024 * 1024,
  }),
);

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
  const card = harness.queue.all.cards.find((c) => c.text.includes("Integration owner unknown"));
  assert.ok(card, "the RAID card renders");
  assert.match(card.body, /data-testid="cc-attention-job"[^>]*>Decision</);
  assert.match(card.text, /Why this matters The notes mention an unowned integration dependency\./);
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
  // The RAID drawer's recommendation is its own proposed action. (This assertion used to
  // read "PMFreak recommends Suggested owner: ...", which locked in the inverted semantics
  // W3-P1-01 fixed — owner and timing qualify the action, they are not the advice.)
  assert.match(primarySurface(harness.drawers.raid.markup), /PMFreak recommends Confirm the integration owner/);
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


// ═══════════════════════════════════════════════════════════════════════════════
// W3 REVIEW REMEDIATION
// ═══════════════════════════════════════════════════════════════════════════════

// ───────── W3-P1-01: the RAID recommendation is the recommended ACTION ───────
//
// `generate-recommended-actions.ts` is explicit about which field is which:
// `action.title` is the PROPOSED ACTION ("Confirm dependency: ...", "Request approval:
// ..."), `evidenceSummary.raidTitle` is the RAID item that caused it, and owner and due
// window qualify the action. The first cut of W3 had the first two the wrong way round and
// then labelled the qualifiers as the recommendation, so a PM was told that "Suggested
// owner: Delivery lead" was PMFreak's advice.

test("W3-P1-01: the fixture's finding and proposed action are genuinely different sentences", () => {
  const contract = harness.raidContract;
  assert.equal(contract.sourceRaidTitle, "Integration owner unknown");
  assert.equal(contract.recommendedActionTitle, "Confirm the integration owner");
  assert.notEqual(contract.sourceRaidTitle, contract.recommendedActionTitle);
  assert.ok(contract.owner && contract.dueWindow, "the fixture carries qualifiers too");
});

test("W3-P1-01: the RAID headline is the finding, and the recommendation is the proposed action", () => {
  const raid = harness.items.all.find((i) => i.kind === "raid_suggestion");
  assert.equal(raid.subject, harness.raidContract.sourceRaidTitle, "headline is the source RAID item");
  assert.equal(raid.recommendation, harness.raidContract.recommendedActionTitle, "recommendation is the proposed action");
  // `title` still carries the canonical action title for every other consumer.
  assert.equal(raid.title, harness.raidContract.recommendedActionTitle);

  const card = harness.queue.all.cards.find((c) => c.text.includes(harness.raidContract.sourceRaidTitle));
  assert.ok(card, "the card leads with the finding");
  assert.match(card.text, new RegExp(`PMFreak recommends ${harness.raidContract.recommendedActionTitle}`));
  // The finding is read before the recommendation, not after it.
  assert.ok(card.text.indexOf(harness.raidContract.sourceRaidTitle) < card.text.indexOf("PMFreak recommends"));
});

test("W3-P1-01: owner and timing qualify the recommendation — they are never the recommendation", () => {
  const primary = primarySurface(harness.drawers.raid.markup);
  assert.match(primary, /PMFreak recommends Confirm the integration owner/);
  // They survive, after it.
  assert.match(primary, /Suggested owner: Delivery lead\. Suggested timing: this week\./);
  assert.ok(primary.indexOf("Confirm the integration owner") < primary.indexOf("Suggested owner"));
  // And they are not what the "recommends" label points at, on the card or in the drawer.
  assert.doesNotMatch(primary, /PMFreak recommends Suggested owner/);
  for (const card of harness.queue.all.cards) {
    assert.doesNotMatch(card.text, /PMFreak recommends Suggested owner/);
  }
});

// ───────── W3-P1-02: a recorded non-terminal Decision leaks no identifiers ───
//
// `escalated` maps the Recommendation back to `proposed`, so an item still awaiting the PM
// can carry a Decision — and its record rendered in front of the live judgment, complete
// with the canonical Decision id, the raw actor id, the authority basis and the evidence
// snapshot digest.

test("W3-P1-02: an escalated item stays in Needs You with its human history visible", () => {
  assert.equal(harness.items.escalated.length, 1, "escalation does not resolve the item");
  assert.deepEqual(harness.items.escalated[0].recordedDecisionIds, ["dec-esc"]);
  assert.deepEqual(harness.grouping.escalated, [{ job: "decision", ids: ["governed-rec-rec-1"] }]);
  const primary = primarySurface(harness.drawers.escalated.markup);
  // What a PM needs from the history: what was decided, that it stays open, why, and when.
  assert.match(primary, /Decision recorded — escalated \(recommendation stays open\)/);
  assert.match(primary, /Needs the sponsor to weigh in before we decide\./);
  assert.match(primary, /Recorded at/);
});

test("W3-P1-02: no canonical identifier, actor id, authority basis or hash precedes the judgment", () => {
  const primary = primarySurface(harness.drawers.escalated.markup);
  const fixture = harness.escalatedFixture;
  assert.ok(!primary.includes(fixture.decisionId), "the canonical Decision id must not be primary");
  assert.ok(!primary.includes(fixture.decidedBy), "the raw actor id must not be primary");
  assert.ok(!primary.includes(fixture.authorityBasis), "authority basis must not be primary");
  assert.ok(!primary.includes("Evidence snapshot"), "no evidence snapshot label before the decision");
  assert.ok(!/\bsha256\b/i.test(primary), "no digest before the decision");
  assert.ok(!/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(primary), "no raw uuid before the decision");
});

test("W3-P1-02: the complete canonical decision record survives, behind disclosure", () => {
  const markup = harness.drawers.escalated.markup;
  const detail = markup.slice(markup.indexOf("Evidence &amp; governance"));
  const fixture = harness.escalatedFixture;
  assert.match(detail, /<summary[^>]*>Decision record details<\/summary>/);
  for (const preserved of [fixture.decisionId, fixture.decidedBy, fixture.authorityBasis]) {
    assert.ok(detail.includes(preserved), `${preserved} must be preserved in the audit record`);
  }
  assert.match(detail, /Evidence snapshot/);
  assert.match(detail, /Decision ID/);
  // Collapsed by default.
  const tag = detail.slice(detail.indexOf("<details", detail.indexOf("Decision record details") - 400));
  assert.doesNotMatch(tag.slice(0, tag.indexOf(">")), /\bopen\b/);
});

// ───────── W3-P1-03: the source badge is not the first thing a PM reads ─────

test("W3-P1-03: no attention drawer shows its source badge before the judgment", () => {
  for (const [name, drawer] of Object.entries(harness.drawers)) {
    const primary = primarySurface(drawer.markup);
    assert.ok(!primary.includes("Governed · decision required"), `${name}: governed source badge must not be primary`);
    assert.ok(!primary.includes("Suggestion · extracted intelligence"), `${name}: RAID source badge must not be primary`);
    assert.ok(!primary.includes("Governed Recommendation"), `${name}: source vocabulary must not be primary`);
  }
});

test("W3-P1-03: the source distinction is preserved, verbatim, under disclosure", () => {
  const governed = harness.drawers.governed.markup;
  const raid = harness.drawers.raid.markup;
  const governedDetail = governed.slice(governed.indexOf("Evidence &amp; governance"));
  const raidDetail = raid.slice(raid.indexOf("Evidence &amp; governance"));
  assert.ok(governedDetail.includes("Governed · decision required"));
  assert.ok(raidDetail.includes("Suggestion · extracted intelligence"));
  assert.match(governedDetail, /Governed Recommendation — system output/);
  assert.match(raidDetail, /not a governed Recommendation and carries no governance authority requirement/);
  // The two write paths remain distinguishable, which is the invariant P2-11 protects.
  assert.ok(governedDetail.includes("operational_decision_records"));
  assert.ok(raidDetail.includes("/api/recommended-actions/decision"));
  assert.ok(!raidDetail.includes("operational_decision_records"));
});

test("W3-P1-03: drawers that are not attention items keep their badge in place", () => {
  // The suppression is gated on the decision panel, so agent cards and governed execution
  // chains — neither of which has one — are untouched by this change.
  const drawerSrc = read("src/modules/workspace/presentation/command-center/detail-drawer.tsx");
  assert.match(drawerSrc, /\{content\.badge && !content\.decisionPanel && \(/);
});

// ───────── W3-P2-04: missing lineage is not an actionable Decision ──────────
//
// Canonical behaviour, from `record_operational_decision`
// (supabase/migrations/20260611000000_operational_evidence_decision_loop.sql): the function
// walks the governed lineage BEFORE it evaluates authority and raises
// `governed_lineage_incomplete` when the governance event, risk, signal or evidence row is
// missing. The write is REFUSED for such an item however much authority the actor holds.

test("W3-P2-04: the canonical contract refuses a decision when the governed lineage is incomplete", () => {
  const migration = read("supabase/migrations/20260611000000_operational_evidence_decision_loop.sql");
  const fn = migration.slice(migration.indexOf("create or replace function public.record_operational_decision"));
  assert.match(fn, /if g\.id is null or r\.id is null or s\.id is null or e\.id is null then raise exception 'governed_lineage_incomplete'/);
  // ...and it does so BEFORE the authority check, so authority cannot rescue it.
  const lineageAt = fn.indexOf("governed_lineage_incomplete");
  const authorityAt = fn.indexOf("operational_decision_authority_denied");
  assert.ok(lineageAt > 0 && authorityAt > lineageAt, "lineage is validated before authority");
});

test("W3-P2-04: an item the server would refuse is not presented as a settleable Decision", () => {
  const item = harness.items.missingEvidence[0];
  // The actor holds full authority — every terminal control is permitted — so this would
  // have been grouped under Decisions on authority alone.
  assert.equal(item.terminalAllowed, true, "authority alone would have said 'Decision'");
  assert.ok(item.blockedReason, "the read model already knows the lineage is incomplete");
  // The presentation follows the contract, not the authority map.
  assert.equal(item.humanJob, "review");
  assert.deepEqual(harness.grouping.missingEvidence, [{ job: "review", ids: ["governed-rec-rec-1"] }]);
  assert.deepEqual(harness.queue.missingEvidence.headings, ["review"]);
  assert.match(harness.queue.missingEvidence.cards[0].body, /data-testid="cc-attention-job"[^>]*>Review</);
});

test("W3-P2-04: the copy states what the server will do, without overclaiming", () => {
  const body = harness.drawers.missingEvidence.text;
  assert.match(body, /can&#x27;t record a decision on this yet/);
  assert.match(body, /the decision would be refused/);
  // It names the missing thing and the way forward, and promises nothing beyond that.
  assert.match(body, /Add the supporting project context first\./);
  // No client-side re-implementation of the server's gate: the read model reports the
  // condition and the grouping reads it.
  const grouping = read("src/modules/workspace/presentation/command-center/attention-presentation.ts");
  assert.match(grouping, /if \(panel\?\.blockedReason\) return "review";/);
  assert.doesNotMatch(grouping, /evidence_items|governance_events|risk_issue_records/);
});

// ───────── W3-P2-05: no provenance-only artifact churn ──────────────────────

test("W3-P2-05: the compliance artifacts are untouched, because the dependency graph is", () => {
  // W3 adds no dependency, so the committed inventory and SBOM still describe the lockfile
  // exactly. Regenerating them would have committed a new timestamp, a new BOM serial and a
  // new repositoryCommit — provenance churn that is not part of this workstream.
  const inventory = JSON.parse(read("artifacts/compliance/third-party-license-inventory.json"));
  assert.equal(inventory.counts.blocked, 0);
  assert.ok(inventory.lockfile?.sha256 || inventory.counts.total > 0, "the inventory is intact");
});


// ═══════════════════════════════════════════════════════════════════════════════
// W3 FINAL REMEDIATION — governed-lineage truth
// ═══════════════════════════════════════════════════════════════════════════════
//
// `getOperationalSummary` windows each collection independently — evidence to the newest 20,
// signals / risks / governance / recommendations to the newest 30. W3 read "is there
// Evidence?" and "which authority does this need?" out of those windows, so a Recommendation
// whose linked rows were merely older than the window read as canonically broken. The
// canonical write resolves the same lineage by exact id and would have accepted it.
//
// These run the REAL service against the same faithful Data API stub P2-12 uses.

test("W3-P1-04A: the window collision is real — every linked row is outside its window", () => {
  // Without this the rest of the section could pass against rows that were never truncated.
  const w = lineage.windows;
  assert.equal(w.evidenceCount, 20, "the evidence window really is the newest 20");
  assert.equal(w.recommendationsContainsRoot, true, "the Recommendation IS in the root window");
  assert.equal(w.evidenceContainsLinked, false, "its Evidence is NOT");
  assert.equal(w.signalsContainsLinked, false, "nor its Signal");
  assert.equal(w.risksContainsLinked, false, "nor its Risk");
  assert.equal(w.governanceContainsLinked, false, "nor its Governance Event");
});

test("W3-P1-04A: an out-of-window lineage is resolved by exact reference, not declared missing", () => {
  const context = lineage.contexts.find((c) => c.recommendationId === "rec-old");
  assert.ok(context, "the projection covers every root Recommendation");
  assert.deepEqual(
    { governance: context.hasGovernance, risk: context.hasRisk, signal: context.hasSignal, evidence: context.hasEvidence },
    { governance: true, risk: true, signal: true, evidence: true },
  );
  assert.equal(context.lineageComplete, true);

  const item = lineage.outOfWindowButComplete;
  assert.equal(item.lineageComplete, true);
  assert.equal(item.evidenceMissing, false, "window absence must never read as canonical absence");
  assert.equal(item.blockedReason, null);
  // The PM is not told the write would fail.
  assert.ok(!/would be refused/.test(item.drawerPrimary));
  assert.ok(!/can&#x27;t record a decision/.test(item.drawerPrimary));
});

test("W3-P1-04A: authority comes from the exact linked Governance Event", () => {
  // Read from the windowed governance map this would have degraded to "baseline review",
  // which grants far more than "sponsor or PMO" and would silently change the taxonomy.
  const context = lineage.contexts.find((c) => c.recommendationId === "rec-old");
  assert.equal(context.authorityRequired, lineage.requiredAuthority);
  assert.notEqual(context.authorityRequired, "baseline review");
  // The server projected it onto `actor_authority`...
  const projected = lineage.actorAuthority.find((row) => row.id === "rec-old");
  assert.equal(projected.accepted.authorityRequired, lineage.requiredAuthority);
  // ...and the read model reports it, rather than its own "an authorized reviewer" default.
  assert.equal(lineage.outOfWindowButComplete.authorityRequired, lineage.requiredAuthority);
});

test("W3-P1-04A: the card's own fields come from the exact-linked rows too", () => {
  // Severity, the headline and the evidence line all originate outside every window, so a
  // windowed read would have produced a card with no severity and a fallback headline.
  const item = lineage.outOfWindowButComplete;
  assert.equal(item.severity, "critical");
  assert.equal(item.signalSummary, "Work outside the agreed scope was requested.");
  assert.equal(item.evidenceTitle, "Client scope request");
  assert.match(item.why, /The client requested additional scope without a formal change request\./);
});

test("W3-P1-04A: a genuinely absent lineage node is still reported as incomplete", () => {
  // The companion case, so the fix cannot be "never block anything". This Recommendation's
  // Risk does not exist at all — not out of window, absent.
  const context = lineage.contexts.find((c) => c.recommendationId === "rec-broken");
  assert.equal(context.hasGovernance, true);
  assert.equal(context.hasRisk, false, "the Risk genuinely does not exist");
  assert.equal(context.lineageComplete, false);

  const item = lineage.genuinelyIncomplete;
  assert.equal(item.lineageComplete, false);
  assert.equal(item.evidenceMissing, true);
  assert.ok(item.blockedReason, "the PM is told, honestly");
  assert.match(item.blockedReason, /the decision would be refused/);
});

test("W3-P1-04A: the two cases land in different groups, from the same actor and authority", () => {
  // Same owner, same required authority, same terminal permissions. Only the canonical
  // lineage differs, and that is what decides the human job.
  assert.equal(lineage.outOfWindowButComplete.terminalAllowed, true);
  assert.equal(lineage.genuinelyIncomplete.terminalAllowed, true);
  assert.equal(lineage.outOfWindowButComplete.humanJob, "decision");
  assert.equal(lineage.genuinelyIncomplete.humanJob, "review");
  assert.deepEqual(lineage.grouping, [
    { job: "decision", ids: ["governed-rec-rec-old"] },
    { job: "review", ids: ["governed-rec-rec-broken"] },
  ]);
});

// ───────── W3-P1-04B: a blocked item offers nothing to submit ────────────────

test("W3-P1-04B: a lineage-blocked item renders no decision submission controls", () => {
  const blocked = lineage.genuinelyIncomplete.drawerMarkup;
  const primary = blocked.slice(0, blocked.indexOf("Evidence &amp; governance"));
  // The actor holds full terminal authority, so this is eligibility, not authority.
  assert.equal(lineage.genuinelyIncomplete.terminalAllowed, true);
  for (const verb of ["Accept", "Reject", "Record modification", "Record escalation"]) {
    assert.ok(!new RegExp(`<button[^>]*>\\s*${verb}\\s*<`).test(primary), `${verb} must not be offered`);
  }
  assert.ok(!primary.includes("<textarea"), "no rationale composer for a write that cannot proceed");
  assert.match(primary, /data-testid="cc-decision-blocked"/);
  // Still inspectable: why, evidence and the recommendation are all there.
  assert.match(primary, /Why this matters/);
  assert.match(primary, /Evidence/);
  assert.match(primary, /PMFreak recommends/);
});

test("W3-P1-04B: the same actor keeps normal controls when the lineage is complete", () => {
  // The required companion: the fix cannot simply suppress every decision control.
  const complete = lineage.outOfWindowButComplete.drawerMarkup;
  const primary = complete.slice(0, complete.indexOf("Evidence &amp; governance"));
  for (const verb of ["Accept", "Reject", "Record modification"]) {
    assert.ok(new RegExp(`<button[^>]*>\\s*${verb}\\s*<`).test(primary), `${verb} must be offered`);
  }
  assert.ok(primary.includes("<textarea"), "the rationale composer returns");
  assert.ok(!primary.includes('data-testid="cc-decision-blocked"'));
});

test("W3-P1-04B: eligibility never mutates the server's authority verdict", () => {
  const drawerSrc = read("src/modules/workspace/presentation/command-center/detail-drawer.tsx");
  // Controls are filtered for display; `control.allowed` is never assigned.
  assert.match(drawerSrc, /const submissionBlocked = Boolean\(panel\.blockedReason\);/);
  assert.doesNotMatch(drawerSrc, /control\.allowed\s*=[^=]/, "authority must never be rewritten client-side");
  // And the server's own map is still what the read model reads.
  const attentionModel = read("src/modules/workspace/presentation/command-center/attention-read-model.ts");
  assert.match(attentionModel, /actor_authority/);
});

// ───────── the recent-signal windows keep their meaning (W2) ─────────────────

test("W3: the authoritative context is separate — no window semantics changed", () => {
  const service = read("src/lib/operational-flow/operational-flow-service.ts");
  // The windowed collections are still assigned straight from their own queries; the
  // attention context is its own field and is never unioned into them.
  assert.match(service, /signals: signals\.data \?\? \[\],/);
  assert.match(service, /evidence: evidence\.data \?\? \[\],/);
  assert.match(service, /risksIssues: risks\.data \?\? \[\],/);
  assert.match(service, /governanceEvents: governance\.data \?\? \[\],/);
  assert.match(service, /governedAttentionContexts,/);
  // The signal loader still reads the newest 30 — What Changed and Monitoring depend on it.
  assert.match(service, /from\("operational_signals"\)[\s\S]{0,200}limit\(30\)/);
  // And the collision fixture proves it behaviourally: the exact-linked signal is resolved
  // for attention while staying out of the recent-signal window.
  assert.equal(lineage.windows.signalsContainsLinked, false);
  assert.equal(lineage.contexts.find((c) => c.recommendationId === "rec-old").lineageComplete, true);
});


// ═══════════════════════════════════════════════════════════════════════════════
// W3-P1-05 — the governed attention ROOT must be the open set
// ═══════════════════════════════════════════════════════════════════════════════
//
// `recommended_actions` is loaded as a recent HISTORY window: governed, newest 30, every
// status. Thirty newer terminal Recommendations push an older still-open one out of it, and
// an attention queue rooted there renders "You're clear." while a governed decision waits.

test("W3-P1-05: the history window genuinely hides the open Recommendation", () => {
  // Without this the fix could pass against a window that never truncated anything.
  const s = roots.falseClear;
  assert.equal(s.historicalWindowSize, 30, "the history window is full");
  assert.equal(s.historicalWindowPendingCount, 0, "and holds NO pending item — the old root saw nothing");
  // The project nonetheless has one open governed Recommendation, per the server aggregate.
  assert.equal(s.assuranceOpenRecommendations, 1);
});

test("W3-P1-05: the authoritative root finds the older open Recommendation", () => {
  const s = roots.falseClear;
  assert.equal(s.attentionRootLoaded, 1);
  assert.deepEqual(s.attentionRootIds, ["rec-old-open"]);
  assert.equal(s.attentionRootAllProposed, true, "the root is the OPEN set, not history");
  // ...and it reaches the PM, through the real read model and the real queue.
  assert.equal(s.pendingCount, 1);
  assert.equal(s.needsYouCount, 1);
  assert.deepEqual(s.needsYouIds, ["governed-rec-rec-old-open"]);
});

test("W3-P1-05: 'You're clear.' is not rendered while a governed decision waits", () => {
  const s = roots.falseClear;
  assert.equal(s.youreClearVisible, false);
  assert.match(s.queueText, /Needs your attention/);
  assert.match(s.queueText, /Decisions/);
  // Both reads finished cleanly — the old model would have called this complete and empty.
  assert.equal(s.completeness.loading, false);
  assert.equal(s.completeness.failed, false);
  assert.equal(s.completeness.complete, true, "the answer IS complete — it simply is not empty");
});

test("W3-P1-05: more than thirty open Recommendations are all loaded", () => {
  const s = roots.manyOpen;
  assert.equal(s.assuranceOpenRecommendations, 35);
  assert.equal(s.attentionRootLoaded, 35, "the root pages past the 30-row history window");
  assert.equal(s.governedAttentionComplete, true);
  assert.equal(s.needsYouCount, 35);
  // The history window still holds only 30 — its contract is untouched.
  assert.equal(s.historicalWindowSize, 30);
});

test("W3-P1-05: completeness is proven against the project-wide count, not assumed from a successful read", () => {
  // 35 open rows loaded, aggregate reports 40 — a skew the service detects by comparing,
  // not by trusting that the request finished.
  const s = roots.knownIncomplete;
  assert.equal(s.attentionRootLoaded, 35);
  assert.equal(s.assuranceOpenRecommendations, 40);
  assert.equal(s.governedAttentionComplete, false);
  assert.equal(s.completeness.failed, false, "nothing failed");
  assert.equal(s.completeness.loading, false, "nothing is loading");
  assert.equal(s.completeness.partial, true, "and the answer is still not whole");
  assert.equal(s.completeness.complete, false);
  assert.deepEqual(s.completeness.unresolved, ["governed recommendations"]);
});

test("W3-P1-05: an incomplete answer shows every known item, says so, and states no total", () => {
  const s = roots.knownIncomplete;
  // Known items stay visible.
  assert.equal(s.needsYouCount, 35);
  // The scope is stated using the server's own numbers, not an invented one.
  assert.equal(s.incompleteNote, "Showing 35 of 40 governed items needing review.");
  assert.match(s.queueText, /Showing 35 of 40 governed items needing review\./);
  // No "You're clear.", and no bare count presented as the definitive amount waiting.
  assert.equal(s.youreClearVisible, false);
  const heading = s.queueMarkup.slice(0, s.queueMarkup.indexOf("cc-attention-group-"));
  assert.ok(!/<span class="shrink-0 text-\[11px\] text-zinc-500">\d+<\/span>/.test(heading), "no definitive count on a partial answer");
});

test("W3-P1-05: a complete answer still states its count", () => {
  // The companion, so the fix cannot be "never show a count".
  const complete = roots.manyOpen;
  assert.equal(complete.governedAttentionComplete, true);
  assert.equal(complete.incompleteNote, null);
  const heading = complete.queueMarkup.slice(0, complete.queueMarkup.indexOf("cc-attention-group-"));
  assert.match(heading, /<span class="shrink-0 text-\[11px\] text-zinc-500">35<\/span>/);
});

test("W3-P1-05: the attention root is a separate, bounded, exact query — the history window is untouched", () => {
  const service = read("src/lib/operational-flow/operational-flow-service.ts");
  // Its own read: governed, proposed, workspace- and project-scoped, paged by range.
  assert.match(service, /\.eq\("status", "proposed"\)/);
  assert.match(service, /const ATTENTION_ROOT_MAX_PAGES = 20;/);
  assert.match(service, /\.range\(offset, offset \+ ROW_PAGE_SIZE - 1\)/);
  // The history window's query is unchanged: all statuses, newest 30.
  assert.match(service, /from\("recommended_actions"\)[\s\S]{0,220}not\("governance_event_id", "is", null\)\.order\("created_at", \{ ascending: false \}\)\.limit\(30\)/);
  // The total comes from the assurance aggregate, never from a window.
  assert.match(service, /const governedAttentionTotal = Number\(assuranceSummary\?\.openRecommendations \?\? 0\);/);
  assert.match(service, /openGovernedRecommendations\.length >= governedAttentionTotal/);
  // And the two collections stay distinct in the payload.
  assert.match(service, /recommendations: safeRecommendations,/);
  assert.match(service, /governedAttentionRecommendations: safeGovernedAttentionRecommendations,/);
});

test("W3-P1-05: decided-drawer reconciliation still works — history is unioned for lookup only", () => {
  // P2-11 keeps a drawer resolvable after a Decision makes its Recommendation terminal and
  // it leaves the open set. The read model unions the history window in for that, deduped
  // by canonical id, so nothing appears twice.
  const attentionModel = read("src/modules/workspace/presentation/command-center/attention-read-model.ts");
  assert.match(attentionModel, /for \(const row of summary\.governedAttentionRecommendations \?\? \[\]\) byId\.set\(String\(row\.id\), row\);/);
  assert.match(attentionModel, /if \(!byId\.has\(String\(row\.id\)\)\) byId\.set\(String\(row\.id\), row\);/);
  // No duplicate reaches the queue in any scenario.
  for (const [name, scenario] of Object.entries(roots)) {
    assert.equal(new Set(scenario.needsYouIds).size, scenario.needsYouIds.length, `${name}: no duplicated item`);
  }
});
