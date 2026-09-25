# Policy Registry v1

Registry is deterministic and code-defined in `GOVERNANCE_POLICY_REGISTRY`.

Each governed action maps to:
- required permission
- minimum role (optional)
- allowed actor types
- agent compatibility
- deny audit event type
- risk level
- scope requirement (workspace/project)

Included actions: `project.read`, `workspace.read`, `project.write`, `memory.read`, `memory.write`, `document.upload`, `billing.manage`, `members.manage`, `ai.execute`, `ai.manage`, `workspace.manage`, `executive.view`, `privileged.use`, `project_brain.converse`.

A permission is not an action: `read` is `workspace.read` at workspace scope and `project.read` (project-scoped, requires a projectId) at project scope. Human guards resolve it with `resolveGovernanceAction(permission, scope)`; see [`workspace-read-authorization-boundary.md`](./workspace-read-authorization-boundary.md) (SIT-024).


## Phase 5.1 note
- Approval-aware governance is now implemented as a minimal runtime layer; this is not AOC protocol integration yet.
