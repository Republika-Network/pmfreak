import { createSupabaseServerClient } from "@/lib/supabase/server";
import {
  EXECUTION_TASK_SELECTABLE_COLUMNS,
  EXECUTION_TASK_DEPENDENCY_SELECTABLE_COLUMNS,
  PROJECT_MILESTONE_SELECTABLE_COLUMNS,
  type ExecutionTaskRow,
  type ExecutionTaskDependencyRow,
  type ProjectMilestoneRow,
} from "@/lib/db/database-contract";
import { buildNormalizedDag } from "./normalize-graph";
import type { NormalizedDAG } from "./types";

const TASK_SELECT = EXECUTION_TASK_SELECTABLE_COLUMNS.join(",");
const DEP_SELECT = EXECUTION_TASK_DEPENDENCY_SELECTABLE_COLUMNS.join(",");
const MILESTONE_SELECT = PROJECT_MILESTONE_SELECTABLE_COLUMNS.join(",");

export async function loadGraph(input: { projectId: string }): Promise<
  { ok: true; dag: NormalizedDAG } | { ok: false; error: string }
> {
  const supabase = await createSupabaseServerClient();

  const [tasksResult, depsResult, milestonesResult] = await Promise.all([
    supabase
      .from("execution_tasks")
      .select(TASK_SELECT)
      .eq("project_id", input.projectId)
      .overrideTypes<ExecutionTaskRow[], { merge: false }>(),
    supabase
      .from("execution_task_dependencies")
      .select(DEP_SELECT)
      .eq("project_id", input.projectId)
      .eq("status", "active")
      .overrideTypes<ExecutionTaskDependencyRow[], { merge: false }>(),
    supabase
      .from("project_milestones")
      .select(MILESTONE_SELECT)
      .eq("project_id", input.projectId)
      .overrideTypes<ProjectMilestoneRow[], { merge: false }>(),
  ]);

  if (tasksResult.error || depsResult.error || milestonesResult.error) {
    return { ok: false, error: "Failed to load graph data." };
  }

  const tasks = tasksResult.data ?? [];
  const deps = depsResult.data ?? [];
  const milestones = milestonesResult.data ?? [];

  // Edges whose endpoint is not a loaded task are left out, exactly as before.
  const { dag } = buildNormalizedDag(tasks, deps, milestones);
  return { ok: true, dag };
}
