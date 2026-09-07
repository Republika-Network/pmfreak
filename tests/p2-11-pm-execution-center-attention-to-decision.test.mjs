import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

/**
 * P2-11 — PM Execution Center Attention-to-Decision Experience.
 *
 * The behavioural assertions below run the real attention read model and the real Command Center
 * components (rendered through react-dom/server) via `tests/p2-11-attention-harness.tsx`, which
 * this repository's tsx-based runner executes directly. Only assertions that depend on live
 * browser interaction fall back to reading component source, and those are marked as such.
 */

const harness = JSON.parse(
  execFileSync(process.execPath, ["node_modules/tsx/dist/cli.mjs", "tests/p2-11-attention-harness.tsx"], {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  }).trim()
);

const readModel = readFileSync("src/modules/workspace/presentation/command-center/attention-read-model.ts", "utf8");
const drawer = readFileSync("src/modules/workspace/presentation/command-center/detail-drawer.tsx", "utf8");
const layout = readFileSync("src/modules/workspace/screens/command-center/command-center-layout.tsx", "utf8");
const operationalData = readFileSync("src/modules/workspace/presentation/command-center/operational-data.ts", "utf8");
const service = readFileSync("src/lib/operational-flow/operational-flow-service.ts", "utf8");

/** Strips tags so assertions read the rendered text a PM actually sees. */
const text = (html) => html.replace(/<[^>]*>/g, " ").replace(/&#x27;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();

/** Drops comments so "does not reference X" assertions test code, not prose. */
const stripComments = (source) => source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

// ── A. Canonical attention ───────────────────────────────────────────────────

test("P2-11 A: a proposed governed Recommendation with no terminal Decision appears exactly once", () => {
  assert.equal(harness.admin.all, 1);
  assert.equal(harness.admin.pending.length, 1);
  assert.deepEqual(harness.admin.needsYouIds, ["governed-rec-rec-1"]);
  // Stable identity derived from the canonical Recommendation — never a random client id.
  assert.equal(harness.admin.pending[0].id, `governed-rec-${harness.admin.pending[0].recommendationId}`);
  assert.doesNotMatch(readModel, /Math\.random|Date\.now|crypto\.randomUUID/);
});

test("P2-11 A: the attention item carries every canonical chain reference", () => {
  const item = harness.admin.pending[0];
  assert.equal(item.recommendationId, "rec-1");
  assert.equal(item.governanceEventId, "gov-1");
  assert.equal(item.riskIssueId, "risk-1");
  assert.equal(item.signalId, "sig-1");
  assert.deepEqual(item.evidenceIds, ["ev-1"]);
  assert.equal(item.provenance.normalizedEventId, "ne-1");
  assert.equal(item.provenance.rawInputId, "raw-1");
});

// ── B. No pending attention after a terminal Decision ────────────────────────

test("P2-11 B: a terminally decided Recommendation leaves the pending queue", () => {
  assert.equal(harness.decided.pendingCount, 0);
  assert.equal(harness.decided.needsYouCount, 0);
  assert.equal(harness.decided.state, "decided");
});

test("P2-11 B: a decided item is never falsely actionable", () => {
  const body = text(harness.decided.drawerMarkup);
  assert.match(body, /This recommendation has been decided/);
  assert.doesNotMatch(harness.decided.drawerMarkup, /Recording accepted/);
  // No decision-submit control survives on a decided item.
  assert.equal(/<textarea/.test(harness.decided.drawerMarkup), false);
});

test("P2-11 B: a non-terminal escalation keeps the item in the queue and does not fake resolution", () => {
  // record_operational_decision maps escalated/needs_more_evidence back to `proposed`, so the
  // Recommendation genuinely still needs a decision and must keep saying so.
  assert.match(service, /record_operational_decision/);
  assert.equal(harness.escalated.pendingCount, 1);
  assert.equal(harness.escalated.state, "awaiting_decision");
  assert.deepEqual(harness.escalated.decisions, [{ id: "dec-esc", status: "escalated", terminal: false }]);
  const body = text(harness.escalated.drawerMarkup);
  assert.match(body, /Decision recorded — escalated \(recommendation stays open\)/);
});

// ── C. Provenance ────────────────────────────────────────────────────────────

test("P2-11 C: the detail experience exposes real linked Evidence, Finding, Governance and Recommendation", () => {
  const body = text(harness.pendingDrawerMarkup);
  assert.match(body, /Client scope request/);          // Evidence title
  assert.match(body, /mail-thread\/991/);               // Source reference
  assert.match(body, /scope creep/);                    // Finding / signal type
  assert.match(body, /scope change requires sponsor/);  // Governance rule
  assert.match(body, /sponsor or PMO/);                 // Authority required
  assert.match(body, /Raise a formal Change Request/);  // Recommendation
  assert.match(body, /Recommendation ID/);
  assert.match(body, /Governance event ID/);
  assert.match(body, /Evidence ID/);
});

test("P2-11 C: provenance is real stored data, never fabricated", () => {
  const item = harness.admin.pending[0];
  assert.equal(item.provenance.sourceReference, "mail-thread/991");
  assert.equal(item.provenance.assertionType, "INFERENCE");
  assert.equal(item.why, "The client requested additional scope without a formal change request.");
  // Absent values stay null rather than being invented.
  assert.equal(harness.missingEvidence.evidenceMissing, true);
  const empty = text(harness.missingEvidence.drawerMarkup);
  assert.match(empty, /No linked evidence/);
});

test("P2-11 C: technical provenance is progressively disclosed, and raw content is never rendered", () => {
  assert.match(harness.pendingDrawerMarkup, /<details/);
  assert.match(harness.pendingDrawerMarkup, /<summary[^>]*>Provenance</);
  // Digest is truncated for disclosure; no full payload, secret or provider blob is emitted.
  assert.match(text(harness.pendingDrawerMarkup), /sha256 1111222233334444…/);
  assert.doesNotMatch(harness.pendingDrawerMarkup, /service_role|access_token|Bearer /i);
});

test("P2-11 C: confidence is reported honestly and rule score is not presented as AI confidence", () => {
  const quality = harness.admin.pending[0].evidenceQuality;
  assert.equal(quality.evidenceConfidence, 0.62);
  assert.equal(quality.ruleMatchScore, 90);
  assert.equal(quality.missingDataState, "PARTIAL");
  assert.equal(quality.freshnessState, "CURRENT");
  const body = text(harness.pendingDrawerMarkup);
  assert.match(body, /62% \(recorded at derivation\)/);
  assert.match(body, /deterministic rule, not a model score/);
  assert.match(body, /Missing data PARTIAL/);
});

// ── D. Recommendation is not the Decision ────────────────────────────────────

test("P2-11 D: before a write, the Recommendation exists and no Decision does", () => {
  assert.equal(harness.admin.pending[0].decisions.length, 0);
  const body = text(harness.pendingDrawerMarkup);
  assert.match(body, /Governed Recommendation — system output/);
  assert.match(body, /Decision Not yet recorded — a human decision is required/);
});

test("P2-11 D: after a write, the Recommendation stays identifiable alongside a separate Decision", () => {
  // The card is not replaced by "done": both objects remain legible and distinct.
  assert.equal(harness.decided.title, "Raise a formal Change Request");
  assert.equal(harness.decided.recommendationStatus, "accepted");
  const decision = harness.decided.terminalDecision;
  assert.equal(decision.decisionId, "dec-1");
  assert.equal(decision.decisionStatus, "accepted");
  assert.equal(decision.rationale, "Sponsor approved the change request.");
  assert.equal(decision.decidedBy, "user-42");
  assert.equal(decision.recordedAt, "2026-08-02T11:00:00.000Z");
  const body = text(harness.decided.drawerMarkup);
  assert.match(body, /Raise a formal Change Request/);
  assert.match(body, /Decision recorded — accepted/);
  assert.match(body, /Decision ID dec-1/);
  assert.match(body, /Evidence snapshot sha256 1111222233334444… · v3/);
});

// ── E. Status-specific authority ─────────────────────────────────────────────

test("P2-11 E: authority is honoured per Decision status, not as a coarse any-status boolean", () => {
  // Server verdict: accepted denied, rejected allowed, escalated allowed.
  assert.deepEqual(harness.synthetic.allowedStatuses, ["rejected", "escalated"]);
  const html = harness.synthetic.drawerMarkup;
  // Accept must not be rendered as a control at all.
  assert.doesNotMatch(html, /<button[^>]*>Accept</);
  assert.doesNotMatch(html, /<button[^>]*>Record modification</);
  assert.match(html, /<button[^>]*>Reject</);
  assert.match(html, /<button[^>]*>Record escalation</);
  // The item is still surfaced as decidable overall — proving the old coarse boolean would have
  // wrongly rendered Accept here.
  assert.equal(harness.admin.pending.length, 1);
});

test("P2-11 E: denied statuses are explained in text, not by colour alone", () => {
  const body = text(harness.synthetic.drawerMarkup);
  assert.match(body, /Not available to you/);
  assert.match(body, /Accept — Your role does not hold the authority this governance rule requires/);
  assert.match(body, /Record modification —/);
});

test("P2-11 E: the real authority mapping flows through unchanged for a PM under a sponsor rule", () => {
  // Contract fidelity: evaluateOperationalDecisionAuthority denies terminal statuses to a PM when
  // the governance rule requires sponsor authority, and permits only the non-terminal ones.
  assert.deepEqual(harness.pm.allowedStatuses.sort(), ["escalated", "needs_more_evidence"]);
  assert.deepEqual(harness.pm.deniedStatuses.sort(), ["accepted", "modified", "rejected"]);
  assert.equal(harness.pm.anyDecisionAllowed, true);
});

test("P2-11 E: authority is never re-derived client-side from role names", () => {
  for (const source of [readModel, operationalData, drawer]) {
    assert.doesNotMatch(source, /===\s*"(owner|admin|pm|viewer)"/);
    assert.doesNotMatch(source, /actorRole|workspace_memberships/);
  }
  // The read model reads only the server-evaluated per-status map, and fails closed.
  assert.match(readModel, /actor_authority/);
  assert.match(readModel, /evaluation\?\.allowed === true/);
});

test("P2-11 E: only canonical Decision statuses are offered; no UI-only status is invented", () => {
  assert.deepEqual(harness.contract.decisionOptionStatuses.sort(), [
    "accepted", "escalated", "modified", "needs_more_evidence", "rejected",
  ]);
  assert.equal(harness.contract.hasDeferredStatus, false);
  assert.deepEqual(harness.contract.terminalStatuses, ["accepted", "rejected", "modified"]);
  // The governed path no longer silently remaps a "Defer" button onto `escalated`.
  assert.doesNotMatch(layout, /=== "deferred" \? "escalated"/);
});

// ── F. Read-only actor ───────────────────────────────────────────────────────

test("P2-11 F: a read-only actor can inspect provenance but cannot submit a Decision", () => {
  assert.deepEqual(harness.viewer.allowedStatuses, []);
  assert.equal(harness.viewer.anyDecisionAllowed, false);
  assert.equal(harness.viewer.stillVisibleInQueue, 1);
  const html = harness.viewer.drawerMarkup;
  assert.equal(/<textarea/.test(html), false);
  assert.doesNotMatch(html, /<button[^>]*>Accept</);
  const body = text(html);
  assert.match(body, /your role cannot record a Decision on it/);
  assert.match(body, /Your role is read-only for governed decisions/);
  // Inspection still works.
  assert.match(body, /Client scope request/);
  assert.match(body, /scope change requires sponsor/);
});

// ── G. Write failure ─────────────────────────────────────────────────────────

test("P2-11 G: a failed record_decision keeps the drawer open, retains the rationale and shows the error", () => {
  // Interaction-dependent, so asserted against the component contract: the submit handler awaits
  // the caller's promise, and on rejection sets an error without clearing rationale or closing.
  assert.match(drawer, /catch \(caught\) \{[\s\S]*setError\(/);
  const catchBlock = drawer.slice(drawer.indexOf("} catch (caught) {"), drawer.indexOf("} finally {"));
  assert.doesNotMatch(catchBlock, /setRationale\(""\)/);
  assert.doesNotMatch(catchBlock, /onClose/);
  assert.match(drawer, /role="alert"/);
  // The layout no longer swallows the failure, so the rejection reaches the drawer.
  assert.doesNotMatch(layout, /catch \{\s*\/\/ Leave the drawer open/);
  assert.match(layout, /Rejects on failure so the drawer keeps the rationale/);
});

test("P2-11 G: success is never shown optimistically", () => {
  // The rendered result is the revalidated server state, not the request payload.
  assert.match(layout, /await mutateFlow\(\);/);
  assert.match(drawer, /Success is never assumed/);
  assert.doesNotMatch(drawer, /setDecisions\(|optimisti/i);
});

// ── H. Stale / already decided ───────────────────────────────────────────────

test("P2-11 H: an open drawer reconciles from persisted state instead of a stale snapshot", () => {
  // The drawer is addressed by stable id and re-resolved from the freshest derived items on every
  // render, so a decision recorded elsewhere reconciles the open view.
  assert.match(layout, /openAttentionId/);
  // Resolved on every render rather than stored as a snapshot. (P2-12 added a governed
  // continuation branch ahead of this one; the attention branch itself is unchanged.)
  assert.match(layout, /const activeDrawer =/);
  assert.match(layout, /openAttentionId\s*\n?\s*\?\s*\(\[\.\.\.governedAttentionAll/);
  assert.match(layout, /governedAttentionAll, \.\.\.raidNeedsYou\]\.find/);
  // And the reconciled state genuinely removes the controls.
  assert.equal(/<textarea/.test(harness.decided.drawerMarkup), false);
  assert.match(text(harness.decided.drawerMarkup), /This recommendation has been decided/);
});

test("P2-11 H: concurrent submits are blocked per interaction rather than by a global fake lock", () => {
  assert.match(drawer, /disabled=\{pendingStatus !== null \|\| rationaleMissing\}/);
  assert.match(drawer, /setPendingStatus\(null\)/);
});

// ── I. RAID distinction ──────────────────────────────────────────────────────

test("P2-11 I: RAID suggestions and governed Recommendations cannot be mistaken for one another", () => {
  assert.deepEqual(harness.raid.kinds, ["raid_suggestion"]);
  assert.deepEqual(harness.admin.needsYouKinds, ["governed_recommendation"]);
  assert.deepEqual(harness.raid.badges, ["Suggestion · extracted intelligence"]);
  assert.deepEqual(harness.governedBadges, ["Governed · decision required"]);
  assert.notDeepEqual(harness.raid.badges, harness.governedBadges);
});

test("P2-11 I: the two paths use different write paths and different authority language", () => {
  const raidWritePath = harness.raid.writePathLabels[0];
  assert.match(raidWritePath, /\/api\/recommended-actions\/decision/);
  assert.match(raidWritePath, /No canonical operational Decision record is created/);
  const raidBody = text(harness.raid.markup);
  assert.match(raidBody, /not a governed Recommendation and carries no governance authority requirement/);
  const governedBody = text(harness.pendingDrawerMarkup);
  assert.match(governedBody, /Records a canonical operational_decision_records entry/);
  assert.doesNotMatch(raidBody, /operational_decision_records/);
});

test("P2-11 I: the bounded RAID vocabulary keeps `deferred`, which the governed path does not have", () => {
  assert.deepEqual(harness.raid.controlStatuses, [["accepted", "rejected", "deferred"]]);
  assert.equal(harness.contract.hasDeferredStatus, false);
});

test("P2-11 I: no model fusion — governed recommendations are the only canonical source", () => {
  // The service only ever returns governance-linked rows as canonical recommendations.
  assert.match(service, /recommended_actions[\s\S]{0,120}\.not\("governance_event_id", "is", null\)/);
  // The read model derives attention solely from that list, and never touches RAID data.
  assert.match(readModel, /summary\.recommendations \?\? \[\]/);
  assert.doesNotMatch(stripComments(readModel), /raid|recommended-actions/i);
  // The RAID path never reads or writes canonical operational records.
  const raidDerive = operationalData.slice(operationalData.indexOf("export function deriveRaidNeedsYou"));
  assert.doesNotMatch(stripComments(raidDerive), /operational_decision_records|record_decision/);
});

// ── J. No automatic Action ───────────────────────────────────────────────────

test("P2-11 J: recording a Decision creates no Action, Task, Outcome or Observation", () => {
  const downstream = [
    "propose_material_action",
    "dispatch_material_action_to_task",
    "ensure_expected_outcome",
    "record_outcome_observation",
  ];
  // The attention surfaces themselves never reference a downstream operation.
  for (const source of [drawer, readModel]) {
    for (const operation of downstream) assert.doesNotMatch(source, new RegExp(operation));
  }
  // The layout never posts one directly.
  for (const operation of downstream) {
    assert.doesNotMatch(layout, new RegExp(`operation: "${operation}"`));
  }
  // P2-12 added an explicit continuation helper to operational-data. Everything the
  // decision path uses sits before it, and must still reference no downstream operation —
  // so a Decision cannot create an Action, Task, Outcome or Observation.
  const beforeContinuation = operationalData.slice(0, operationalData.indexOf("export async function runExecutionOperation"));
  assert.ok(beforeContinuation.length > 0, "the continuation helper must be identifiable");
  for (const operation of downstream) {
    assert.doesNotMatch(beforeContinuation, new RegExp(operation));
  }
  // record_decision is the only operation the decision path posts.
  const decideBlock = layout.slice(layout.indexOf("const handleDecide"), layout.indexOf("const handleRaidDecide"));
  assert.match(decideBlock, /operation: "record_decision"/);
  assert.equal((decideBlock.match(/operation:/g) ?? []).length, 1);
  // And the server-side decision path itself only records the decision.
  const recordDecision = service.slice(service.indexOf("export async function recordHumanDecision"));
  assert.match(recordDecision.slice(0, 600), /rpc\("record_operational_decision"/);
});

test("P2-11 J: the experience states that a Decision is not an Action", () => {
  const body = text(harness.pendingDrawerMarkup);
  assert.match(body, /does not create an Action, Task or Outcome/);
});

// ── K. Tenancy ───────────────────────────────────────────────────────────────

test("P2-11 K: every read and write is workspace + project scoped", () => {
  assert.match(operationalData, /workspaceId=\$\{encodeURIComponent\(workspaceId\)\}&projectId=\$\{encodeURIComponent\(projectId\)\}/);
  assert.match(operationalData, /JSON\.stringify\(\{ workspaceId, projectId, \.\.\.payload \}\)/);
  assert.match(layout, /postOperationalFlow\(workspaceId, selectedProject\?\.id \?\? ""/);
});

test("P2-11 K: a recommendation from another project is not addressable from this project", () => {
  // Attention is projected only from the scoped summary, so a foreign id yields no item and
  // therefore no decision control that could target it.
  assert.equal(harness.foreignRecommendation.lookup, 0);
  assert.equal(harness.admin.pending.length, 1);
  assert.equal(harness.admin.pending[0].recommendationId, "rec-1");
});

// ── L. Loading / empty / error ───────────────────────────────────────────────

test("P2-11 L: loading, empty and error states all render honestly", () => {
  assert.match(text(harness.queue.loading), /Checking what needs your attention/);
  // UX-W2 restated the empty state in the PM's own words. The invariant is unchanged and is
  // what this asserts: an empty queue says there is nothing to decide, and says it plainly.
  assert.match(text(harness.queue.empty), /You're clear\./);
  assert.match(text(harness.queue.empty), /Nothing currently requires your decision or review\./);
  const errorBody = text(harness.queue.error);
  assert.match(errorBody, /We couldn't load project attention/);
  assert.match(errorBody, /Try again/);
  // An error must never be rendered as a reassuring empty state.
  assert.doesNotMatch(errorBody, /You're clear\./);
  assert.doesNotMatch(errorBody, /Nothing currently requires your decision or review\./);
});

test("P2-11 L: a load failure is not silently treated as 'still loading'", () => {
  assert.match(layout, /const flowLoading = flowData === undefined && !flowError;/);
  // UX-W2 lifted this into a named value the screen passes to every attention surface, so
  // one failed read cannot be a failure in one section and an empty success in the next.
  assert.match(layout, /const attentionErrorMessage = flowError \? "We couldn't load project attention\." : null;/);
  assert.match(layout, /attentionErrorMessage=\{attentionErrorMessage\}/);
});

// ── M. Accessibility ─────────────────────────────────────────────────────────

test("P2-11 M: the drawer has correct dialog semantics and an accessible name", () => {
  assert.match(harness.pendingDrawerMarkup, /role="dialog"/);
  assert.match(harness.pendingDrawerMarkup, /aria-modal="true"/);
  assert.match(harness.pendingDrawerMarkup, /aria-labelledby="([^"]+)"/);
  const labelledBy = harness.pendingDrawerMarkup.match(/aria-labelledby="([^"]+)"/)[1];
  assert.match(harness.pendingDrawerMarkup, new RegExp(`<h2 id="${labelledBy}"`));
});

test("P2-11 M: focus moves into the drawer on open and returns to the trigger on close", () => {
  assert.match(drawer, /restoreFocusRef\.current = document\.activeElement/);
  assert.match(drawer, /headingRef\.current\?\.focus\(\)/);
  assert.match(drawer, /if \(previous && document\.contains\(previous\)\) previous\.focus\(\)/);
  assert.match(drawer, /event\.key === "Escape"/);
  assert.match(harness.pendingDrawerMarkup, /tabindex="-1"/);
});

test("P2-11 M: provenance and decision sections use semantic headings", () => {
  for (const heading of ["Why this matters", "How PMFreak got here", "Evidence", "Details", "Your decision"]) {
    assert.match(harness.pendingDrawerMarkup, new RegExp(`<h3[^>]*>${heading}</h3>`));
  }
  assert.match(harness.pendingDrawerMarkup, /<section aria-labelledby=/);
});

test("P2-11 M: queue and status updates are announced, and controls are keyboard reachable", () => {
  // The heading id is generated per mount (React `useId`) rather than hardcoded: the
  // Command Center mounts this queue twice for responsive surfaces, and a document-global
  // id would appear twice and point `aria-labelledby` at a hidden heading. What matters is
  // that the section is labelled BY ITS OWN heading, so assert the association, not a
  // literal string.
  const queueHeadingId = harness.queue.populated.match(/<section aria-labelledby="([^"]+)"/)?.[1];
  assert.ok(queueHeadingId, "populated queue section carries aria-labelledby");
  assert.match(harness.queue.populated, new RegExp(`<h2 id="${queueHeadingId}"`));
  assert.match(harness.queue.error, /role="status" aria-live="polite"/);
  assert.match(harness.pendingDrawerMarkup, /aria-live="polite"/);
  // Every attention item is a real button, so it is tabbable and activates on Enter/Space.
  assert.match(harness.queue.populated, /<li><button type="button"/);
  assert.match(harness.queue.populated, /focus-visible:ring/);
  // Decision controls are buttons with descriptive text, not divs.
  assert.match(harness.pendingDrawerMarkup, /<button type="button"[^>]*aria-describedby=/);
});

test("P2-11 M: no interactive element is nested inside another", () => {
  for (const html of [harness.pendingDrawerMarkup, harness.queue.populated, harness.viewer.drawerMarkup]) {
    assert.doesNotMatch(html, /<button(?:(?!<\/button>)[\s\S])*<button/);
    assert.doesNotMatch(html, /<a\b(?:(?!<\/a>)[\s\S])*<button/);
  }
});

test("P2-11 M: the attention queue is reachable on a small screen without opening anything", () => {
  // Until UX-W2 the queue was a desktop rail plus a copy inside the right-hand mobile
  // overlay, and reaching it on a phone meant opening a drawer first. It is now a section of
  // the main document at every width, so the reachability this test protects is stronger,
  // not weaker: nothing has to be opened, and the queue is mounted exactly once.
  const canvas = layout.slice(layout.indexOf("<CommandCenterCanvas"));
  assert.match(canvas, /needsYouItems=\{needsYouItems\}/);
  assert.equal((layout.match(/MobileOverlay open=\{rightOpen\}/g) ?? []).length, 0);
  // Project navigation may still be an overlay, and it is still dismissible by keyboard.
  assert.match(layout, /aria-label="Close panel"/);
});

// ── N. Refresh durability + fixture policy ───────────────────────────────────

test("P2-11 N: the rendered result is revalidated persisted state, so a refresh keeps it", () => {
  assert.match(operationalData, /revalidateOnFocus: true/);
  assert.match(operationalData, /refreshInterval: 30000/);
  // Decisions render from summary.decisions, which is loaded from operational_decision_records.
  assert.match(readModel, /summary\.decisions \?\? \[\]/);
  assert.match(service, /from\("operational_decision_records"\)/);
  assert.equal(harness.decided.terminalDecision.decisionId, "dec-1");
});

test("P2-11 fixtures: no fixture is rendered as live, and demo data does not feed the queue", () => {
  // fixture_state is read from the persisted row, never inferred.
  assert.match(readModel, /fixture_state/);
  assert.match(readModel, /isFixture: str\(evidence\?\.fixture_state\) === "DEMO_FIXTURE"/);
  assert.equal(harness.admin.pending[0].evidenceQuality.fixtureState, "LIVE");
  assert.equal(harness.admin.pending[0].evidenceQuality.isFixture, false);
  // demo-data.ts is not imported by any Command Center rendering path.
  assert.doesNotMatch(layout, /demo-data/);
  assert.doesNotMatch(operationalData, /demo-data/);
});

test("P2-11 scope: no second aggregate, no schema change, no AOC writeback", () => {
  assert.doesNotMatch(readModel, /supabase|from\(["']|insert|rpc\(/);
  assert.match(readModel, /It owns no records/);
  assert.doesNotMatch(layout, /allowDecisionWriteback/);
});
