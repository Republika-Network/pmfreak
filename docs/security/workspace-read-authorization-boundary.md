# Workspace read authorization boundary (SIT-024)

A permission is not an action. `read` is one permission; which governance action authorizes it depends on the **scope** of the resource being read.

| Requirement | Governance action | Policy scope | Membership check |
| --- | --- | --- | --- |
| `read` + workspaceId, no projectId (workspace membership visibility) | `workspace.read` | `workspaceScoped` | `requireGovernancePermission(workspaceId, "read")` |
| `read` + projectId | `project.read` | `projectScoped` (projectId required) | `requireProjectPermission(projectId, "read")` |

Human authorization guards resolve the action with `resolveGovernanceAction(permission, scope)` in `src/lib/aoc/runtime/governance-actions.ts`. Project scope is never inferred: the guard passes `"project"` only when the requirement carries a projectId. Every permission other than `read` maps to the same action at both scopes.

## The defect this closes

`requireWorkspaceMember(workspaceId)` (`src/lib/security/server-authorization.ts`) asked the runtime for permission `read` with no projectId. The guard indexed the context-free `PERMISSION_TO_GOVERNANCE_ACTION` map, where `read → "project.read"`. `project.read` is correctly project-scoped, so `evaluateGovernanceAction` denied the request at its scope check with *"Denied because project scope is missing for project-scoped action."* That happened **before** the membership lookup: the decision trace held only `policy_registry`. Every workspace member was denied whatever their role. `access-guards.requireWorkspaceMembership` had the same defect, and through it so did `requireGovernancePermission` (its trailing membership read) and `access-guards.requireWorkspaceRole`.

The permission was valid. The selected action had the wrong resource scope.

Production evidence (2026-09-24, read-only telemetry): `security_events` rows with `route_id = server-authorization.evaluateCapability`, `event_type = project_scope_violation`, `requested_permission = read`, `matchedPolicy = project.read` and no projectId. They surfaced as 403s on `/api/pmos`, `/api/context-chat`, `/api/projects` and `/api/programs`.

## What `workspace.read` grants

- Nothing beyond the caller's existing `read` permission in that one workspace. The persisted `workspace_memberships.role` is normalized by the access-verification adapter (`pm` → `PM`, `viewer` → `external_stakeholder`). Both hold `read`, and an unrecognized role is denied.
- No write, delete, memory, AI execution, billing, member or workspace management authority. Those permissions resolve to their own actions unchanged.
- Humans only (`allowedActorTypes: ["user"]`, not agent-compatible). Agent paths (`requireAgentScope`, `evaluateAgentAccess`) still use the context-free map, so an agent read without a projectId stays denied as before.
- It is never a substitute for `project.read`. Project routes (including Project Brain: GET `project.read`, POST `project_brain.converse`) still bind a projectId and check the project's own workspace.

The display role (`AuthUserContext.role`, e.g. "viewer" under the user's name) plays no part. See [`auth-role-boundary.md`](./auth-role-boundary.md).

## Not changed

RLS, schema, `workspace_memberships` data and role vocabulary, `project.read`'s policy, and `CAPABILITY_PERMISSION_TO_GOVERNANCE_ACTION` (capability *requests*) are all unchanged.

## Regression tests

- `tests/module-mocks/sit-024-workspace-chat-authorization.test.mjs`: Workspace and PMO chat GET/POST through the real route and runtime.
- `tests/module-mocks/sit-024-workspace-read-authorization.test.mjs`: the resolver, the policy entry, a negative control that `project.read` without a projectId is still denied, the role matrix, non-escalation, cross-workspace denials, `project.read` binding, and Project Brain isolation.
