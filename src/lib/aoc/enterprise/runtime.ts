import {
  enforceGovernancePipeline,
  evaluateGovernancePipeline,
  type GovernanceEvaluationInput,
} from "@/lib/governance/authority/runtime";
import { denyResponse } from "@/lib/security/deny-response";
import { isProjectArchivedDenial, projectArchivedResponse } from "@/lib/projects/archived-project";
import { ensurePmfreakAocAdaptersRegistered, getEnterpriseRuntimeComposeOptions } from "@/lib/aoc/bootstrap";
import type { SecurityEventType } from "@/lib/security/telemetry";

export type { GovernanceEvaluationInput } from "@/lib/governance/authority/runtime";

export async function evaluateRuntimeAuthorization(input: GovernanceEvaluationInput) {
  ensurePmfreakAocAdaptersRegistered();
  return evaluateGovernancePipeline(input, getEnterpriseRuntimeComposeOptions());
}

export async function enforceRuntimeAuthorization(input: GovernanceEvaluationInput) {
  ensurePmfreakAocAdaptersRegistered();
  const { decision } = await enforceGovernancePipeline(input, getEnterpriseRuntimeComposeOptions());
  if (!decision.allowed) {
    // PD-25: a write to an archived project is a state conflict (409), not a permission failure.
    if (isProjectArchivedDenial(decision.reason)) return { decision, response: projectArchivedResponse() };
    const response = denyResponse({
      status: 403,
      routeId: input.routeId,
      message: "Governance denied.",
      reason: decision.reason,
      eventType: decision.auditEventType as SecurityEventType,
      actorUserId: decision.actor.userId,
      actorAgentId: decision.actor.agentId,
      workspaceId: decision.scope.workspaceId,
      projectId: decision.scope.projectId,
    });
    return { decision, response };
  }
  return { decision, response: null };
}
