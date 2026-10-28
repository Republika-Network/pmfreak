import { AsyncLocalStorage } from "node:async_hooks";

// PD-25 — the one sanctioned exception to "an archived project is read-only".
//
// The project-permission adapter (lib/aoc/adapters/access-verification.ts) refuses every
// mutating permission on an archived project. Three operations are the way OUT of that state and
// must still reach their authorized writers: reactivation (status leaving `archived`), permanent
// deletion (the step after archival) and duplication (reads the archived source, writes a new
// project). They authorize inside runArchivedProjectLifecycleOperation(); within that scope the
// adapter skips ONLY the archived-state rule. Authentication, workspace membership, project scope
// and the role check run exactly as for any other write, and a denial stays a denial — nothing
// here ever turns a refusal into an allow.

const lifecycleScope = new AsyncLocalStorage<{ readonly lifecycle: true }>();

export function runArchivedProjectLifecycleOperation<T>(operation: () => Promise<T>): Promise<T> {
  return lifecycleScope.run({ lifecycle: true }, operation);
}

export const isArchivedProjectLifecycleOperation = (): boolean => lifecycleScope.getStore()?.lifecycle === true;
