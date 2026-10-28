import { createHash } from "node:crypto";
import JSZip from "jszip";
import mammoth from "mammoth";
import { PDFParse } from "pdf-parse";
import { readSpreadsheetWorkbook } from "@/lib/spreadsheets/workbook-reader";
import { createPrivilegedSupabaseClient } from "@/lib/security/privileged-access";
import { getUploadProvider } from "@/lib/storage/upload-provider";
import { regenerateProjectDiscoveryInBackground } from "@/lib/project-discovery/discovery-repository";
import {
  EvidenceExtractionError,
  assertExtractedTextWithinLimit,
  assertExtractionInputSize,
  inspectOfficeArchive,
  resolveExtractionLimits,
  runInExtractionSlot,
  withExtractionDeadline,
  type ExtractionLimits,
} from "@/lib/project-evidence/extraction-limits";

export type EvidenceProcessingStatus = "completed" | "failed";

export type EvidenceProcessorInput = {
  evidenceId: string;
  buffer?: Buffer;
  requestId?: string;
};

type EvidenceSource = {
  id: string;
  workspace_id: string;
  project_id: string;
  file_name: string;
  file_type: string;
  storage_path: string;
  uploaded_by: string | null;
  uploaded_at: string;
};

type ExtractionResult = {
  text: string;
  method: string;
};

const MIME_BY_EXTENSION: Record<string, string> = {
  PDF: "application/pdf",
  DOCX: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  XLSX: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  PPTX: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  TXT: "text/plain",
};

const EXTRACTION_METHOD_BY_MIME: Record<string, string> = {
  "application/pdf": "pdf-parse:text",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "mammoth:raw-text",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx:worksheet-values",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx:slide-xml-text",
  "text/plain": "text:raw-utf8",
};

const xmlTextEntityPattern = /&(?:amp|lt|gt|quot|apos);|&#\d+;|&#x[\da-f]+;/gi;

const decodeXmlText = (value: string) =>
  value.replace(xmlTextEntityPattern, (entity) => {
    if (entity === "&amp;") return "&";
    if (entity === "&lt;") return "<";
    if (entity === "&gt;") return ">";
    if (entity === "&quot;") return '"';
    if (entity === "&apos;") return "'";
    if (entity.startsWith("&#x")) return String.fromCodePoint(Number.parseInt(entity.slice(3, -1), 16));
    if (entity.startsWith("&#")) return String.fromCodePoint(Number.parseInt(entity.slice(2, -1), 10));
    return entity;
  });

export const normalizeEvidenceText = (text: string) =>
  text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[\t ]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

const resolveMimeType = (source: EvidenceSource) => {
  const normalizedFileType = source.file_type.trim().toUpperCase();
  if (MIME_BY_EXTENSION[normalizedFileType]) return MIME_BY_EXTENSION[normalizedFileType];
  return source.file_type;
};

// PD-22: pdf.js runs its worker in-process on Node, and by default loads it by import()-ing a
// path next to its own module. Bundled into .next/server/chunks that file does not exist, so
// every PDF failed with "Setting up fake worker failed". Importing the worker module (same
// pdfjs-dist build pdf-parse uses) registers globalThis.pdfjsWorker, which pdf.js uses
// instead of resolving any file — so it works bundled, traced or not. Loaded once, lazily.
let pdfWorkerReady: Promise<unknown> | null = null;
const ensurePdfWorker = () => (pdfWorkerReady ??= import("pdfjs-dist/legacy/build/pdf.worker.mjs"));

// Only the first maxPdfPages pages are read, and a timed-out parser is destroyed (SEC-W3-2).
const extractPdfText = async (buffer: Buffer, limits: ExtractionLimits) => {
  await ensurePdfWorker();
  const parser = new PDFParse({ data: buffer });
  try {
    const result = await withExtractionDeadline(parser.getText({ first: limits.maxPdfPages }), limits, () => parser.destroy());
    return result.text;
  } finally {
    await parser.destroy().catch(() => {});
  }
};

// The archive is inflated under a budget before mammoth sees it (SEC-W3-2).
const extractDocxText = async (buffer: Buffer, limits: ExtractionLimits) => {
  await inspectOfficeArchive(buffer, "docx", limits);
  const result = await withExtractionDeadline(mammoth.extractRawText({ buffer }), limits);
  return result.value;
};

// Untrusted workbooks go through the Perilla 12 spreadsheet boundary
// (size/sheet/row/column/cell caps, macro + external-link + zip-bomb
// rejection, prototype-pollution canary, parse deadline) — see
// src/lib/spreadsheets/workbook-reader.ts and
// docs/security/spreadsheet-processing-boundary.md.
const extractXlsxText = async (buffer: Buffer, limits: ExtractionLimits) => {
  // The spreadsheet boundary trusts declared ZIP sizes; the actual inflation is bounded first (SEC-W3-2).
  await inspectOfficeArchive(buffer, "xlsx", limits);
  const workbook = await readSpreadsheetWorkbook(buffer);
  return workbook.sheets
    .map((sheet) => {
      const rowText = sheet.rows
        .map((row) => row.map((cell) => cell.trim()).filter(Boolean).join(" | "))
        .filter(Boolean)
        .join("\n");
      return [`Sheet: ${sheet.name}`, rowText].filter(Boolean).join("\n");
    })
    .filter(Boolean)
    .join("\n\n");
};

const extractPptxText = async (buffer: Buffer, limits: ExtractionLimits) => {
  await inspectOfficeArchive(buffer, "pptx", limits);
  const zip = await JSZip.loadAsync(buffer);
  const slidePaths = Object.keys(zip.files)
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/i.test(name))
    .sort((a, b) => Number(a.match(/slide(\d+)\.xml/i)?.[1] ?? 0) - Number(b.match(/slide(\d+)\.xml/i)?.[1] ?? 0));

  const slides: string[] = [];
  for (const [index, slidePath] of slidePaths.entries()) {
    const slideXml = await zip.files[slidePath].async("text");
    const textRuns = Array.from(slideXml.matchAll(/<a:t>([\s\S]*?)<\/a:t>/g), (match) => decodeXmlText(match[1]).trim()).filter(Boolean);
    if (textRuns.length > 0) {
      slides.push([`Slide ${index + 1}:`, ...textRuns].join("\n"));
    }
  }
  return slides.join("\n\n");
};

export class EvidenceProcessor {
  async processEvidence(input: EvidenceProcessorInput): Promise<EvidenceProcessingStatus> {
    const startedAt = new Date();
    const supabase = createPrivilegedSupabaseClient({
      routeId: "EvidenceProcessor.processEvidence",
      operation: "project_evidence.process",
      reason: "Asynchronous canonical evidence extraction after authorized upload",
      systemActor: "background_job",
    });

    const { data: source, error } = await supabase
      .from("project_evidence")
      .select("id,workspace_id,project_id,file_name,file_type,storage_path,uploaded_by,uploaded_at")
      .eq("id", input.evidenceId)
      .maybeSingle();

    if (error || !source) {
      console.error("[evidence_processor] Processing Failed", {
        requestId: input.requestId,
        evidenceId: input.evidenceId,
        projectId: null,
        durationMs: Date.now() - startedAt.getTime(),
        error: error?.message ?? "evidence_not_found",
      });
      return "failed";
    }

    console.info("[evidence_processor] Processing Started", {
      requestId: input.requestId,
      evidenceId: source.id,
      projectId: source.project_id,
    });

    await supabase.from("project_evidence").update({ status: "processing" }).eq("id", source.id);

    try {
      const buffer = input.buffer ?? await getUploadProvider().download(source.storage_path);
      const limits = resolveExtractionLimits();
      const extracted = await this.extractText(buffer, source as EvidenceSource, limits);
      const normalizedText = normalizeEvidenceText(extracted.text);
      assertExtractedTextWithinLimit(normalizedText, limits);
      const contentHash = this.generateContentHash(normalizedText);
      const completedAt = new Date();

      await this.storeCanonicalEvidence({
        source: source as EvidenceSource,
        extractedText: normalizedText,
        contentHash,
        extractionMethod: extracted.method,
        processingStartedAt: startedAt,
        processingCompletedAt: completedAt,
      });
      await this.markProcessed(source.id);
      regenerateProjectDiscoveryInBackground({ projectId: source.project_id, requestId: input.requestId });

      console.info("[evidence_processor] Processing Completed", {
        requestId: input.requestId,
        evidenceId: source.id,
        projectId: source.project_id,
        durationMs: completedAt.getTime() - startedAt.getTime(),
        contentHash,
        hashGenerated: true,
        wordCount: countWords(normalizedText),
      });
      return "completed";
    } catch (processingError) {
      await this.markFailed(source.id);
      console.error("[evidence_processor] Processing Failed", {
        requestId: input.requestId,
        evidenceId: source.id,
        projectId: source.project_id,
        durationMs: Date.now() - startedAt.getTime(),
        // A bounded rejection is reported by its code; nothing was stored for it.
        ...(processingError instanceof EvidenceExtractionError ? { rejectedBy: processingError.code } : {}),
        error: processingError instanceof Error ? processingError.message : "unknown",
      });
      return "failed";
    }
  }

  async extractText(buffer: Buffer, source: EvidenceSource, limits: ExtractionLimits = resolveExtractionLimits()): Promise<ExtractionResult> {
    const mimeType = resolveMimeType(source);
    const method = EXTRACTION_METHOD_BY_MIME[mimeType];
    if (!method) throw new Error(`Unsupported evidence file type: ${source.file_type}`);
    assertExtractionInputSize(buffer, limits);

    if (mimeType === "text/plain") return { text: buffer.toString("utf-8"), method };
    if (mimeType === "application/pdf") return { text: await extractPdfText(buffer, limits), method };
    if (mimeType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document") return { text: await extractDocxText(buffer, limits), method };
    if (mimeType === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet") return { text: await extractXlsxText(buffer, limits), method };
    if (mimeType === "application/vnd.openxmlformats-officedocument.presentationml.presentation") return { text: await withExtractionDeadline(extractPptxText(buffer, limits), limits), method };
    throw new Error(`Unsupported evidence file type: ${source.file_type}`);
  }

  generateContentHash(extractedText: string): string {
    return createHash("sha256").update(normalizeEvidenceText(extractedText), "utf8").digest("hex");
  }

  async storeCanonicalEvidence(input: {
    source: EvidenceSource;
    extractedText: string;
    contentHash: string;
    extractionMethod: string;
    processingStartedAt: Date;
    processingCompletedAt: Date;
  }) {
    const supabase = createPrivilegedSupabaseClient({
      routeId: "EvidenceProcessor.storeCanonicalEvidence",
      operation: "project_evidence_content.upsert",
      reason: "Persist canonical extracted evidence with source provenance",
      workspaceId: input.source.workspace_id,
      systemActor: "background_job",
    });

    const { error } = await supabase.from("project_evidence_content").upsert(
      {
        evidence_id: input.source.id,
        project_id: input.source.project_id,
        workspace_id: input.source.workspace_id,
        source_file_name: input.source.file_name,
        source_file_type: input.source.file_type,
        source_uploaded_at: input.source.uploaded_at,
        source_uploaded_by: input.source.uploaded_by,
        extracted_text: input.extractedText,
        content_hash: input.contentHash,
        extraction_method: input.extractionMethod,
        processing_started_at: input.processingStartedAt.toISOString(),
        processing_completed_at: input.processingCompletedAt.toISOString(),
        updated_at: new Date().toISOString(),
      },
      { onConflict: "evidence_id" },
    );
    if (error) throw new Error(`Canonical evidence persistence failed: ${error.message}`);
  }

  async markProcessed(evidenceId: string) {
    const supabase = createPrivilegedSupabaseClient({
      routeId: "EvidenceProcessor.markProcessed",
      operation: "project_evidence.status.processed",
      reason: "Finalize asynchronous evidence extraction status",
      systemActor: "background_job",
    });
    const { error } = await supabase.from("project_evidence").update({ status: "processed" }).eq("id", evidenceId);
    if (error) throw new Error(`Unable to mark evidence processed: ${error.message}`);
  }

  async markFailed(evidenceId: string) {
    const supabase = createPrivilegedSupabaseClient({
      routeId: "EvidenceProcessor.markFailed",
      operation: "project_evidence.status.failed",
      reason: "Finalize failed asynchronous evidence extraction status",
      systemActor: "background_job",
    });
    const { error } = await supabase.from("project_evidence").update({ status: "failed" }).eq("id", evidenceId);
    if (error) throw new Error(`Unable to mark evidence failed: ${error.message}`);
  }
}

export const countWords = (text: string) => text.trim() ? text.trim().split(/\s+/).filter(Boolean).length : 0;

// Extractions share a bounded pool of slots per process instead of all running at once (SEC-W3-2).
export const processEvidenceInBackground = (input: EvidenceProcessorInput) => {
  setTimeout(() => {
    void runInExtractionSlot(() => new EvidenceProcessor().processEvidence(input));
  }, 0);
};
