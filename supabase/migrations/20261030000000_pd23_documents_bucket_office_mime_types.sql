-- PD-23 — the evidence bucket accepts every format the application supports.
--
-- 20260515200000_storage_bucket_setup.sql created `pmfreak-documents` allowing only PDF, DOCX
-- and plain text, but POST /api/upload (ALLOWED_MIME_TYPES), the Evidence Vault and the
-- /upload page accept XLSX and PPTX too. Storage refused those objects ("mime type … is not
-- supported"), so every XLSX/PPTX upload failed with 500 "Storage failed" after its quota had
-- been reserved (and then released). The original insert used ON CONFLICT DO NOTHING, so an
-- existing bucket was never updated; this updates it in place.
--
-- Nothing else changes: the bucket stays private, the 10 MB object limit stays, storage
-- remains service-role only (objects are written and removed by the server), and every
-- application check still runs first — MIME allowlist, extension/MIME agreement, ZIP magic
-- bytes, the SEC-W3-2 archive inflation bounds and the per-uploader quota.

begin;

update storage.buckets
set allowed_mime_types = array[
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'text/plain'
]
where id = 'pmfreak-documents';

commit;
