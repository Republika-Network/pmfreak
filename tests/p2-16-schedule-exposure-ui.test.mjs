import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

/**
 * P2-16 — PM-visible schedule exposure.
 *
 * Renders the real ScheduleExposureView (react-dom/server) for every state via
 * tests/p2-16-schedule-exposure-harness.tsx, from records produced by the real adapter.
 * The authenticated browser journey is tests/e2e/p2-16-schedule-exposure.spec.ts.
 */
const r = JSON.parse(
  execFileSync(process.execPath, ["node_modules/tsx/dist/cli.mjs", "tests/p2-16-schedule-exposure-harness.tsx"], {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  }).trim(),
);
// `&amp;` is decoded LAST, so every encoded entity is unescaped at most once (CodeQL js/double-escaping).
const text = (html) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/\s+/g, " ");

test("P2-16 UI: the markup-to-text helper decodes each entity exactly once", () => {
  assert.equal(text("&amp;quot;"), "&quot;", "an encoded entity must not be double-unescaped");
  assert.equal(text("&amp;#x27;"), "&#x27;");
  assert.equal(text("&quot;"), '"');
  assert.equal(text("&amp;"), "&");
  assert.equal(text("&#x27;"), "'");
});

test("P2-16 UI: the harness fixtures really exercise each engine outcome", () => {
  assert.deepEqual(r.statuses, { complete: "qualified", partial: "qualified", cyclic: "invalid_topology", insufficient: "insufficient_data" });
});

test("P2-16 UI: loading, error, denied and empty are distinct, labelled states", () => {
  assert.match(r.loading, /role="status"/);
  assert.match(text(r.loading), /Loading schedule exposure/);
  assert.match(r.error, /role="alert"/);
  assert.match(r.error, /<button type="button"[^>]*>Try again<\/button>/);
  assert.match(r.denied, /role="alert"/);
  assert.match(text(r.denied), /do not have access/);
  assert.match(r.empty, /data-testid="schedule-exposure-empty"/);
  assert.doesNotMatch(r.empty, /schedule-exposure-item/);
  for (const html of [r.loading, r.error, r.denied, r.empty]) {
    assert.match(html, /<section aria-labelledby="[^"]+" data-testid="schedule-exposure-panel"/);
    assert.match(html, /<h2 id="[^"]+"[^>]*>Schedule exposure<\/h2>/);
  }
});

test("P2-16 UI: a qualified exposure shows what changed, why it matters, confidence, coverage and supporting evidence", () => {
  const t = text(r.qualified);
  assert.match(t, /What changed/);
  assert.match(t, /Dependency "Design" → "Build" \(finish to start\) is proposed → active\./);
  assert.match(t, /Why it matters/);
  assert.match(t, /Go-live : The dependency network finishes the linked work 4 day\(s\) after the target date\./);
  assert.match(t, /not an observed fact or a cause/, "inference is never presented as fact or causality");
  assert.match(t, /Confidence 90%/);
  assert.match(t, /method schedule-coverage:v1/);
  assert.match(t, /All schedule inputs the engine reads were present\./);
  assert.match(r.qualified, /<summary[^>]*>Supporting evidence<\/summary>/);
  assert.match(r.qualified, /data-testid="schedule-exposure-snapshot">sha256:[a-f0-9]{64}</);
  assert.match(t, /schedule-engine:h9-v1/);
  assert.match(t, /Recommendation \(proposed; a Decision is recorded separately\)/);
  assert.match(t, /Recorded as Evidence, a Finding and a proposed Recommendation\. No decision has been made\./);
  assert.match(t, /Inference/);
  assert.match(t, /Complete data/, "coverage is stated in words, not only by colour");
  assert.match(t, /Severity: high/);
});

test("P2-16 UI: confidence scales are explicit — 0.9 Evidence and a persisted 90.00 Finding both render as 90%", () => {
  assert.equal(r.confidence.persistedFinding, 90);
  assert.equal(r.confidence.evidence, "90%");
  assert.equal(r.confidence.finding, "90%");
  assert.doesNotMatch(r.qualified, /9000%|0\.9%|9200/);
  assert.match(text(r.qualified), /score 90%/);
});

test("P2-16 UI: partial coverage is shown with the missing inputs and the lower confidence", () => {
  const t = text(r.partial);
  assert.match(t, /Partial data/);
  assert.match(t, /Confidence 60%/);
  assert.match(t, /1 of 3 task\(s\) have no planned start\/finish; the engine treats each as one day\./);
  assert.doesNotMatch(t, /All schedule inputs the engine reads were present/);
});

test("P2-16 UI: invalid topology is a degraded alert that states nothing was computed or recorded", () => {
  assert.match(r.refused, /role="alert" data-testid="schedule-exposure-refused"/);
  const t = text(r.refused);
  assert.match(t, /Degraded: the schedule topology is invalid\./);
  assert.match(t, /Cycle detected:/);
  assert.match(t, /No critical path was computed and nothing was recorded\./);
  assert.doesNotMatch(t, /Confidence \d+%/);
});

test("P2-16 UI: insufficient data states the gaps and records nothing", () => {
  assert.match(r.insufficient, /data-testid="schedule-exposure-insufficient"/);
  const t = text(r.insufficient);
  assert.match(t, /Insufficient schedule data — exposure cannot be stated\./);
  assert.match(t, /Nothing was recorded\./);
  assert.doesNotMatch(t, /Confidence \d+%/);
});

test("P2-16 UI: evaluation actions are keyboard-reachable buttons with accessible names, and withheld from viewers", () => {
  assert.match(r.empty, /<button type="button" data-testid="schedule-exposure-evaluate" aria-label="Evaluate exposure for dependency Design → Build"/);
  assert.match(r.empty, /aria-label="Evaluate current state of milestone Go-live"/);
  assert.match(text(r.empty), /Milestone \(current state\): Go-live/, "finding #4: the milestone path is labelled as a current-state evaluation");
  assert.doesNotMatch(text(r.empty), /date change/i);
  assert.doesNotMatch(r.viewer, /schedule-exposure-evaluate/);
  assert.match(text(r.viewer), /Only project owners, admins and PMs can evaluate schedule changes\./);
  assert.match(r.busy, /disabled=""[^>]*>Evaluating…<\/button>/);
  assert.match(r.evaluateDenied, /role="alert"/);
  assert.match(text(r.duplicate), /Already recorded for this schedule state and change — nothing new was created\./);
});

test("P2-16 UI finding #5: an incomplete chain is an alert with a resume action, never a normal exposure", () => {
  assert.match(r.incomplete, /data-testid="schedule-exposure-incomplete" role="alert"/);
  const t = text(r.incomplete);
  assert.match(t, /Schedule evaluation recorded, but the Finding and Recommendation did not finish materializing\. No decision or action has been created\./);
  assert.match(r.incomplete, /<button type="button" data-testid="schedule-exposure-resume"[^>]*>Resume materialization<\/button>/);
  assert.doesNotMatch(r.incomplete, /data-testid="schedule-exposure-item"/, "it is not rendered as a complete exposure");
  assert.doesNotMatch(t, /Confidence \d+%|Recommendation \(proposed/);
  assert.doesNotMatch(r.incompleteViewer, /schedule-exposure-resume/, "a viewer is not offered resume");
  assert.match(text(r.incompleteViewer), /A project owner, admin or PM can resume it\./);
});

test("P2-16 UI: fixture data can never be mistaken for live", () => {
  // Customer surfaces use the sanctioned customer wording, never the internal lineage label (UX-W0).
  assert.match(text(r.fixture), /Demo data — not a live project record/);
  assert.doesNotMatch(text(r.qualified), /Demo data/);
  assert.doesNotMatch(r.fixture + r.qualified, /DEMO \/ FIXTURE/);
});

test("P2-16 UI: the panel is mounted on the PM Command Center and refreshes the canonical flow after recording", () => {
  // CHAT-SHELL-01: mounted as the project conversation's Schedule tool, by the same
  // operations component that owns the canonical flow it refreshes.
  const layout = readFileSync("src/modules/workspace/screens/command-center/command-center-layout.tsx", "utf8");
  assert.match(layout, /tool === "schedule"/);
  assert.match(layout, /<ScheduleExposurePanel\s+key=\{selectedProject\.id\}\s+workspaceId=\{workspaceId\}\s+projectId=\{selectedProject\.id\}\s+onRecorded=\{\(\) => void mutateFlow\(\)\}/);
  const panel = readFileSync("src/components/pmfreak/schedule-exposure/schedule-exposure-panel.tsx", "utf8");
  assert.match(panel, /fetch\(`\/api\/critical-path\/schedule-exposure\?\$\{params\.toString\(\)\}`, \{ cache: "no-store" \}\)/);
  assert.doesNotMatch(panel, /record_decision|propose_material_action|dispatch_material_action/, "the panel never records a Decision or Action");
});
