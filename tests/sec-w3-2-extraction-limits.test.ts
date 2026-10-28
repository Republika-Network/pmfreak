import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import JSZip from "jszip";
import {
  EXTRACTION_LIMIT_DEFAULTS,
  EvidenceExtractionError,
  assertExtractedTextWithinLimit,
  inspectOfficeArchive,
  officeArchiveKindForMime,
  resolveExtractionLimits,
  runInExtractionSlot,
  withExtractionDeadline,
  type ExtractionLimits,
} from "../src/lib/project-evidence/extraction-limits";
import { EvidenceProcessor } from "../src/lib/project-evidence/evidence-processor";

// SEC-W3-2 (five-persona QA, Wave 3): a 111 KB DOCX that inflated to 38 MB was parsed for about
// a minute in the shared app process. Live coverage (upload refusal, no row / object / quota,
// honest failure) is tests/security-regression/sec-w3-brief-authz-and-extraction-bounds.test.mjs.
// All archives here are synthetic and stay within a few megabytes.

const small = (overrides: Partial<ExtractionLimits> = {}): ExtractionLimits => ({ ...EXTRACTION_LIMIT_DEFAULTS, maxDecompressedBytes: 256 * 1024, ...overrides });

const docx = async (body: string, extra: Record<string, string> = {}) => {
  const zip = new JSZip();
  zip.file("[Content_Types].xml", "<Types/>");
  zip.file("word/document.xml", `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${body}</w:t></w:r></w:p></w:body></w:document>`);
  for (const [name, content] of Object.entries(extra)) zip.file(name, content);
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE", compressionOptions: { level: 9 } });
};

const rejectsWith = async (work: Promise<unknown>, code: string) =>
  assert.rejects(work, (error: unknown) => error instanceof EvidenceExtractionError && error.code === code);

test("SEC-W3-2: a normal small DOCX passes inspection", async () => {
  await inspectOfficeArchive(await docx("Risk: vendor access pending."), "docx", small());
});

test("SEC-W3-2: inflation beyond the decompressed budget is rejected while streaming", async () => {
  const bomb = await docx("x".repeat(400 * 1024));
  assert.ok(bomb.length < 8 * 1024, `compressed probe stays tiny (${bomb.length} B)`);
  // Ratio bound relaxed so this isolates the absolute budget (both bounds reject this probe by default).
  await rejectsWith(inspectOfficeArchive(bomb, "docx", small({ maxCompressionRatio: 1_000 })), "decompressed_size_limit");
  await assert.rejects(inspectOfficeArchive(bomb, "docx", small()), EvidenceExtractionError);
});

test("SEC-W3-2: an extreme inflation ratio is rejected even under the absolute budget", async () => {
  const dense = await docx("y".repeat(120 * 1024));
  await rejectsWith(inspectOfficeArchive(dense, "docx", small({ maxCompressionRatio: 10 })), "compression_ratio_limit");
});

test("SEC-W3-2: archives with too many parts, without the document part, or not ZIPs at all are rejected", async () => {
  const many: Record<string, string> = {};
  for (let i = 0; i < 30; i += 1) many[`word/media/part${i}.xml`] = "<x/>";
  await rejectsWith(inspectOfficeArchive(await docx("a", many), "docx", small({ maxArchiveEntries: 10 })), "too_many_entries");
  await rejectsWith(inspectOfficeArchive(await docx("a"), "pptx", small()), "not_a_document");
  await rejectsWith(inspectOfficeArchive(Buffer.from("PK\u0003\u0004 not really a zip"), "docx", small()), "not_a_document");
  await rejectsWith(inspectOfficeArchive(Buffer.alloc(2 * 1024, 1), "docx", small({ maxInputBytes: 1024 })), "input_too_large");
});

test("SEC-W3-2: extracted text beyond the bound is rejected, not truncated into a success", () => {
  assert.doesNotThrow(() => assertExtractedTextWithinLimit("a".repeat(1_000), small({ maxExtractedChars: 1_000 })));
  assert.throws(() => assertExtractedTextWithinLimit("a".repeat(1_001), small({ maxExtractedChars: 1_000 })), (e: unknown) => e instanceof EvidenceExtractionError && e.code === "extracted_text_limit");
});

test("SEC-W3-2: the deadline rejects and releases the work's resources", async () => {
  let released = false;
  await rejectsWith(withExtractionDeadline(new Promise(() => {}), small({ timeoutMs: 50 }), () => { released = true; }), "extraction_timeout");
  assert.equal(released, true);
  assert.equal(await withExtractionDeadline(Promise.resolve("done"), small({ timeoutMs: 50 })), "done");
});

test("SEC-W3-2: extractions queue behind a bounded number of slots", async () => {
  const limits = small({ maxConcurrent: 2 });
  let running = 0;
  let peak = 0;
  const task = () => runInExtractionSlot(async () => {
    running += 1;
    peak = Math.max(peak, running);
    await new Promise((resolve) => setTimeout(resolve, 20));
    running -= 1;
  }, limits);
  await Promise.all(Array.from({ length: 7 }, task));
  assert.equal(peak, 2);
});

test("SEC-W3-2: env overrides are clamped, so configuration can tighten but never remove a bound", () => {
  const limits = resolveExtractionLimits({ EVIDENCE_EXTRACTION_MAX_DECOMPRESSED_BYTES: "999999999999", EVIDENCE_EXTRACTION_TIMEOUT_MS: "0", EVIDENCE_EXTRACTION_MAX_CONCURRENT: "-4", EVIDENCE_EXTRACTION_MAX_CHARS: "abc" });
  assert.equal(limits.maxDecompressedBytes, 200 * 1024 * 1024);
  assert.equal(limits.timeoutMs, 500);
  assert.equal(limits.maxConcurrent, 1);
  assert.equal(limits.maxExtractedChars, EXTRACTION_LIMIT_DEFAULTS.maxExtractedChars);
  assert.deepEqual(resolveExtractionLimits({}), EXTRACTION_LIMIT_DEFAULTS);
});

test("SEC-W3-2: the processor applies the bounds to DOCX and still extracts a legitimate one", async () => {
  const processor = new EvidenceProcessor();
  const source = { id: "e", workspace_id: "w", project_id: "p", file_name: "a.docx", file_type: "DOCX", storage_path: "u/p/a.docx", uploaded_by: "u", uploaded_at: new Date().toISOString() };
  const ok = await processor.extractText(await docx("Decision: phased cutover."), source, small());
  assert.match(ok.text, /phased cutover/);
  await rejectsWith(processor.extractText(await docx("z".repeat(400 * 1024)), source, small({ maxCompressionRatio: 1_000 })), "decompressed_size_limit");
  await rejectsWith(processor.extractText(Buffer.alloc(2048, 65), { ...source, file_type: "TXT" }, small({ maxInputBytes: 1024 })), "input_too_large");
});

// ─── Wiring ───────────────────────────────────────────────────────────────────

const route = readFileSync("src/app/api/upload/route.ts", "utf8");
const processorSource = readFileSync("src/lib/project-evidence/evidence-processor.ts", "utf8");

test("SEC-W3-2: the upload route inspects ZIP documents before storing or charging them", () => {
  const inspect = route.indexOf("await inspectOfficeArchive(buffer, archiveKind, resolveExtractionLimits());");
  const store = route.indexOf("await provider.upload({");
  assert.ok(inspect > 0 && inspect < store, "inspection precedes storage");
  const branch = route.slice(inspect, store);
  assert.match(branch, /await rollbackAndCancel\(uploadedRefs\);\s*return errorResponse\(400, [^;]*"UNSAFE_DOCUMENT"\);/);
  assert.equal(officeArchiveKindForMime("application/vnd.openxmlformats-officedocument.wordprocessingml.document"), "docx");
  assert.equal(officeArchiveKindForMime("application/pdf"), null);
});

test("SEC-W3-2: every extractor is bounded and the background run uses the slot pool", () => {
  assert.match(processorSource, /parser\.getText\(\{ first: limits\.maxPdfPages \}\)/);
  assert.match(processorSource, /withExtractionDeadline\(parser\.getText[^\n]*\(\) => parser\.destroy\(\)\)/);
  for (const kind of ["docx", "xlsx", "pptx"]) assert.match(processorSource, new RegExp(`await inspectOfficeArchive\\(buffer, "${kind}", limits\\);`));
  assert.match(processorSource, /assertExtractedTextWithinLimit\(normalizedText, limits\);/);
  assert.match(processorSource, /assertExtractionInputSize\(buffer, limits\);/);
  assert.match(processorSource, /void runInExtractionSlot\(\(\) => new EvidenceProcessor\(\)\.processEvidence\(input\)\);/);
});
