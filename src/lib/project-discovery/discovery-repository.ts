import { createHash } from "node:crypto";
import { isArchivedProjectStatus } from "@/lib/projects/archived-project";

import { createPrivilegedSupabaseClient } from "@/lib/security/privileged-access";
import { generateProjectDiscovery, type DiscoveryEvidenceContent, type ProjectDiscoveryModel } from "@/lib/project-discovery/discovery-agent";
import { materializeProjectDiscoveryRaidItems } from "@/lib/project-discovery/raid-materialization";
import { materializeRecommendedActions } from "@/lib/recommended-actions";

type DiscoveryRow = {
  id: string;
  project_id: string;
  workspace_id: string;
  version: number;
  stakeholders_json: ProjectDiscoveryModel["stakeholders"];
  dependencies_json: ProjectDiscoveryModel["dependencies"];
  risks_json: ProjectDiscoveryModel["risks"];
  milestones_json: ProjectDiscoveryModel["milestones"];
  deliverables_json: ProjectDiscoveryModel["deliverables"];
  assumptions_json: ProjectDiscoveryModel["assumptions"];
  unknowns_json: ProjectDiscoveryModel["unknowns"];
  confidence_score: number;
  discovery_payload_hash: string | null;
  evidence_count: number;
  generated_at: string;
  created_at: string;
  updated_at: string;
};

const countFindings = (discovery: ProjectDiscoveryModel) =>
  discovery.stakeholders.length + discovery.dependencies.length + discovery.risks.length + discovery.milestones.length + discovery.deliverables.length + discovery.assumptions.length + discovery.unknowns.length;

type DiscoveryPayload = Pick<
  ProjectDiscoveryModel,
  | "stakeholders"
  | "dependencies"
  | "risks"
  | "milestones"
  | "deliverables"
  | "assumptions"
  | "unknowns"
  | "confidence_score"
  | "evidence_count"
>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const sortObjectKeysDeep = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map((item) => sortObjectKeysDeep(item));
  }

  if (!isRecord(value)) {
    return value;
  }

  return Object.keys(value)
    .sort()
    .reduce<Record<string, unknown>>((sorted, key) => {
      const sortedValue = sortObjectKeysDeep(value[key]);

      if (sortedValue !== undefined) {
        sorted[key] = sortedValue;
      }

      return sorted;
    }, {});
};

export const deterministicDiscoveryPayloadStringify = (payload: DiscoveryPayload) =>
  JSON.stringify(sortObjectKeysDeep(payload)) ?? "null";

export const buildDiscoveryPayload = (discovery: ProjectDiscoveryModel): DiscoveryPayload => ({
  assumptions: discovery.assumptions,
  confidence_score: discovery.confidence_score,
  deliverables: discovery.deliverables,
  dependencies: discovery.dependencies,
  evidence_count: discovery.evidence_count,
  milestones: discovery.milestones,
  risks: discovery.risks,
  stakeholders: discovery.stakeholders,
  unknowns: discovery.unknowns,
});

export const hashDiscoveryPayload = (discovery: ProjectDiscoveryModel) =>
  createHash("sha256")
    .update(deterministicDiscoveryPayloadStringify(buildDiscoveryPayload(discovery)))
    .digest("hex");

export async function regenerateProjectDiscovery(input: { projectId: string; requestId?: string }) {
  const startedAt = Date.now();
  const supabase = createPrivilegedSupabaseClient({
    routeId: "ProjectDiscoveryAgent.regenerateProjectDiscovery",
    operation: "project_discovery.regenerate",
    reason: "Create versioned project discovery from canonical evidence",
    systemActor: "background_job",
  });

  console.info("[project_discovery] Discovery Started", { requestId: input.requestId, projectId: input.projectId });

  try {
    // The tenant is the project's own workspace, read from `projects` — never from an evidence
    // row, which a member of another workspace could have written against this project id (F22-A).
    const { data: project, error: projectError } = await supabase
      .from("projects")
      .select("id,workspace_id,status")
      .eq("id", input.projectId)
      .maybeSingle<{ id: string; workspace_id: string; status: string }>();

    if (projectError) throw new Error(`Unable to resolve project workspace: ${projectError.message}`);
    if (!project?.workspace_id) {
      console.warn("[project_discovery] Discovery Skipped", { requestId: input.requestId, projectId: input.projectId, reason: "project_not_found" });
      return null;
    }
    // PD-25: an upload accepted just before archival still finishes extracting, but derives no
    // new discovery, RAID items or recommendations on the now read-only project.
    if (isArchivedProjectStatus(project.status)) {
      console.warn("[project_discovery] Discovery Skipped", { requestId: input.requestId, projectId: input.projectId, reason: "project_archived" });
      return null;
    }
    const workspaceId = project.workspace_id;

    const { data: evidenceRows, error: evidenceError } = await supabase
      .from("project_evidence_content")
      .select("id,evidence_id,project_id,workspace_id,source_file_name,extracted_text,created_at")
      .eq("project_id", input.projectId)
      .eq("workspace_id", workspaceId)
      .order("created_at", { ascending: true });

    if (evidenceError) throw new Error(`Unable to load canonical evidence: ${evidenceError.message}`);
    const typedEvidence = (evidenceRows ?? []) as DiscoveryEvidenceContent[];

    if (typedEvidence.length === 0) {
      console.info("[project_discovery] Discovery Completed", { requestId: input.requestId, projectId: input.projectId, evidenceCount: 0, findingsCount: 0, confidenceScore: 0, durationMs: Date.now() - startedAt });
      return null;
    }

    const discovery = generateProjectDiscovery(typedEvidence);
    const discoveryPayloadHash = hashDiscoveryPayload(discovery);

    const { data: latestRows, error: versionError } = await supabase
      .from("project_discovery")
      .select("id,project_id,workspace_id,version,stakeholders_json,dependencies_json,risks_json,milestones_json,deliverables_json,assumptions_json,unknowns_json,confidence_score,evidence_count,discovery_payload_hash,generated_at,created_at,updated_at")
      .eq("project_id", input.projectId)
      .eq("workspace_id", workspaceId)
      .order("version", { ascending: false })
      .limit(1);

    if (versionError) throw new Error(`Unable to resolve discovery version: ${versionError.message}`);
    const latestDiscovery = (latestRows ?? [])[0] as DiscoveryRow | undefined;

    if (latestDiscovery?.discovery_payload_hash === discoveryPayloadHash) {
      await materializeProjectDiscoveryRaidItems({
        discovery,
        discoveryId: latestDiscovery.id,
        discoveryVersion: latestDiscovery.version,
        workspaceId,
        projectId: input.projectId,
        supabase,
        requestId: input.requestId,
      });
      await materializeRecommendedActions({ workspaceId, projectId: input.projectId, supabase, requestId: input.requestId });
      console.info("[project_discovery] Discovery Completed", { requestId: input.requestId, projectId: input.projectId, evidenceCount: discovery.evidence_count, findingsCount: countFindings(discovery), confidenceScore: discovery.confidence_score, version: latestDiscovery.version, skipped: true, reason: "unchanged_payload", durationMs: Date.now() - startedAt });
      return latestDiscovery;
    }

    const latestVersion = Number(latestDiscovery?.version ?? 0);
    const nextVersion = latestVersion + 1;
    const generatedAt = new Date().toISOString();

    const { data: inserted, error: insertError } = await supabase
      .from("project_discovery")
      .insert({
        project_id: input.projectId,
        workspace_id: workspaceId,
        version: nextVersion,
        stakeholders_json: discovery.stakeholders,
        dependencies_json: discovery.dependencies,
        risks_json: discovery.risks,
        milestones_json: discovery.milestones,
        deliverables_json: discovery.deliverables,
        assumptions_json: discovery.assumptions,
        unknowns_json: discovery.unknowns,
        confidence_score: discovery.confidence_score,
        discovery_payload_hash: discoveryPayloadHash,
        evidence_count: discovery.evidence_count,
        generated_at: generatedAt,
      })
      .select("id,project_id,workspace_id,version,stakeholders_json,dependencies_json,risks_json,milestones_json,deliverables_json,assumptions_json,unknowns_json,confidence_score,evidence_count,discovery_payload_hash,generated_at,created_at,updated_at")
      .single();

    if (insertError) throw new Error(`Unable to persist discovery: ${insertError.message}`);

    const insertedDiscovery = inserted as DiscoveryRow;
    await materializeProjectDiscoveryRaidItems({
      discovery,
      discoveryId: insertedDiscovery.id,
      discoveryVersion: nextVersion,
      workspaceId,
      projectId: input.projectId,
      supabase,
      requestId: input.requestId,
    });
    await materializeRecommendedActions({ workspaceId, projectId: input.projectId, supabase, requestId: input.requestId });

    console.info("[project_discovery] Discovery Completed", { requestId: input.requestId, projectId: input.projectId, evidenceCount: discovery.evidence_count, findingsCount: countFindings(discovery), confidenceScore: discovery.confidence_score, version: nextVersion, durationMs: Date.now() - startedAt });
    return insertedDiscovery;
  } catch (error) {
    console.error("[project_discovery] Discovery Failed", { requestId: input.requestId, projectId: input.projectId, durationMs: Date.now() - startedAt, error: error instanceof Error ? error.message : "unknown" });
    throw error;
  }
}

export const regenerateProjectDiscoveryInBackground = (input: { projectId: string; requestId?: string }) => {
  setTimeout(() => {
    void regenerateProjectDiscovery(input).catch(() => undefined);
  }, 0);
};
