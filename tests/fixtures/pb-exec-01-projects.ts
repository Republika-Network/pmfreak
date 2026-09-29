/**
 * PB-EXEC-01 — execution-brief project fixtures.
 *
 * Shared by tests/pb-exec-01-execution-brief.test.ts (deterministic behaviour) and
 * scripts/pb-exec-01/certify-execution-brief.ts (real-provider certification). Built on
 * the PB-REASON-01/02 fixture base, so the workspace, project, user, clock and FOREIGN_*
 * isolation rows are identical.
 *
 * No fixture here contains a credential or a secret-shaped value: certification sends
 * these records to a real model, and credential-guard behaviour is tested locally with
 * fabricated shapes only.
 */

import type { ProjectBrainRawContext } from "../../src/lib/project-brain/conversation/context-builder";
import { base, PROJECT, WS } from "./pb-reason-01-projects";

export { FIXTURE_NOW, FOREIGN_PROJECT, PROJECT, scope, USER, WS } from "./pb-reason-01-projects";

/**
 * Rows with FIXED ids: fingerprint tests compare briefs built from two separate fixture
 * instances, so stable evidence ids must not depend on construction order.
 */
const row = (id: string, extra: Record<string, unknown>) => ({ id: `f00000${id}-0000-4000-8000-000000000000`, workspace_id: WS, project_id: PROJECT, ...extra });
const completed = (id: string, title: string, day: string) =>
  row(id, { title, status: "completed", target_date: day, completed_at: `${day}T17:00:00.000Z`, created_at: "2026-06-01T09:00:00.000Z", updated_at: `${day}T17:00:00.000Z` });

export const EXPORT_SPEC_ID = "e0000001-0000-4000-8000-000000000001";

/** The export spec evidence item — the one source whose revision marker the digest tests move. */
export function exportSpecEvidence(overrides: Record<string, unknown> = {}) {
  return {
    id: EXPORT_SPEC_ID,
    workspace_id: WS,
    project_id: PROJECT,
    title: "Invoice export specification",
    source_type: "document_reference",
    content: "Finance needs a CSV export of one billing period's invoices from the billing page. The billing test suite runs with `npm run test:billing`. Export code lives in src/billing/export/.",
    fixture_state: "LIVE",
    freshness_state: "CURRENT",
    version: 1,
    evidence_hash: "spec-hash-v1",
    created_at: "2026-09-10T09:00:00.000Z",
    updated_at: "2026-09-10T09:00:00.000Z",
    ...overrides,
  };
}

/**
 * P11/P12 complete, P13 in progress (the record), P14 "Invoice export" planned, one
 * accepted decision (voided invoices excluded) and one export spec evidence item.
 */
export function p14ExportProject(evidence: Record<string, unknown> = exportSpecEvidence()): ProjectBrainRawContext {
  return base({
    name: "Republika Billing",
    description: "Billing platform program",
    contractualMilestones: "P11 API; P12 adapters; P13 billing-period model; P14 invoice export; go-live by 2026-12-15",
    milestones: [
      completed("11", "P11 Public API", "2026-08-01"),
      completed("12", "P12 Adapters", "2026-09-10"),
      row("13", { title: "P13 Billing-period model", status: "in_progress", target_date: "2026-09-30", created_at: "2026-06-01T09:00:00.000Z", updated_at: "2026-09-12T09:00:00.000Z" }),
      row("14", { title: "P14 Invoice export", status: "planned", description: "CSV export of one billing period's invoices from the billing page.", target_date: "2026-10-15", created_at: "2026-06-01T09:00:00.000Z", updated_at: "2026-09-12T09:00:00.000Z" }),
    ],
    decisions: [
      row("d1", { decision: "Invoice exports must exclude voided invoices", decision_status: "accepted", rationale: "Finance cannot reconcile voided lines.", created_at: "2026-09-20T10:00:00.000Z" }),
    ],
    evidence: [evidence],
  });
}

/** A project whose only open work is a stakeholder report (not software). */
export function steeringReportProject(): ProjectBrainRawContext {
  return base({
    name: "Republika Billing",
    description: "Billing platform program",
    milestones: [row("q4", { title: "Q4 steering committee report", status: "planned", description: "One-page status report for the steering committee.", target_date: "2026-10-20", created_at: "2026-06-01T09:00:00.000Z", updated_at: "2026-09-12T09:00:00.000Z" })],
  });
}
