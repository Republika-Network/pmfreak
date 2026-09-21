/**
 * P2-17 — PMO-visible attention states.
 *
 * Renders the real PmoAttentionView (react-dom/server) for every state a PMO can meet, from
 * projections produced by the REAL builder — never hand-written view models. The authenticated
 * browser journey on the canonical PMO Command Center is tests/e2e/p2-17-pmo-attention.spec.ts.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PmoAttentionView, formatConfidence, formatEvaluatedAt, type PmoAttentionViewState } from "@/components/pmfreak/pmos/pmo-attention-panel";
import { buildPmoPortfolioAttention, type PmoAttentionInput, type PmoProjectSignalInput } from "@/lib/pmos/pmo-portfolio-attention";

const u = (n: string) => `00000000-0000-4000-8000-${n.padStart(12, "0")}`;
const WS = u("a1");
const PMO = u("f1");
const EVAL = "2026-10-20T12:00:00.000Z";

const basis: PmoProjectSignalInput = { evidenceBasis: { canonical: 2, live: 2 }, outcomeCount: 1, schedule: { exposures: [], currentSnapshotDigest: "sha256:none" } };
const none: PmoProjectSignalInput = { evidenceBasis: { canonical: 0, live: 0 }, outcomeCount: 0, schedule: { exposures: [], currentSnapshotDigest: "sha256:none" } };

function input(options: { stale?: boolean; fixture?: boolean; bare?: boolean; quietOnly?: boolean; statuses?: string[] } = {}): PmoAttentionInput {
  const projects = [
    { id: u("101"), name: "Atlas", status: options.statuses?.[0] ?? "active" },
    { id: u("102"), name: "Orion", status: options.statuses?.[1] ?? "active" },
    ...(options.bare ? [{ id: u("104"), name: "Bare", status: "active" }] : []),
  ];
  const evidence = (id: string, project: string) => ({ id, project_id: project, source_type: "manual_note", fixture_state: options.fixture ? "DEMO_FIXTURE" : "LIVE", freshness_state: options.stale ? "STALE" : "CURRENT", lifecycle: "RECORDED", stale_at: null });
  const risks = options.quietOnly ? [] : [
    { id: u("21"), project_id: u("101"), signal_id: u("11"), type: "risk", title: "Vendor slip", severity: "critical", status: "open", updated_at: EVAL },
    { id: u("22"), project_id: u("102"), signal_id: u("12"), type: "issue", title: "Scope dispute", severity: "high", status: "monitoring", updated_at: EVAL },
  ];
  return {
    workspaceId: WS,
    pmoId: PMO,
    evaluatedAt: EVAL,
    projects,
    perProject: { [u("101")]: basis, [u("102")]: basis, ...(options.bare ? { [u("104")]: none } : {}) },
    batch: {
      risks: { ok: true, rows: risks, truncated: false },
      recommendations: { ok: true, rows: [], truncated: false },
      outcomes: { ok: true, rows: [], truncated: false },
      observations: { ok: true, rows: [], truncated: false },
      signals: { ok: true, rows: [
        { id: u("11"), project_id: u("101"), evidence_item_id: u("e1"), confidence_score: 92, signal_type: "delivery_impediment" },
        { id: u("12"), project_id: u("102"), evidence_item_id: u("e2"), confidence_score: 84, signal_type: "scope_creep" },
      ], truncated: false },
      evidence: { ok: true, rows: [evidence(u("e1"), u("101")), evidence(u("e2"), u("102"))], truncated: false },
    },
  };
}

const render = (state: PmoAttentionViewState) => renderToStaticMarkup(createElement(PmoAttentionView, { state }));
const ready = (i: PmoAttentionInput) => render({ kind: "ready", attention: buildPmoPortfolioAttention(i) });
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/\s+/g, " ");

test("P2-17 UI: loading, error/retry and unauthorized are distinct, labelled states", () => {
  const loading = render({ kind: "loading" });
  assert.match(loading, /role="status"/);
  assert.match(loading, /aria-busy="true"/);
  assert.match(text(loading), /Loading PMO attention/);

  const error = render({ kind: "error", retryHref: `/workspaces/${WS}/pmos/${PMO}/command-center` });
  assert.match(error, /role="alert"/);
  assert.match(error, new RegExp(`<a href="/workspaces/${WS}/pmos/${PMO}/command-center"[^>]*>Try again</a>`));
  assert.match(text(error), /no assessment is shown rather than a partial one presented as complete/);

  const denied = render({ kind: "denied" });
  assert.match(denied, /role="alert"/);
  assert.match(text(denied), /do not have access/);
});

test("P2-17 UI: qualified attention shows why, how confident, how complete, and where to drill down", () => {
  const html = ready(input());
  const t = text(html);
  assert.match(html, /aria-labelledby="pmo-attention-heading"/);
  assert.match(html, /<h2 id="pmo-attention-heading"/);
  assert.match(t, /Evaluated 2026-10-20 12:00 UTC · membership [0-9a-f]{12} \(2 projects\)/);
  assert.match(t, /Need attention 2/);
  assert.match(t, /Coverage 2 \/ 2 active projects Complete · of 2 in this PMO/);
  assert.match(t, /Confidence 84% Weakest recorded claim shown · separate from coverage/);
  assert.match(t, /Assessment covers all 2 active projects with current inputs/);
  // Grouped and ordered by level: Critical before High.
  assert.ok(t.indexOf("Critical attention") < t.indexOf("High attention"));
  assert.ok(t.indexOf("Atlas") < t.indexOf("Orion"));
  assert.match(t, /Unresolved risk · Critical: Vendor slip \(open\)\./);
  assert.match(t, /Confidence 92% · operational_signals\.confidence_score ÷ 100/);
  assert.match(html, /Rule <code class="font-mono">finding\.unresolved\.critical<\/code>/);
  assert.match(t, /Inference/);
  assert.match(t, /Current/);
  assert.match(html, new RegExp(`href="/workspaces/${WS}/projects/${u("101")}/command-center"`));
  assert.match(html, new RegExp(`href="/workspaces/${WS}/command-center\\?projectId=${u("101")}"`));
  assert.match(html, /aria-label="Open project: Atlas"/);
  assert.match(t, /Cross-project dependencies: unsupported/);
  assert.match(t, /Resource conflict analysis unavailable/);
  assert.match(html, /<caption class="sr-only">Coverage by signal dimension/);
  assert.match(html, /<th scope="row"/);
  // No invented health semantics, no fixture label on live data.
  assert.doesNotMatch(t, /healthy|health score|Health \d/i);
  assert.doesNotMatch(t, /Demo data/);
});

test("P2-17 UI: partial coverage is stated as not a complete PMO assessment", () => {
  const t = text(ready(input({ bare: true })));
  assert.match(t, /Partial assessment: PMFreak could assess 2 of 3 active projects\. This is not a complete PMO assessment\./);
  assert.match(t, /Coverage 2 \/ 3 active projects Incomplete/);
  assert.match(t, /Not assessed Bare Missing inputs/);
  assert.match(t, /No canonical Evidence has been recorded for this project/);
});

test("P2-17 UI: with nothing to flag, absence of signals is never presented as health", () => {
  const complete = text(ready(input({ quietOnly: true })));
  assert.match(complete, /No supported attention signal was found in the 2 assessed projects\. This is not a health rating\./);
  assert.match(complete, /Confidence Not recorded/);
  const partial = text(ready(input({ quietOnly: true, bare: true })));
  assert.match(partial, /This is not a health rating and does not cover the projects listed as not assessed\./);
});

test("P2-17 UI: stale inputs are labelled on the reason and in the portfolio banner", () => {
  const html = ready(input({ stale: true }));
  const t = text(html);
  assert.match(html, /data-state="stale"/);
  assert.match(t, /Some inputs are stale or superseded\. They are labelled on each reason and are not presented as current\./);
  assert.match(t, /Stale · operational_signals|Stale Inference/);
  assert.match(t, /Evidence freshness STALE/);
  assert.doesNotMatch(t, /with current inputs/);
});

test("P2-17 UI: a superseded schedule exposure is shown as provenance, never as attention", () => {
  const i = input({ quietOnly: true });
  // Atlas's only schedule exposure was recorded against a schedule that has since changed.
  const exposure = {
    evidenceId: u("e5"), materializationState: "complete", confidence: 0.8, freshnessState: "CURRENT", fixtureState: "LIVE",
    recordedAt: EVAL, snapshotDigest: "sha256:old", severity: "critical",
    exposures: [{ milestoneId: u("m1"), title: "Go-live", isCritical: true, networkSlipDays: 15, forecastVarianceDays: null }],
    finding: { id: u("15") }, recommendation: { id: u("31"), status: "proposed" },
  } as unknown as NonNullable<PmoProjectSignalInput["schedule"]>["exposures"][number];
  i.perProject = { ...i.perProject, [u("101")]: { ...basis, schedule: { exposures: [exposure], currentSnapshotDigest: "sha256:new" } } };
  const html = ready(i);
  const t = text(html);
  assert.match(t, /Need attention 0/);
  assert.doesNotMatch(t, /Critical attention/);
  assert.match(html, /data-testid="pmo-attention-superseded"/);
  assert.match(t, /Superseded · not counted toward attention Critical Stale/);
  assert.match(t, /schedule changed since this evaluation \(snapshot superseded\)/);
  assert.match(t, /does not count toward attention until the schedule is re-evaluated/);
});

test("P2-17 UI: fixture records are labelled and cannot pass as live intelligence", () => {
  // Customer wording shared with the P2-16 schedule panel; the internal "DEMO / FIXTURE" term
  // is kept out of customer UX (tests/ux-w0-public-launch-blockers.test.mjs).
  const t = text(ready(input({ fixture: true })));
  assert.ok((t.match(/Demo data — not a live project record/g) ?? []).length >= 3, "labelled on the portfolio, the project and the reason");
  // A project whose only canonical basis is demo Evidence is labelled even with no reason to show.
  const quietFixture = buildPmoPortfolioAttention({ ...input({ quietOnly: true }), perProject: { [u("101")]: { ...basis, evidenceBasis: { canonical: 2, live: 0 } }, [u("102")]: basis } });
  const quiet = text(render({ kind: "ready", attention: quietFixture }));
  assert.match(quiet, /Assessed, no supported attention signal Atlas Demo data — not a live project record Assessed/);
});

test("P2-17 UI: empty PMO and no active projects each say what is true", () => {
  const empty = text(ready({ ...input(), projects: [], perProject: {} }));
  assert.match(empty, /This PMO has no projects, so there is nothing to assess\./);
  assert.doesNotMatch(empty, /Need attention/);
  const inactive = text(ready(input({ statuses: ["completed", "archived"] })));
  assert.match(inactive, /None of this PMO's 2 projects are active\. Attention is assessed for active projects only\./);
  assert.match(inactive, /Cross-project dependencies: unsupported/);
});

test("P2-17 UI: formatting helpers are deterministic and scale-explicit", () => {
  assert.equal(formatEvaluatedAt("2026-10-20T12:34:56.000Z"), "2026-10-20 12:34 UTC");
  assert.equal(formatEvaluatedAt("not a date"), "unknown time");
  assert.equal(formatConfidence({ value: 0.845, scale: "unit_interval", source: "x" }), "85%");
  assert.equal(formatConfidence(null), "Not recorded");
});
