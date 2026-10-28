-- ============================================================================
-- PD-24 — Project Brain reads processed upload text, bounded.
--
-- The Brain's context builder selects excerpts from processed uploads
-- (lib/project-brain/conversation/document-context.ts). PostgREST cannot return a
-- prefix of a column, and `project_evidence_content.extracted_text` may hold up to
-- 2 M characters per document (SEC-W3-2), so a direct select would move whole
-- documents on every turn. This function returns only the scanned head.
--
-- Constraints honoured, all deliberate:
--   * `stable security invoker`: RLS on project_evidence_content AND project_evidence
--     applies as the caller, exactly as the direct reads it replaces. A viewer reads
--     what the Evidence list already shows them; another tenant reads nothing.
--   * both sides are filtered by the caller-supplied workspace AND project, and the
--     join requires the parent to match on id, workspace and project;
--   * only `processed` parents qualify: failed / processing evidence never does, and
--     content rows cascade away with deleted evidence;
--   * bounded: at most 24 rows and 64 000 characters each;
--   * no table, column, policy, trigger or existing grant is altered; no writes;
--     `search_path` pinned empty, every name schema-qualified.
-- ============================================================================

create or replace function public.project_brain_document_texts(
  p_workspace_id uuid,
  p_project_id uuid,
  p_limit integer default 24
)
returns table (
  evidence_id uuid,
  workspace_id uuid,
  project_id uuid,
  text_head text,
  content_hash text,
  file_name text,
  file_type text,
  uploaded_by uuid,
  uploaded_at timestamptz,
  status text
)
language sql
stable
security invoker
set search_path = ''
as $$
  select
    c.evidence_id,
    c.workspace_id,
    c.project_id,
    left(c.extracted_text, 64000) as text_head,
    c.content_hash,
    e.file_name,
    e.file_type,
    e.uploaded_by,
    e.uploaded_at,
    e.status
  from public.project_evidence_content c
  join public.project_evidence e
    on e.id = c.evidence_id
   and e.workspace_id = c.workspace_id
   and e.project_id = c.project_id
  where c.workspace_id = p_workspace_id
    and c.project_id = p_project_id
    and e.status = 'processed'
  order by c.created_at desc, c.evidence_id asc
  limit least(greatest(coalesce(p_limit, 24), 0), 24);
$$;

revoke all on function public.project_brain_document_texts(uuid, uuid, integer) from public, anon;
grant execute on function public.project_brain_document_texts(uuid, uuid, integer) to authenticated, service_role;

comment on function public.project_brain_document_texts(uuid, uuid, integer) is
  'PD-24: bounded heads of processed upload text for Project Brain excerpt selection. SECURITY INVOKER — caller RLS applies.';
