# F22-B — pre-deploy data checks

`20261026000000_f22b_active_workflow_authorization.sql` changes policies and adds one trigger; it
changes no rows and adds no constraint that re-checks history, so it cannot fail on existing data.
The checks below are **read-only**. They find historical rows that the new rules would have
refused, which may be products of the abuse F22-B closes, and rows whose future client UPDATEs the
new WITH CHECK clauses would refuse. Run them against the target database before (and after)
applying the migration.

What a non-zero count means:

- **Cross-workspace references** (vault documents / signals, task drafts, events, decision rows,
  commitments, copilot state). Possibly planted by another tenant's member; a client UPDATE of
  such a row now fails. Investigate before cleaning up.
- **Events, decision rows or drafts whose actor is not a workspace writer** (now or ever).
  Possible forgeries by viewers; treat activity timelines and decision audit trails for those
  projects with care. A writer who has since left or been demoted also shows up here — review,
  don't bulk-delete.
- **Evidence whose storage path is not under its uploader's prefix for its project.** The delete
  route will no longer remove those objects from Storage (it removes only the row and logs
  `evidence_storage_path_unverified`). A path under ANOTHER tenant's prefix is a likely attack
  artifact; a legacy path format needs an operator decision (move or delete the object manually).
- **Copilot state rows with no matching member** (company not a member of the workspace):
  invisible to everyone after the fix; safe to expire.
- **Pending invitations for accounts whose email is unconfirmed**: those users must confirm
  their email before accepting (`email_unverified`).

```sql
-- Cross-workspace references
select 'vault_documents→project' as check, count(*) from vault_documents v join projects p on p.id = v.project_id where p.workspace_id <> v.workspace_id
union all select 'vault_operational_signals→document', count(*) from vault_operational_signals s join vault_documents d on d.id = s.document_id
  where d.workspace_id <> s.workspace_id or d.project_id is distinct from s.project_id
union all select 'task_drafts→project', count(*) from task_drafts t join projects p on p.id = t.project_id where p.workspace_id <> t.workspace_id
union all select 'task_drafts→recommended_action', count(*) from task_drafts t join recommended_actions a on a.id = t.recommended_action_id
  where a.workspace_id <> t.workspace_id or a.project_id <> t.project_id
union all select 'task_drafts→raid_item', count(*) from task_drafts t join raid_items r on r.id = t.raid_item_id where r.workspace_id <> t.workspace_id
union all select 'execution_task_events→task', count(*) from execution_task_events e join execution_tasks t on t.id = e.task_id
  where t.workspace_id <> e.workspace_id or t.project_id <> e.project_id
union all select 'recommended_action_decisions→action', count(*) from recommended_action_decisions d join recommended_actions a on a.id = d.recommended_action_id
  where a.workspace_id <> d.workspace_id or a.project_id <> d.project_id
union all select 'governance_commitments→action', count(*) from governance_commitments c join governance_actions a on a.id = c.action_id where a.workspace_id <> c.workspace_id
union all select 'runtime_conversation_state→project', count(*) from runtime_conversation_state r join projects p on p.id = r.project_id where p.workspace_id <> r.workspace_id
-- Actors that are not (or are no longer) workspace writers
union all select 'events by a non-writer', count(*) from execution_task_events e
  left join workspace_memberships m on m.workspace_id = e.workspace_id and m.user_id = e.actor_user_id
  where e.actor_user_id is not null and coalesce(m.role, '') not in ('owner', 'admin', 'pm')
union all select 'decision rows by a non-writer', count(*) from recommended_action_decisions d
  left join workspace_memberships m on m.workspace_id = d.workspace_id and m.user_id = d.decided_by
  where d.decided_by is not null and coalesce(m.role, '') not in ('owner', 'admin', 'pm')
union all select 'task drafts by a non-writer', count(*) from task_drafts t
  left join workspace_memberships m on m.workspace_id = t.workspace_id and m.user_id = t.created_by
  where t.created_by is not null and coalesce(m.role, '') not in ('owner', 'admin', 'pm')
union all select 'vault documents by a non-writer', count(*) from vault_documents v
  left join workspace_memberships m on m.workspace_id = v.workspace_id and m.user_id = v.created_by
  where v.created_by is not null and coalesce(m.role, '') not in ('owner', 'admin', 'pm')
-- Evidence storage paths
union all select 'evidence path not under uploader/project prefix', count(*) from project_evidence
  where uploaded_by is null or storage_path not like uploaded_by::text || '/' || project_id::text || '/%'
     or position('/' in substr(storage_path, length(uploaded_by::text || '/' || project_id::text || '/') + 1)) > 0
     or position('..' in storage_path) > 0
union all select 'evidence path under ANOTHER workspace member/tenant prefix', count(*) from project_evidence e
  where e.uploaded_by is not null and split_part(e.storage_path, '/', 1) <> e.uploaded_by::text
-- Copilot state that no member can see any more
union all select 'copilot state with no matching member', count(*) from runtime_conversation_state r
  left join workspace_memberships m on m.workspace_id = r.workspace_id and m.user_id::text = r.company_id::text
  where m.user_id is null
-- Invitations that now need email confirmation first
union all select 'pending invites for unconfirmed accounts', count(*) from workspace_invitations i
  join auth.users u on lower(u.email) = lower(i.email)
  where i.status = 'pending' and u.email_confirmed_at is null;
```

Detail for evidence paths that the delete route will no longer touch:

```sql
select id, workspace_id, project_id, uploaded_by, storage_path, uploaded_at
from project_evidence
where uploaded_by is null or storage_path not like uploaded_by::text || '/' || project_id::text || '/%'
order by uploaded_at;
```
