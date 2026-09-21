import type {
  ExecutionTaskRow,
  ExecutionTaskDependencyRow,
  ProjectMilestoneRow,
} from "@/lib/db/database-contract";
import { resolveTaskDuration } from "./duration";
import type { NormalizedDAG, CriticalPathEdge } from "./types";

/** An active dependency whose predecessor or successor is not in the loaded task set. */
export type DroppedDependencyEdge = {
  dependencyId: string;
  predecessorTaskId: string;
  successorTaskId: string;
  missingTaskIds: string[];
};

/**
 * Pure graph normalization shared by `loadGraph` (H9 materialization) and the P2-16
 * schedule exposure adapter. Behaviour is exactly what `loadGraph` always did — an edge
 * whose endpoint is not a loaded task is left out of the DAG — but the dropped edges are
 * now returned so a caller that must not treat an incomplete graph as complete can see them.
 */
export function buildNormalizedDag(
  tasks: ExecutionTaskRow[],
  activeDependencies: ExecutionTaskDependencyRow[],
  milestones: ProjectMilestoneRow[],
): { dag: NormalizedDAG; droppedEdges: DroppedDependencyEdge[] } {
  const taskSet = new Set(tasks.map((t) => t.id));

  const nodes = new Map<string, { task: ExecutionTaskRow; duration: number }>();
  for (const task of tasks) {
    nodes.set(task.id, { task, duration: resolveTaskDuration(task) });
  }

  const edges: CriticalPathEdge[] = [];
  const predecessorMap = new Map<string, string[]>();
  const successorMap = new Map<string, string[]>();
  const droppedEdges: DroppedDependencyEdge[] = [];

  for (const task of tasks) {
    predecessorMap.set(task.id, []);
    successorMap.set(task.id, []);
  }

  for (const dep of activeDependencies) {
    if (!taskSet.has(dep.predecessor_task_id) || !taskSet.has(dep.successor_task_id)) {
      droppedEdges.push({
        dependencyId: dep.id,
        predecessorTaskId: dep.predecessor_task_id,
        successorTaskId: dep.successor_task_id,
        missingTaskIds: [dep.predecessor_task_id, dep.successor_task_id].filter((id) => !taskSet.has(id)),
      });
      continue;
    }
    edges.push({
      predecessorId: dep.predecessor_task_id,
      successorId: dep.successor_task_id,
      lagDays: dep.lag_days ?? 0,
    });
    predecessorMap.get(dep.successor_task_id)!.push(dep.predecessor_task_id);
    successorMap.get(dep.predecessor_task_id)!.push(dep.successor_task_id);
  }

  return { dag: { nodes, edges, predecessorMap, successorMap, milestones }, droppedEdges };
}
