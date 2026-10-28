# F22-A — pre-deploy data checks

`20261025000000_f22a_tenant_isolation_and_escalation.sql` adds its foreign keys and the
invitation role CHECK as `NOT VALID`: every new or updated row is bound immediately, but existing
rows are not re-checked, so the migration cannot fail on historical data. Run the queries below
**read-only** against the target database before applying the migration (and again after), and
resolve every non-zero count first.

What a non-zero count means:

- **Cross-workspace evidence / discovery rows** (R1). Possibly planted. After the fix they are
  inert — discovery only reads `(project_id, workspace_id)` of the project's own workspace and RLS
  shows them only to the planting workspace — but the rows still exist. A `project_discovery`
  row with a foreign workspace can also hold a `(project_id, version)` slot and make the
  victim's next discovery insert fail. Any future UPDATE of such a row fails the new foreign key.
  Investigate them as a potential incident: who created them and when, and whether a discovery
  for the victim project was written into another workspace (third query).
- **Owner-role invitations** (R2). Not issuable by the product. Pending ones can no longer be
  accepted; accepted ones may be the result of the escalation and need a membership review.
- **Pending invitations without an inviter, or whose inviter can no longer grant the role**
  (R2). Acceptance now refuses them (`inviter_not_authorized`); the workspace admin must reissue.
- **Decisions approved / rejected / implemented without a matching actor** (R3). Possible
  forgeries; review them before trusting decision history.

```sql
-- R1: evidence, evidence content and discovery whose workspace is not their project's
select 'project_evidence' as source, count(*) from project_evidence e join projects p on p.id = e.project_id where p.workspace_id <> e.workspace_id
union all
select 'project_evidence_content', count(*) from project_evidence_content c join projects p on p.id = c.project_id where p.workspace_id <> c.workspace_id
union all
select 'project_evidence_content→evidence', count(*) from project_evidence_content c join project_evidence e on e.id = c.evidence_id
  where e.workspace_id <> c.workspace_id or e.project_id <> c.project_id
union all
select 'project_discovery', count(*) from project_discovery d join projects p on p.id = d.project_id where p.workspace_id <> d.workspace_id
union all
-- R1 consequences: RAID items / vault documents / recommended actions stored outside their project's workspace
select 'raid_items', count(*) from raid_items r join projects p on p.id = r.project_id where p.workspace_id <> r.workspace_id
union all
select 'vault_documents', count(*) from vault_documents v join projects p on p.id = v.project_id where p.workspace_id <> v.workspace_id
union all
select 'recommended_actions', count(*) from recommended_actions a join projects p on p.id = a.project_id where p.workspace_id <> a.workspace_id
union all
-- R2
select 'owner invitations (any status)', count(*) from workspace_invitations where role = 'owner'
union all
select 'pending invitations without inviter', count(*) from workspace_invitations where status = 'pending' and invited_by_user_id is null
union all
select 'pending invitations whose inviter cannot grant the role', count(*)
  from workspace_invitations i
  left join workspace_memberships m on m.workspace_id = i.workspace_id and m.user_id = i.invited_by_user_id
  where i.status = 'pending' and i.invited_by_user_id is not null
    and (m.role is null or m.role not in ('owner', 'admin') or i.role not in ('admin', 'pm', 'viewer'))
union all
-- R3
select 'decisions approved without approver', count(*) from project_decisions where decision_status in ('approved', 'implemented') and approved_by is null
union all
select 'decisions rejected without rejecter', count(*) from project_decisions where decision_status = 'rejected' and rejected_by is null
union all
select 'decisions approved by a non-writer', count(*)
  from project_decisions d
  left join workspace_memberships m on m.workspace_id = d.workspace_id and m.user_id = d.approved_by
  where d.approved_by is not null and coalesce(m.role, '') not in ('owner', 'admin', 'pm');
```

Detail for an R1 hit (which tenant's project, which workspace holds the rows):

```sql
select d.id, d.project_id, p.workspace_id as project_workspace, d.workspace_id as stored_workspace, d.version, d.created_at
from project_discovery d join projects p on p.id = d.project_id
where p.workspace_id <> d.workspace_id
order by d.created_at;
```

Once every R1 / R2 count is zero, the constraints can be validated (this takes a share lock and
scans the tables; schedule it):

```sql
alter table project_evidence validate constraint project_evidence_project_workspace_fkey;
alter table project_evidence_content validate constraint project_evidence_content_project_workspace_fkey;
alter table project_evidence_content validate constraint project_evidence_content_evidence_scope_fkey;
alter table project_discovery validate constraint project_discovery_project_workspace_fkey;
alter table workspace_invitations validate constraint workspace_invitations_invitable_role_check;
```

The "decisions approved by a non-writer" count can include legitimate history (an approver who
has since left the workspace or been demoted); treat it as a review list, not a cleanup target.
