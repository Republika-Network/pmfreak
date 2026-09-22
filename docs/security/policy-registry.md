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

Included actions: `project.read`, `project.write`, `memory.read`, `memory.write`, `document.upload`, `billing.manage`, `members.manage`, `ai.execute`, `ai.manage`, `workspace.manage`, `executive.view`, `privileged.use`, `knowledge.ratify`, `knowledge.reject`, `knowledge.revoke`.

The three `knowledge.*` actions (P2-19) govern Learning Candidate ratification/rejection and Project knowledge revocation: permission `manage_workspace` (owner, admin), users only, not agent-compatible, not delegable, Workspace-scoped (the command layer also proves the record's Workspace/Project binding), deny audit `governance_violation`, risk critical/high/critical. They are distinct from the Material Action `knowledge_elevation` class, which remains hard-denied.


## Phase 5.1 note
- Approval-aware governance is now implemented as a minimal runtime layer; this is not AOC protocol integration yet.
