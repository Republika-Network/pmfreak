import { createSupabaseServerClient } from "@/lib/supabase/server";
import { isArchivedProjectStatus } from "@/lib/projects/archived-project";

/**
 * PD-25: true when the project is visible to the caller (RLS applies) and archived. Used by the
 * routes that authorize another way than the project-permission adapter, before they write.
 */
export async function isArchivedProject(projectId: string | null | undefined): Promise<boolean> {
  if (!projectId) return false;
  const supabase = await createSupabaseServerClient();
  const { data } = await supabase.from("projects").select("status").eq("id", projectId).maybeSingle<{ status: string }>();
  return isArchivedProjectStatus(data?.status);
}
