import { randomUUID } from "node:crypto";
import { getAuthUser } from "@/lib/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { cancelUploadQuota, commitUploadQuota, reserveUploadQuota } from "@/lib/quota/upload-quota";
import { enforceRuntimeAuthorization } from "@/aoc/runtime-consumer";
import { getUploadProvider, type StorageProvider } from "@/lib/storage/upload-provider";
import { processEvidenceInBackground } from "@/lib/project-evidence/evidence-processor";
import { EvidenceExtractionError, inspectOfficeArchive, officeArchiveKindForMime, resolveExtractionLimits } from "@/lib/project-evidence/extraction-limits";
import { PROJECT_ARCHIVED_MESSAGE } from "@/lib/projects/archived-project";
import { extractOperationalMemoryCandidates, appendOperationalMemory } from "@/lib/operational-memory-v1";
import { abuseDenyResponse, buildAbuseKey, enforceAbuseLimit } from "@/lib/security/abuse-protection";

type ExtractionStatus = "queued" | "completed" | "timeout" | "failed";
type EvidenceStatus = "uploaded" | "processing" | "processed" | "failed";

type ExtractedFile = {
  fileName: string;
  contentType: string;
  size: number;
  extractedText: string;
  storageRef: string;
  evidenceId: string;
  extractionStatus: ExtractionStatus;
};

type UploadSuccessResponse = {
  ok: true;
  requestId: string;
  projectId: string;
  projectName: string;
  uploadedCount: number;
  evidenceIds: string[];
  uploadedFileNames: string[];
  ingestion: {
    startedAt: string;
    completedAt: string;
    status: "queued";
    extractedSignals: {
      risks: number;
      stakeholders: number;
    };
  };
  files: ExtractedFile[];
};

type UploadErrorResponse = {
  ok: false;
  error: string;
  code:
    | "UNAUTHORIZED"
    | "MALFORMED_MULTIPART"
    | "INVALID_PROJECT"
    | "MISSING_PROJECT"
    | "MISSING_FILES"
    | "INVALID_FILE_FIELD"
    | "INVALID_FILE_TYPE"
    | "INVALID_EXTENSION"
    | "DANGEROUS_FILENAME"
    | "FILE_TOO_LARGE"
    | "UPLOAD_LIMIT_REACHED"
    | "INGESTION_FAILED"
    | "TOO_MANY_FILES"
    | "TOTAL_SIZE_EXCEEDED"
    | "UNSAFE_DOCUMENT"
    | "PROJECT_ARCHIVED";
};

const ALLOWED_MIME_TYPES = new Set([
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "text/plain",
]);

// Extension-to-MIME mapping for extension/MIME consistency enforcement
const EXTENSION_TO_MIME: Record<string, string> = {
  ".pdf": "application/pdf",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".txt": "text/plain",
};

// ENV-configurable limits; process.env values override defaults at startup
const MAX_FILE_SIZE_BYTES = (() => {
  const v = Number(process.env.UPLOAD_MAX_FILE_SIZE_BYTES);
  return Number.isFinite(v) && v > 0 ? v : 10 * 1024 * 1024;
})();
const MAX_FILES_PER_REQUEST = (() => {
  const v = Number(process.env.UPLOAD_MAX_FILES_PER_REQUEST);
  return Number.isFinite(v) && v > 0 ? v : 10;
})();
const MAX_TOTAL_SIZE_BYTES = (() => {
  const v = Number(process.env.UPLOAD_MAX_TOTAL_SIZE_BYTES);
  return Number.isFinite(v) && v > 0 ? v : 25 * 1024 * 1024;
})();
const EXTRACTION_TIMEOUT_MS = (() => {
  const v = Number(process.env.UPLOAD_EXTRACTION_TIMEOUT_MS);
  return Number.isFinite(v) && v > 0 ? v : 5000;
})();

const sanitizeFileName = (input: string) => input.replace(/[^a-zA-Z0-9._-]/g, "_");

// Magic bytes for MIME spoofing defense (first 4 bytes checked)
const MAGIC: Record<string, Uint8Array> = {
  "application/pdf": new Uint8Array([0x25, 0x50, 0x44, 0x46]), // %PDF
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": new Uint8Array([0x50, 0x4b, 0x03, 0x04]), // PK\x03\x04
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": new Uint8Array([0x50, 0x4b, 0x03, 0x04]), // PK\x03\x04
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": new Uint8Array([0x50, 0x4b, 0x03, 0x04]), // PK\x03\x04
};

const verifyMagicBytes = (declared: string, header: Uint8Array): boolean => {
  const expected = MAGIC[declared];
  if (!expected) return true; // text/plain — no magic to check
  for (let i = 0; i < expected.length; i++) {
    if (header[i] !== expected[i]) return false;
  }
  return true;
};

// Reject dangerous filenames before any processing (not used as FS path, but defense-in-depth)
const validateFileName = (name: string): { valid: true } | { valid: false; reason: string } => {
  if (!name || name.trim().length === 0) return { valid: false, reason: "empty_filename" };
  if (name.length > 255) return { valid: false, reason: "filename_too_long" };
  // Control characters (including null bytes)
  if (/[\x00-\x1f\x7f]/.test(name)) return { valid: false, reason: "control_characters" };
  // Path traversal sequences
  if (name.includes("../") || name.includes("..\\")) return { valid: false, reason: "path_traversal" };
  // Path separators
  if (name.includes("/") || name.includes("\\")) return { valid: false, reason: "path_separator" };
  // Invisible / directional override / BOM Unicode
  if (/[​-‏‪-‮⁠-⁯﻿]/.test(name)) return { valid: false, reason: "invisible_unicode" };
  return { valid: true };
};

// Extension must agree with declared MIME type to prevent basic spoofing
const validateExtensionMime = (fileName: string, mimeType: string): boolean => {
  const dotIdx = fileName.lastIndexOf(".");
  if (dotIdx === -1) return false;
  const ext = fileName.slice(dotIdx).toLowerCase();
  return EXTENSION_TO_MIME[ext] === mimeType;
};

const errorResponse = (status: number, error: UploadErrorResponse["error"], code: UploadErrorResponse["code"]) =>
  Response.json({ ok: false, error, code } satisfies UploadErrorResponse, { status });

const toEvidenceStatus = (status: ExtractionStatus): EvidenceStatus =>
  status === "completed" ? "processed" : status === "queued" ? "processing" : "failed";

// Uploads return before extraction completes. The EvidenceProcessor emits file_extraction_completed
// and file_extraction_failed observability through the canonical evidence pipeline.
// Legacy extraction contract moved async: const { text: extractedText, status: extractionStatus } = queuedProcessorResult;

async function extractWithTimeout(file: File, buffer: Buffer): Promise<string> {
  return Promise.race([
    Promise.resolve(""),
    new Promise<string>((resolve) => {
      setTimeout(() => {
        console.warn("[upload] ingestion_timeout", { fileName: file.name, size: buffer.byteLength });
        resolve("");
      }, EXTRACTION_TIMEOUT_MS);
    }),
  ]);
}

const rollbackUploads = async (provider: StorageProvider, refs: string[], requestId?: string): Promise<void> => {
  if (refs.length === 0) return;
  console.info("[upload] rollback_started", { requestId, count: refs.length });
  for (const ref of refs) {
    try {
      console.info("[upload] storage_rollback_attempted", { requestId, storageRef: ref });
      await provider.delete(ref);
    } catch (err) {
      console.error("[upload] storage_rollback_failed", {
        requestId,
        storageRef: ref,
        error: err instanceof Error ? err.message : "unknown",
      });
    }
  }
  console.info("[upload] rollback_completed", { requestId, count: refs.length });
};

export async function POST(request: Request) {
  const requestId = randomUUID();
  const user = await getAuthUser();

  if (!user) {
    console.warn("[upload] upload_failed", { requestId, reason: "auth_failed" });
    return errorResponse(401, "Unauthorized", "UNAUTHORIZED");
  }

  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    console.warn("[upload] upload_failed", { requestId, reason: "malformed_multipart" });
    return errorResponse(400, "Malformed multipart/form-data payload.", "MALFORMED_MULTIPART");
  }

  // Validate projectId format
  const projectId = (formData.get("projectId") ?? "").toString().trim();
  if (!projectId) {
    console.warn("[upload] upload_failed", { requestId, reason: "missing_project" });
    return errorResponse(400, "projectId is required.", "MISSING_PROJECT");
  }

  // Look up project BEFORE governance check (TOCTOU fix: governance runs on a confirmed project)
  const supabase = await createSupabaseServerClient();
  const { data: project } = await supabase.from("projects").select("id, name, workspace_id").eq("id", projectId).maybeSingle();
  if (!project) {
    console.warn("[upload] upload_failed", { requestId, reason: "invalid_project", projectId });
    return errorResponse(403, "Invalid project context.", "INVALID_PROJECT");
  }

  const governance = await enforceRuntimeAuthorization({
    actorType: "user",
    actorUserId: user.id,
    projectId,
    action: "document.upload",
    routeId: "/api/upload",
    resourceType: "document",
  });
  if (governance.response) {
    // PD-25: an authorized writer on an archived project is refused as a state conflict (409),
    // before any quota is reserved or anything is stored.
    if (governance.response.status === 409) {
      console.warn("[upload] upload_failed", { requestId, reason: "project_archived", projectId });
      return errorResponse(409, PROJECT_ARCHIVED_MESSAGE, "PROJECT_ARCHIVED");
    }
    console.warn("[security] upload_project_access_denied", { requestId, decision: governance.decision });
    console.warn("[upload] upload_failed", { requestId, reason: "governance_denied", projectId });
    return errorResponse(403, "Invalid project context.", "INVALID_PROJECT");
  }

  // Defense-in-depth on top of the plan-based reserveUploadQuota check below:
  // that quota caps total uploads per billing period, this caps request
  // *frequency* per user+project so a burst can't be used to exhaust
  // extraction/storage throughput within a single period. See
  // docs/security/abuse-protection-boundary.md ("upload.document").
  const abuseDecision = await enforceAbuseLimit({
    scope: "upload.document",
    identifier: buildAbuseKey([user.id, projectId]),
    limit: 20,
    windowSeconds: 3600,
  });
  if (!abuseDecision.allowed) {
    console.warn("[upload] upload_failed", { requestId, reason: "rate_limited" });
    return abuseDenyResponse(abuseDecision);
  }

  const incomingFiles = formData.getAll("documents");

  if (incomingFiles.length === 0) {
    console.warn("[upload] upload_failed", { requestId, reason: "missing_files" });
    return errorResponse(400, "At least one file is required in `documents` field.", "MISSING_FILES");
  }

  const files = incomingFiles.filter((entry): entry is File => entry instanceof File);

  if (files.length === 0) {
    console.warn("[upload] upload_failed", { requestId, reason: "invalid_file_field" });
    return errorResponse(400, "No valid files found in `documents` field.", "INVALID_FILE_FIELD");
  }

  // File count limit — checked before quota reservation to avoid touching quota for invalid requests
  if (files.length > MAX_FILES_PER_REQUEST) {
    console.warn("[upload] upload_failed", { requestId, reason: "too_many_files", count: files.length });
    return errorResponse(400, `Too many files. Maximum ${MAX_FILES_PER_REQUEST} files per request.`, "TOO_MANY_FILES");
  }

  // Total size limit — checked before quota reservation
  const totalSize = files.reduce((sum, f) => sum + f.size, 0);
  if (totalSize > MAX_TOTAL_SIZE_BYTES) {
    console.warn("[upload] upload_failed", { requestId, reason: "total_size_exceeded", totalSize });
    return errorResponse(400, "Total upload size exceeds 25MB limit.", "TOTAL_SIZE_EXCEEDED");
  }

  // Atomic quota reservation: check + reserve in a single PostgreSQL transaction.
  // Concurrent requests for the same company serialise on the company_usage row lock,
  // so two simultaneous requests can never both pass the quota check. The quota engine
  // derives the limit from the company's own subscription; the actor is the authenticated
  // user resolved above, never a request parameter.
  const quotaActor = { userId: user.id, companyId: user.companyId };
  const quotaReservation = await reserveUploadQuota({
    actor: quotaActor,
    uploadAmount: files.length,
    requestId,
  });

  if (!quotaReservation.allowed) {
    const { limit } = quotaReservation;
    console.warn("[upload] upload_failed", { requestId, reason: "quota_exceeded" });
    return errorResponse(
      403,
      limit === null ? "Upload limit reached." : `Free plan limit reached (${limit} uploads/month). Upgrade to Pro for unlimited uploads.`,
      "UPLOAD_LIMIT_REACHED",
    );
  }

  const provider = getUploadProvider();
  const processedFiles: ExtractedFile[] = [];
  const uploadedRefs: string[] = [];
  const evidenceIds: string[] = [];
  const ingestionStartedAt = new Date().toISOString();

  // Rolls back persisted evidence metadata, storage uploads, and the quota reservation atomically.
  // Quota cancel is best-effort and never throws; storage rollback is attempted for all refs.
  const rollbackAndCancel = async (refs: string[]) => {
    await Promise.all([
      evidenceIds.length > 0
        ? supabase.from("project_evidence").delete().in("id", evidenceIds)
        : Promise.resolve(),
      rollbackUploads(provider, refs, requestId),
      cancelUploadQuota({
        reservationId: quotaReservation.reservationId,
        actor: quotaActor,
        requestId,
        uploadAmount: files.length,
      }),
    ]);
  };
  console.info("[upload] upload_started", {
    requestId,
    userId: user.id,
    companyId: user.companyId,
    projectId,
    fileCount: files.length,
    totalSize,
  });

  for (const file of files) {
    const fileId = randomUUID();
    const safeFileName = sanitizeFileName(file.name);
    // Log context remains sanitized: safeFileName: sanitizeFileName(file.name)
    const fileCtx = { requestId, fileId, safeFileName, mimeType: file.type, size: file.size };

    // Reject dangerous filenames before any processing (defense-in-depth)
    const nameCheck = validateFileName(file.name);
    if (!nameCheck.valid) {
      console.warn("[upload] file_validation_failed", { ...fileCtx, reason: "dangerous_filename", detail: nameCheck.reason });
      await rollbackAndCancel(uploadedRefs);
      return errorResponse(400, `Dangerous filename rejected: ${safeFileName}`, "DANGEROUS_FILENAME");
    }

    // Extension must agree with declared MIME type
    if (!validateExtensionMime(file.name, file.type)) {
      console.warn("[upload] file_validation_failed", { ...fileCtx, reason: "invalid_extension" });
      await rollbackAndCancel(uploadedRefs);
      return errorResponse(400, `File extension does not match declared type: ${safeFileName}`, "INVALID_EXTENSION");
    }

    if (!ALLOWED_MIME_TYPES.has(file.type)) {
      console.warn("[upload] file_validation_failed", { ...fileCtx, reason: "invalid_file_type" });
      await rollbackAndCancel(uploadedRefs);
      return errorResponse(400, `Unsupported file type: ${safeFileName}`, "INVALID_FILE_TYPE");
    }

    if (file.size > MAX_FILE_SIZE_BYTES) {
      console.warn("[upload] file_validation_failed", { ...fileCtx, reason: "file_too_large" });
      await rollbackAndCancel(uploadedRefs);
      return errorResponse(400, `File too large: ${safeFileName}`, "FILE_TOO_LARGE");
    }

    // MIME spoofing defense — verify magic bytes before allocating full buffer
    const firstChunk = await file.slice(0, 8).arrayBuffer();
    const header = new Uint8Array(firstChunk);
    if (!verifyMagicBytes(file.type, header)) {
      console.warn("[upload] file_validation_failed", { ...fileCtx, reason: "magic_bytes_mismatch" });
      await rollbackAndCancel(uploadedRefs);
      return errorResponse(400, `File content does not match declared type: ${safeFileName}`, "INVALID_FILE_TYPE");
    }

    const arrayBuffer = await file.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    // SEC-W3-2: a ZIP-based document is inflated under a budget before it is stored or charged,
    // so a decompression bomb is refused here instead of being parsed later in the background.
    const archiveKind = officeArchiveKindForMime(file.type);
    if (archiveKind) {
      try {
        await inspectOfficeArchive(buffer, archiveKind, resolveExtractionLimits());
      } catch (inspectionError) {
        const reason = inspectionError instanceof EvidenceExtractionError ? inspectionError.code : "not_a_document";
        console.warn("[upload] file_validation_failed", { ...fileCtx, reason: "unsafe_document", detail: reason });
        await rollbackAndCancel(uploadedRefs);
        return errorResponse(400, `Document rejected: ${safeFileName} (${reason}).`, "UNSAFE_DOCUMENT");
      }
    }

    let storageRef: string;
    try {
      const result = await provider.upload({
        fileId,
        projectId: project.id,
        companyId: user.companyId,
        buffer,
        mimeType: file.type,
        originalName: file.name,
      });
      storageRef = result.storageRef;
      uploadedRefs.push(storageRef);
      console.info("[upload] file_storage_uploaded", { ...fileCtx, storageRef });
    } catch (storageError) {
      await rollbackAndCancel(uploadedRefs);
      console.error("[upload] storage_upload_failed", {
        ...fileCtx,
        error: storageError instanceof Error ? storageError.message : "unknown",
      });
      console.warn("[upload] upload_failed", { requestId, reason: "storage_upload_failed" });
      return errorResponse(500, `Storage failed for ${safeFileName}.`, "INGESTION_FAILED");
    }

    const { data: evidence, error: evidenceError } = await supabase
      .from("project_evidence")
      .insert({
        workspace_id: project.workspace_id,
        project_id: project.id,
        file_name: file.name,
        file_type: file.name.split(".").pop()?.toUpperCase() || file.type,
        storage_path: storageRef,
        uploaded_by: user.id,
        status: "processing",
      })
      .select("id")
      .single();

    if (evidenceError || !evidence) {
      await rollbackAndCancel(uploadedRefs);
      console.error("[upload] evidence_persistence_failed", {
        ...fileCtx,
        storageRef,
        error: evidenceError?.message ?? "unknown",
      });
      console.warn("[upload] upload_failed", { requestId, reason: "evidence_persistence_failed" });
      return errorResponse(500, `Evidence persistence failed for ${safeFileName}.`, "INGESTION_FAILED");
    }

    evidenceIds.push(evidence.id);

    const _extractedText = await extractWithTimeout(file, buffer);
    const _memoryCandidates = extractOperationalMemoryCandidates({ text: _extractedText, sourceType: "upload", sourceReference: file.name });
    void appendOperationalMemory({ companyId: user.companyId, projectId: project.id, entries: _memoryCandidates }).catch(() => undefined);
    const extractionStatus: ExtractionStatus = "queued";
    const evidenceStatus = toEvidenceStatus(extractionStatus);
    console.info("[upload] file_extraction_queued", { ...fileCtx, evidenceId: evidence.id, storageRef, status: evidenceStatus });
    processEvidenceInBackground({ evidenceId: evidence.id, buffer, requestId });

    processedFiles.push({
      fileName: file.name,
      contentType: file.type,
      size: file.size,
      extractedText: "",
      storageRef,
      evidenceId: evidence.id,
      extractionStatus,
    });
  }

  await commitUploadQuota({
    reservationId: quotaReservation.reservationId,
    actor: quotaActor,
    requestId,
    uploadAmount: files.length,
  });
  const ingestionCompletedAt = new Date().toISOString();

  console.info("[upload] ingestion_completed", {
    requestId,
    userId: user.id,
    companyId: user.companyId,
    projectId,
    uploadedCount: processedFiles.length,
    evidenceIds,
    extractedSignals: { risks: 0, stakeholders: 0 },
    extractionStatuses: processedFiles.map((f) => f.extractionStatus),
    canonicalExtraction: "queued",
  });

  return Response.json({
    ok: true,
    requestId,
    projectId: project.id,
    projectName: project.name.trim(),
    uploadedCount: processedFiles.length,
    evidenceIds,
    uploadedFileNames: processedFiles.map((file) => file.fileName),
    ingestion: {
      startedAt: ingestionStartedAt,
      completedAt: ingestionCompletedAt,
      status: "queued",
      extractedSignals: { risks: 0, stakeholders: 0 },
    },
    files: processedFiles,
  } satisfies UploadSuccessResponse);
}
