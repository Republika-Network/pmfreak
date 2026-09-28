/**
 * PB-REASON-02 — reported-working-context project fixtures.
 *
 * Shared by tests/pb-reason-02-reported-working-context.test.ts (deterministic
 * behaviour) and scripts/pb-reason-02/eval-real-provider.ts (real-provider
 * certification). Built on the PB-REASON-01 fixture base, so the workspace,
 * project, user, clock and FOREIGN_* isolation rows are identical.
 *
 * The canonical records here are deliberately behind (or ahead of) what the user
 * says in conversation: that gap is the whole point of reported working context.
 */

import type { ProjectBrainRawContext } from "../../src/lib/project-brain/conversation/context-builder";
import { base, row } from "./pb-reason-01-projects";

export { FIXTURE_NOW, FOREIGN_PROJECT, PROJECT, scope, USER, WS } from "./pb-reason-01-projects";

const completed = (title: string, day: string) =>
  row({ title, status: "completed", target_date: day, completed_at: `${day}T17:00:00.000Z`, created_at: "2026-06-01T09:00:00.000Z", updated_at: `${day}T17:00:00.000Z` });

const PLAN = "P10 ledger; P11 API; P12 adapters; P13 authenticity; P14 settlement exports; go-live by 2026-12-15";

function program(p13: Record<string, unknown>): ProjectBrainRawContext {
  return base({
    name: "Republika Core",
    description: "Core platform program",
    contractualMilestones: PLAN,
    milestones: [
      completed("P11 Public API", "2026-08-01"),
      completed("P12 Adapters", "2026-09-10"),
      row({ title: "P13 Authenticity", created_at: "2026-06-01T09:00:00.000Z", ...p13 }),
    ],
  });
}

/** Canonical: P12 complete, P13 still pending (the record lags a merge the user reports). */
export function p13PendingProject(): ProjectBrainRawContext {
  return program({ status: "in_progress", target_date: "2026-09-30", updated_at: "2026-09-12T09:00:00.000Z" });
}

/** Canonical record has caught up: P13 completed. */
export function p13CompletedProject(): ProjectBrainRawContext {
  return program({ status: "completed", target_date: "2026-09-30", completed_at: "2026-09-26T09:00:00.000Z", updated_at: "2026-09-26T09:00:00.000Z" });
}

/** Records are silent on milestones: only the setup plan exists. */
export function noMilestoneRecordsProject(): ProjectBrainRawContext {
  return base({ name: "Republika Core", description: "Core platform program", contractualMilestones: PLAN });
}

/** Canonical: the production deployment FAILED (an open issue record). */
export function deploymentFailedProject(): ProjectBrainRawContext {
  const project = p13PendingProject();
  project.summary!.risksIssues.unshift(
    row({ type: "issue", title: "Production deployment failed", status: "open", severity: "critical", description: "The 2026-09-25 production deployment failed its health checks and was rolled back.", created_at: "2026-09-25T18:00:00.000Z" }),
  );
  return project;
}
