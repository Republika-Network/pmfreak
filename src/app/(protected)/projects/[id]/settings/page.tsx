import Link from "next/link";
import { notFound } from "next/navigation";
import { requireAuthUser } from "@/lib/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { evaluateCapabilityAccess } from "@/lib/security/capability-flow";
import { listPmos } from "@/lib/pmos/pmo-service";
import { ProjectSettingsClient } from "@/components/pmfreak/projects/project-settings-client";
import { ProjectTabNav } from "@/components/pmfreak/projects/project-tab-nav";
import { projectHomePath } from "@/lib/projects/project-paths";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ id: string }> };

/**
 * Project Settings — rename, restatus, move between PMOs, change
 * methodology/icon/color, duplicate, or delete this project.
 *
 * DELIBERATELY NOT MIGRATED BY THIS SLICE, for the same reason as Project Chat:
 * `07-route-layout-and-navigation-architecture.md` §2's ratified Project family
 * has no `settings` member, so there is no canonical destination to move to and
 * inventing `/workspaces/W/projects/P/settings` would be inventing architecture.
 * Only its two Project-Home links changed — the breadcrumb and the tab strip now
 * lead to canonical Project Home, built from the `projects.workspace_id` this
 * page already reads and already authorizes against.
 */
export default async function ProjectSettingsPage({ params }: Props) {
  await requireAuthUser();
  const { id } = await params;
  const supabase = await createSupabaseServerClient();

  const { data: project } = await supabase
    .from("projects")
    .select("id, workspace_id, pmo_id, name, description, status, methodology, icon, color")
    .eq("id", id)
    .maybeSingle();
  if (!project) notFound();

  await evaluateCapabilityAccess({ workspaceId: project.workspace_id, projectId: project.id, permission: "write" });

  const pmos = await listPmos(project.workspace_id);

  return (
    <main className="space-y-5">
      <header className="rounded-3xl border border-slate-200 bg-white p-6">
        <p className="text-xs uppercase tracking-[0.24em] text-cyan-800">
          <Link href={projectHomePath(project.workspace_id, project.id)} className="hover:text-cyan-900">{project.name}</Link> / Settings
        </p>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight text-slate-900">
          {project.icon ? <span className="mr-2">{project.icon}</span> : null}
          {project.name} — Settings
        </h1>
        <div className="mt-4">
          <ProjectTabNav workspaceId={project.workspace_id} projectId={project.id} active="settings" />
        </div>
      </header>

      <ProjectSettingsClient
        project={{
          id: project.id,
          name: project.name,
          description: project.description,
          status: project.status,
          methodology: project.methodology,
          icon: project.icon,
          color: project.color,
          pmo_id: project.pmo_id,
        }}
        pmos={pmos.map((pmo) => ({ id: pmo.id, name: pmo.name, icon: pmo.icon }))}
      />
    </main>
  );
}
