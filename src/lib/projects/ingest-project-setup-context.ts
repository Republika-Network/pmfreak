import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createSupabaseVaultIntakeStore, ingestVaultDocument } from "@/lib/vault/intake";
import { materializeRecommendedActions } from "@/lib/recommended-actions";
import { captureOperationalInput, deriveEvidence } from "@/lib/operational-flow/operational-flow-service";
import { DEMO_FIXTURE_INTAKE_SOURCE_KEY } from "@/lib/operational-flow/intake-source-keys";
import type { OperationalWorkspaceRole } from "@/lib/operational-flow/authority";

export type ProjectSetupContextIngestionResult = {
  vaultIngested: boolean;
  raidItemsDetected: number;
  recommendedActionsCreated: number;
  evidenceRecorded: boolean;
};

/**
 * Feeds the context a founder typed while creating a project into the same
 * intelligence pipelines the Command Center notes intake uses: vault ingestion
 * (RAID extraction), RAID -> recommended-actions materialization, and the
 * operational evidence/decision chain. Every stage is best-effort — project
 * creation must never fail because downstream intelligence did.
 */
export async function ingestProjectSetupContext(input: {
  supabase: SupabaseClient;
  workspaceId: string;
  projectId: string;
  userId: string;
  companyId?: string | null;
  role: OperationalWorkspaceRole | null;
  projectName: string;
  content: string;
  /**
   * When set, the operational chain's idempotency keys (and correlation id)
   * derive from it instead of a fresh random id, so repeating the same
   * ingestion (a resumed Project Brain activation) records the evidence once.
   * Must be a UUID — it is also the chain's correlation id. Omitted, every call
   * is a new capture, as before.
   */
  idempotencyScope?: string;
}): Promise<ProjectSetupContextIngestionResult> {
  const result: ProjectSetupContextIngestionResult = {
    vaultIngested: false,
    raidItemsDetected: 0,
    recommendedActionsCreated: 0,
    evidenceRecorded: false,
  };
  const content = input.content.trim();
  if (!content) return result;

  try {
    const ingestion = await ingestVaultDocument({
      workspaceId: input.workspaceId,
      companyId: input.companyId ?? null,
      projectId: input.projectId,
      rawContent: content,
      title: `${input.projectName} — setup context`,
      sourceType: "project_update",
      createdBy: input.userId,
      store: createSupabaseVaultIntakeStore(input.supabase),
    });
    result.vaultIngested = ingestion.ingestionStatus !== "document_persistence_failed";
    result.raidItemsDetected = ingestion.raidItemsCreated + ingestion.raidItemsUpdated;
  } catch (error) {
    console.error("project.setup_context.vault_ingestion_failed", {
      projectId: input.projectId,
      error: error instanceof Error ? error.message : "unknown",
    });
  }

  if (result.vaultIngested) {
    try {
      const materialization = await materializeRecommendedActions({
        workspaceId: input.workspaceId,
        projectId: input.projectId,
        supabase: input.supabase,
      });
      result.recommendedActionsCreated = materialization.created;
    } catch (error) {
      console.error("project.setup_context.recommended_actions_failed", {
        projectId: input.projectId,
        error: error instanceof Error ? error.message : "unknown",
      });
    }
  }

  if (["owner", "admin", "pm"].includes(String(input.role))) {
    try {
      const scope = { workspaceId: input.workspaceId, projectId: input.projectId, userId: input.userId, role: input.role };
      const requestId = input.idempotencyScope ?? randomUUID();
      const captured = await captureOperationalInput(input.supabase, scope, {
        // Single source of truth for the DEMO / FIXTURE identity. This is a server-side
        // service call, so the route's pin does not apply — the constant is what keeps it
        // from drifting away from the identity the product boundary resolves.
        sourceKey: DEMO_FIXTURE_INTAKE_SOURCE_KEY,
        idempotencyKey: `capture:${requestId}`,
        title: `${input.projectName} — setup context`,
        content,
        occurredAt: new Date().toISOString(),
        correlationId: requestId,
      });
      await deriveEvidence(input.supabase, scope, {
        normalizedEventId: String((captured.normalizedEvent as Record<string, unknown>).id), idempotencyKey: `evidence:${requestId}`,
        assertionType: "ASSUMPTION", classification: "UNCLASSIFIED", confidenceScore: 0.5,
        missingDataState: "UNKNOWN", evaluatedAt: new Date().toISOString(),
      });
      result.evidenceRecorded = true;
    } catch (error) {
      console.error("project.setup_context.operational_chain_failed", {
        projectId: input.projectId,
        error: error instanceof Error ? error.message : "unknown",
      });
    }
  }

  return result;
}
