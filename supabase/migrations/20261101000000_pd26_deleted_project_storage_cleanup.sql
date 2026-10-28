-- PD-26 — deleting a project no longer leaves its files in Storage or its vault content behind.
--
-- A permanent project delete (DELETE /api/projects/[id], owner/admin) cascades project_evidence
-- and project_evidence_content, but the uploaded objects in the private `pmfreak-documents`
-- bucket have no database link and stayed forever; vault_documents / vault_operational_signals
-- captured FOR the project (ON DELETE SET NULL) survived as workspace-level rows (QA Wave 3).
--
-- Semantics (unchanged where not listed):
--   * Archival is the end state for a project with retained history: tasks (NO ACTION),
--     platform/material-action audit events (RESTRICT) and append-only provenance
--     (evidence_items et al.) still make the database REFUSE a hard delete. Nothing here
--     deletes audit, security or provenance records; security_events and governance
--     delegations keep their SET NULL behaviour.
--   * When a delete is allowed, in the SAME transaction, a BEFORE DELETE trigger:
--       - deletes the project's own vault_operational_signals and vault_documents (their RAID
--         items cascade) and its vault_digestion_runs (their vault_nutrients and
--         vault_semantic_residue — conversation- and document-derived excerpts that the copilot's
--         continuity retrieval reads workspace-wide — cascade); rows that were workspace-level
--         to begin with are untouched;
--       - enqueues one storage_cleanup_jobs row for the project.
--     If the delete is refused or rolls back, so does all of this.
--   * Storage is not transactional, so object removal is an explicit, retryable job:
--     src/lib/project-evidence/deleted-project-storage-cleanup.ts lists the objects of the
--     DELETED project through list_deleted_project_storage_objects() (service role only; returns
--     nothing while the project still exists), removes them, and marks the job done — or
--     records the error and leaves it pending for the next attempt. Removal is idempotent.
--     Object paths are `<uploader>/<project>/<file>` (built server-side), so a project's folder
--     segment can never name another project's or tenant's object.

begin;

create table public.storage_cleanup_jobs (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null,   -- the deleted project; no foreign key, the row is gone
  workspace_id uuid not null,
  bucket_id text not null default 'pmfreak-documents',
  enqueued_at timestamptz not null default now(),
  attempts integer not null default 0,
  last_attempt_at timestamptz,
  last_error text,
  removed_objects integer not null default 0,
  completed_at timestamptz,
  unique (project_id, bucket_id)
);

create index storage_cleanup_jobs_pending_idx on public.storage_cleanup_jobs (enqueued_at) where completed_at is null;

-- Service role only: no client policy, no client grants.
alter table public.storage_cleanup_jobs enable row level security;
revoke all on table public.storage_cleanup_jobs from public, anon, authenticated;
grant select, insert, update on table public.storage_cleanup_jobs to service_role;

create or replace function public.enqueue_deleted_project_cleanup()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  delete from public.vault_operational_signals where project_id = old.id;
  delete from public.vault_documents where project_id = old.id;
  delete from public.vault_digestion_runs where project_id = old.id;
  insert into public.storage_cleanup_jobs (project_id, workspace_id)
  values (old.id, old.workspace_id)
  on conflict (project_id, bucket_id) do nothing;
  return old;
end;
$$;

revoke execute on function public.enqueue_deleted_project_cleanup() from public, anon, authenticated;
grant execute on function public.enqueue_deleted_project_cleanup() to service_role;

create trigger projects_enqueue_deleted_project_cleanup
  before delete on public.projects
  for each row execute function public.enqueue_deleted_project_cleanup();

create or replace function public.list_deleted_project_storage_objects(p_project_id uuid, p_limit integer)
returns setof text
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select o.name
  from storage.objects o
  where o.bucket_id = 'pmfreak-documents'
    and (storage.foldername(o.name))[2] = p_project_id::text
    and not exists (select 1 from public.projects p where p.id = p_project_id)
  order by o.name
  limit greatest(1, least(coalesce(p_limit, 100), 1000));
$$;

revoke execute on function public.list_deleted_project_storage_objects(uuid, integer) from public, anon, authenticated;
grant execute on function public.list_deleted_project_storage_objects(uuid, integer) to service_role;

commit;
