// SEC-W3-2 — resource bounds for untrusted evidence documents.
//
// Uploaded PDF / DOCX / PPTX / XLSX / TXT files are parsed in the shared app
// process. Before this boundary only XLSX had limits (lib/spreadsheets), and
// those trust the sizes a ZIP *declares*: a 111 KB DOCX that inflated to 38 MB
// of XML was parsed for ~1 minute and stored 2.8 M words. The multipart limits
// (10 MB per file) bound the compressed input only.
//
// Bounds, applied at upload (before storage or quota commit) and again by the
// processor (defence in depth, e.g. for a stored object read back later):
//   * input size                      — maxInputBytes
//   * ZIP containers (DOCX/PPTX/XLSX) — entry count; ACTUAL inflated bytes,
//     counted while streaming and aborted at the budget (never trusting the
//     central directory); overall inflation ratio; required document part
//   * PDF                             — first maxPdfPages pages only
//   * extracted text                  — maxExtractedChars (over → rejected, not truncated)
//   * wall clock                      — timeoutMs per extraction (the PDF parser is destroyed)
//   * concurrency                     — maxConcurrent extractions per process; the rest queue
//
// Errors carry a stable code and a fixed message: never library internals or
// file content.

import JSZip from "jszip";

export type ExtractionLimits = {
  maxInputBytes: number;
  maxArchiveEntries: number;
  maxDecompressedBytes: number;
  maxCompressionRatio: number;
  maxExtractedChars: number;
  maxPdfPages: number;
  timeoutMs: number;
  maxConcurrent: number;
};

export const EXTRACTION_LIMIT_DEFAULTS: ExtractionLimits = {
  maxInputBytes: 10 * 1024 * 1024, // matches UPLOAD_MAX_FILE_SIZE_BYTES default
  maxArchiveEntries: 2_000,
  maxDecompressedBytes: 25 * 1024 * 1024,
  maxCompressionRatio: 100,
  maxExtractedChars: 2_000_000,
  maxPdfPages: 300,
  timeoutMs: 20_000,
  maxConcurrent: 2,
};

type EnvRecord = Record<string, string | undefined>;

const clampInt = (raw: string | undefined, fallback: number, min: number, max: number) => {
  const value = Number(raw);
  if (!Number.isFinite(value) || !Number.isInteger(value)) return fallback;
  return Math.min(max, Math.max(min, value));
};

/** Env overrides are clamped, so a misconfiguration can tighten but never remove a bound. */
export function resolveExtractionLimits(env: EnvRecord = process.env): ExtractionLimits {
  const d = EXTRACTION_LIMIT_DEFAULTS;
  return {
    maxInputBytes: clampInt(env.EVIDENCE_EXTRACTION_MAX_INPUT_BYTES, d.maxInputBytes, 1_024, 50 * 1024 * 1024),
    maxArchiveEntries: clampInt(env.EVIDENCE_EXTRACTION_MAX_ARCHIVE_ENTRIES, d.maxArchiveEntries, 10, 10_000),
    maxDecompressedBytes: clampInt(env.EVIDENCE_EXTRACTION_MAX_DECOMPRESSED_BYTES, d.maxDecompressedBytes, 1024 * 1024, 200 * 1024 * 1024),
    maxCompressionRatio: clampInt(env.EVIDENCE_EXTRACTION_MAX_COMPRESSION_RATIO, d.maxCompressionRatio, 2, 1_000),
    maxExtractedChars: clampInt(env.EVIDENCE_EXTRACTION_MAX_CHARS, d.maxExtractedChars, 1_000, 20_000_000),
    maxPdfPages: clampInt(env.EVIDENCE_EXTRACTION_MAX_PDF_PAGES, d.maxPdfPages, 1, 2_000),
    timeoutMs: clampInt(env.EVIDENCE_EXTRACTION_TIMEOUT_MS, d.timeoutMs, 500, 120_000),
    maxConcurrent: clampInt(env.EVIDENCE_EXTRACTION_MAX_CONCURRENT, d.maxConcurrent, 1, 16),
  };
}

export type EvidenceExtractionCode =
  | "input_too_large"
  | "not_a_document"
  | "too_many_entries"
  | "decompressed_size_limit"
  | "compression_ratio_limit"
  | "extracted_text_limit"
  | "extraction_timeout";

const MESSAGE_BY_CODE: Record<EvidenceExtractionCode, string> = {
  input_too_large: "The document exceeds the maximum size that can be processed.",
  not_a_document: "The file is not a valid document of its declared type.",
  too_many_entries: "The document contains too many internal parts.",
  decompressed_size_limit: "The document expands beyond the allowed size.",
  compression_ratio_limit: "The document is compressed beyond the allowed ratio.",
  extracted_text_limit: "The document contains more text than can be processed.",
  extraction_timeout: "The document took too long to process.",
};

export class EvidenceExtractionError extends Error {
  readonly code: EvidenceExtractionCode;
  constructor(code: EvidenceExtractionCode) {
    super(MESSAGE_BY_CODE[code]);
    this.name = "EvidenceExtractionError";
    this.code = code;
  }
}

export type OfficeArchiveKind = "docx" | "pptx" | "xlsx";

/** The part each container must have; anything else is not the declared document type. */
const REQUIRED_PART: Record<OfficeArchiveKind, string> = {
  docx: "word/document.xml",
  pptx: "ppt/presentation.xml",
  xlsx: "xl/workbook.xml",
};

export function assertExtractionInputSize(buffer: Buffer, limits: ExtractionLimits): void {
  if (buffer.length > limits.maxInputBytes) throw new EvidenceExtractionError("input_too_large");
}

/**
 * Inflates every entry as a stream, counting the bytes actually produced and
 * discarding them; stops at the first byte over budget. The declared sizes in
 * the ZIP metadata are never trusted, so a lying archive is caught too. Memory
 * stays at one chunk; work stops at the budget.
 */
export async function inspectOfficeArchive(buffer: Buffer, kind: OfficeArchiveKind, limits: ExtractionLimits): Promise<void> {
  assertExtractionInputSize(buffer, limits);
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(buffer);
  } catch {
    throw new EvidenceExtractionError("not_a_document");
  }
  const entries = Object.values(zip.files).filter((entry) => !entry.dir);
  if (entries.length > limits.maxArchiveEntries) throw new EvidenceExtractionError("too_many_entries");
  if (!zip.files[REQUIRED_PART[kind]]) throw new EvidenceExtractionError("not_a_document");

  const ratioBudget = Math.max(buffer.length, 1) * limits.maxCompressionRatio;
  let inflated = 0;
  for (const entry of entries) {
    await new Promise<void>((resolve, reject) => {
      const stream = entry.nodeStream("nodebuffer");
      let settled = false;
      const fail = (error: EvidenceExtractionError) => {
        if (settled) return;
        settled = true;
        (stream as unknown as { pause?: () => void }).pause?.();
        reject(error);
      };
      stream.on("data", (chunk: Buffer) => {
        inflated += chunk.length;
        if (inflated > limits.maxDecompressedBytes) fail(new EvidenceExtractionError("decompressed_size_limit"));
        else if (inflated > ratioBudget) fail(new EvidenceExtractionError("compression_ratio_limit"));
      });
      stream.on("error", () => fail(new EvidenceExtractionError("not_a_document")));
      stream.on("end", () => {
        if (!settled) {
          settled = true;
          resolve();
        }
      });
    });
  }
}

export function assertExtractedTextWithinLimit(text: string, limits: ExtractionLimits): void {
  if (text.length > limits.maxExtractedChars) throw new EvidenceExtractionError("extracted_text_limit");
}

/** Races the work against the deadline; onTimeout releases what the work holds (e.g. a PDF parser). */
export async function withExtractionDeadline<T>(work: Promise<T>, limits: ExtractionLimits, onTimeout?: () => void | Promise<void>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      void Promise.resolve(onTimeout?.()).catch(() => {});
      reject(new EvidenceExtractionError("extraction_timeout"));
    }, limits.timeoutMs);
  });
  try {
    return await Promise.race([work, deadline]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// One shared slot pool per process: uploads queue instead of parsing in parallel.
let activeExtractions = 0;
const waiting: Array<() => void> = [];

export async function runInExtractionSlot<T>(task: () => Promise<T>, limits: ExtractionLimits = resolveExtractionLimits()): Promise<T> {
  if (activeExtractions >= limits.maxConcurrent) await new Promise<void>((resolve) => waiting.push(resolve));
  activeExtractions += 1;
  try {
    return await task();
  } finally {
    activeExtractions -= 1;
    waiting.shift()?.();
  }
}

export const officeArchiveKindForMime = (mimeType: string): OfficeArchiveKind | null =>
  mimeType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    ? "docx"
    : mimeType === "application/vnd.openxmlformats-officedocument.presentationml.presentation"
      ? "pptx"
      : mimeType === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        ? "xlsx"
        : null;
