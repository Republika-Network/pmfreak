// Regression coverage for the durable initial-ingestion lifecycle.
//
// The Project Intelligence Inbox is the canonical first experience after
// Command Center activation. Before this, the only signal was the transient
// `brainActivated=1` query parameter — set by just one of the two
// project-creation paths and lost on refresh. These tests pin the durable
// replacement, and specifically pin that the marker is LIFECYCLE state, never
// a content proxy: "this project has no evidence" must never be what decides
// whether onboarding is shown.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  readInitialIngestionStatus,
  withInitialIngestionStatus,
  resolveCommandCenterLanding,
} from "../src/lib/projects/initial-ingestion-state.ts";

const PAGE_SRC = readFileSync("src/app/(protected)/workspaces/[workspaceId]/command-center/page.tsx", "utf8");
const ACTION_SRC = readFileSync("src/app/(protected)/command-center/ingestion-actions.ts", "utf8");

// ── reading an untrusted jsonb payload ──────────────────────────────────────

test("a missing payload reads as not_started", () => {
  assert.equal(readInitialIngestionStatus(null), "not_started");
  assert.equal(readInitialIngestionStatus(undefined), "not_started");
  assert.equal(readInitialIngestionStatus({}), "not_started");
});

test("a malformed payload reads as not_started", () => {
  assert.equal(readInitialIngestionStatus("nonsense"), "not_started");
  assert.equal(readInitialIngestionStatus(42), "not_started");
  assert.equal(readInitialIngestionStatus({ initialIngestion: "in_progress" }), "not_started");
  assert.equal(readInitialIngestionStatus({ initialIngestion: null }), "not_started");
  assert.equal(readInitialIngestionStatus({ initialIngestion: {} }), "not_started");
});

test("every valid status round-trips", () => {
  for (const status of ["not_started", "in_progress", "completed"]) {
    assert.equal(
      readInitialIngestionStatus({ initialIngestion: { status, updatedAt: "2026-07-22T00:00:00.000Z" } }),
      status,
    );
  }
});

test("an unknown status fails safe to not_started", () => {
  assert.equal(readInitialIngestionStatus({ initialIngestion: { status: "ready" } }), "not_started");
  assert.equal(readInitialIngestionStatus({ initialIngestion: { status: 7 } }), "not_started");
});

// ── writing without clobbering the rest of onboarding_payload ───────────────

test("writing the marker preserves unrelated onboarding_payload keys and does not mutate the input", () => {
  const existing = {
    identity: { technicalLead: "Ada" },
    deliveryContext: { mainDeliverable: "Platform" },
    discovery: { unknowns: "scope" },
  };
  const written = withInitialIngestionStatus(existing, "in_progress", "2026-07-22T10:00:00.000Z");

  assert.deepEqual(written.identity, existing.identity);
  assert.deepEqual(written.deliveryContext, existing.deliveryContext);
  assert.deepEqual(written.discovery, existing.discovery);
  assert.deepEqual(written.initialIngestion, { status: "in_progress", updatedAt: "2026-07-22T10:00:00.000Z" });
  assert.equal(readInitialIngestionStatus(written), "in_progress");
  assert.equal("initialIngestion" in existing, false, "the original payload must not be mutated");
});

// ── landing derivation ──────────────────────────────────────────────────────

test("the activation hint can force ingestion open from any status", () => {
  for (const ingestionStatus of ["not_started", "in_progress", "completed"]) {
    assert.equal(resolveCommandCenterLanding({ ingestionStatus, activationHint: true }), "ingestion");
  }
});

test("only a completed guided entry lands on the dashboard", () => {
  assert.equal(resolveCommandCenterLanding({ ingestionStatus: "completed", activationHint: false }), "dashboard");
  assert.equal(resolveCommandCenterLanding({ ingestionStatus: "not_started", activationHint: false }), "ingestion");
  assert.equal(resolveCommandCenterLanding({ ingestionStatus: "in_progress", activationHint: false }), "ingestion");
});

// ── wiring contracts ────────────────────────────────────────────────────────

test("the command-center page derives the landing view from the durable marker, not the query param alone", () => {
  assert.match(PAGE_SRC, /readInitialIngestionStatus\(/, "page must read the durable marker");
  assert.match(PAGE_SRC, /resolveCommandCenterLanding\(/, "page must derive the landing view");
  assert.match(PAGE_SRC, /firstRun=\{landingView === "ingestion"\}/, "the inbox must open from the derived view");
  assert.ok(
    !/firstRun=\{brainJustActivated\}/.test(PAGE_SRC),
    "the transient query param must no longer be the sole source of truth",
  );
});

test("the ingestion marker is never derived from evidence counts", () => {
  for (const proxy of ["project_evidence", "evidence_items", "hasIngestedEvidence", "evidenceCount"]) {
    assert.ok(
      !PAGE_SRC.includes(proxy),
      `landing must not use ${proxy} as a lifecycle proxy — absence of content is not absence of onboarding`,
    );
  }
});

test("the ingestion action stays workspace-scoped on both read and write, and never regresses a completed entry", () => {
  // The workspace is now the ROUTED one, authorized by resolveRoutedWorkspace,
  // rather than one re-resolved from the preferred-workspace cookie. The
  // invariant this test guards is unchanged: read AND write stay scoped.
  const scoped = ACTION_SRC.match(/\.eq\("workspace_id", access\.workspaceId\)/g) ?? [];
  assert.ok(scoped.length >= 2, "both the read and the write must be workspace-scoped");
  assert.match(ACTION_SRC, /current === "completed"/, "a completed guided entry must never be regressed");
  assert.ok(
    !ACTION_SRC.includes("createSupabaseServiceRoleClient"),
    "the marker write must use the user-scoped client so RLS remains the backstop",
  );
});
