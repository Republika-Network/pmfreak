"use server";

import { redirect } from "next/navigation";
import { requireAuthUser } from "@/lib/auth";
import { canCreateMoreProjects } from "@/lib/feature-gates";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { resolveRoutedWorkspace } from "@/lib/workspaces/routed-workspace";
import { ensureDefaultPmo } from "@/lib/pmos/pmo-service";
import { generateAndPersistOperationalGovernanceBrief } from "@/lib/projects/first-insight";
import { ingestProjectSetupContext } from "@/lib/projects/ingest-project-setup-context";
import { workspaceCommandCenterPath } from "@/lib/workspace/command-center-paths";

const asField = (value: FormDataEntryValue | null) => String(value ?? "").trim();

/**
 * Creates the workspace's first project from the Command Center empty state.
 *
 * `workspaceId` is BOUND by the canonical route, so it is the workspace whose
 * URL the user is actually looking at — not whatever their preferred-workspace
 * cookie happens to name. That distinction is the whole point: on a shared deep
 * link to workspace B while the cookie still says A, the previous
 * `resolveWriteWorkspace(user.id)` created the project in A and redirected
 * there, silently writing to a tenant the user never named.
 *
 * A bound argument is still client-reachable, so it is authorized here rather
 * than trusted. `resolveRoutedWorkspace` has no fallback: it authorizes this
 * exact workspace or refuses. Archived workspaces are refused too — this is a
 * mutation, and archived is read-only
 * (`07-route-layout-and-navigation-architecture.md` §7).
 */
export async function activateContextAction(workspaceId: string, formData: FormData) {
  const user = await requireAuthUser();

  const access = await resolveRoutedWorkspace(user.id, workspaceId);
  if (access.access !== "granted") {
    console.error(
      JSON.stringify({
        event: "command_center.activate_denied",
        userId: user.id,
        workspaceId,
        access: access.access,
      }),
    );
    redirect("/workspaces?error=" + encodeURIComponent("You cannot create a project in that workspace"));
  }

  const supabase = await createSupabaseServerClient();

  const name = asField(formData.get("name"));
  if (!name) {
    redirect(workspaceCommandCenterPath(workspaceId, { error: "Project name is required" }));
  }

  const projectAccess = await canCreateMoreProjects(user.id);
  if (!projectAccess.ok) {
    redirect(`/projects?error=${encodeURIComponent("upgrade_required")}&feature=${encodeURIComponent(projectAccess.feature)}&requiredPlan=${projectAccess.requiredPlan}`);
  }

  const descriptionInput = asField(formData.get("description"));
  const sponsor = asField(formData.get("sponsor"));
  const phase = asField(formData.get("phase"));
  const timeline = asField(formData.get("timeline"));
  const risk = asField(formData.get("risk"));
  const stakeholders = asField(formData.get("stakeholders"));

  const setupSummary = [
    sponsor ? `Customer/Sponsor: ${sponsor}` : null,
    phase ? `Current phase: ${phase}` : null,
    timeline ? `Timeline pressure: ${timeline}` : null,
    risk ? `Top known risk: ${risk}` : null,
    stakeholders ? `Key stakeholders: ${stakeholders}` : null,
  ].filter(Boolean);

  const description = [descriptionInput, setupSummary.length ? `Setup context\n${setupSummary.join("\n")}` : null]
    .filter(Boolean)
    .join("\n\n") || null;

  const ensured = { workspaceId: access.workspaceId, role: access.role };
  const defaultPmo = await ensureDefaultPmo(ensured.workspaceId, user.id);
  const { data, error } = await supabase
    .from("projects")
    .insert({ user_id: user.id, workspace_id: ensured.workspaceId, pmo_id: defaultPmo.id, name, description })
    .select("id")
    .single<{ id: string }>();

  if (error || !data?.id) {
    redirect(workspaceCommandCenterPath(ensured.workspaceId, { error: error?.message ?? "Unable to activate context" }));
  }

  // Feed the founder's setup context into the real intelligence loop (vault
  // RAID extraction + operational evidence chain) so the Command Center they
  // land on reflects what they just told us. Best-effort: creation survives
  // any downstream failure.
  if (description) {
    await ingestProjectSetupContext({
      supabase,
      workspaceId: ensured.workspaceId,
      projectId: data.id,
      userId: user.id,
      companyId: user.companyId,
      role: ensured.role,
      projectName: name,
      content: description,
    });
  }

  // First governance brief — generated after ingestion so detected RAID items
  // are part of it (parity with the other project-creation flows).
  let briefFailed = false;
  try {
    const briefResult = await generateAndPersistOperationalGovernanceBrief({
      workspaceId: ensured.workspaceId,
      projectId: data.id,
      projectOnboardingPayload: {
        identity: { projectName: name, clientOrganization: sponsor, projectType: "other", pmAssigned: user.email ?? user.id },
        deliveryContext: { problemStatement: descriptionInput, mainDeliverable: name, scopeType: "discovery" },
        discovery: { unknowns: risk, pendingClientDependencies: "" },
        setup: { sponsor, phase, timeline, risk, stakeholders },
        createdAt: new Date().toISOString(),
      },
      createdBy: user.id,
      supabase,
    });
    briefFailed = !briefResult.ok;
  } catch {
    briefFailed = true;
  }

  redirect(
    workspaceCommandCenterPath(ensured.workspaceId, {
      projectId: data.id,
      from: "onboarding",
      briefGeneration: briefFailed ? "failed" : undefined,
    }),
  );
}
