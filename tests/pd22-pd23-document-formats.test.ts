import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import JSZip from "jszip";
import { EvidenceProcessor } from "../src/lib/project-evidence/evidence-processor";
import { EXTRACTION_LIMIT_DEFAULTS, EvidenceExtractionError } from "../src/lib/project-evidence/extraction-limits";
import { createWorkbookBlob } from "../src/lib/spreadsheets/workbook-writer";
import { syntheticPdf } from "./support/synthetic-pdf.mjs";

// PD-22 / PD-23 (five-persona QA, Wave 3). In a production build every PDF failed ("Setting up
// fake worker failed: Cannot find module .next/server/chunks/pdf.worker.mjs"), and the evidence
// bucket refused XLSX/PPTX ("mime type … is not supported"). The build-level proof is the QA
// browser harness and the CI build; these cover the extraction paths and pin the decisions.

const source = (fileType: string) => ({ id: "e", workspace_id: "w", project_id: "p", file_name: `f.${fileType.toLowerCase()}`, file_type: fileType, storage_path: "u/p/f", uploaded_by: "u", uploaded_at: new Date().toISOString() });
const processor = new EvidenceProcessor();

test("PD-22: a multi-page PDF is extracted page by page", async () => {
  const pdf = syntheticPdf(Array.from({ length: 12 }, (_, i) => `Synthetic page ${i + 1} phased cutover`));
  const { text, method } = await processor.extractText(pdf, source("PDF"));
  assert.equal(method, "pdf-parse:text");
  for (const n of [1, 6, 12]) assert.match(text, new RegExp(`Synthetic page ${n} phased cutover`));
});

test("PD-22: the SEC-W3-2 page bound still applies to PDFs", async () => {
  const pdf = syntheticPdf(Array.from({ length: 5 }, (_, i) => `Bounded page ${i + 1}`));
  const { text } = await processor.extractText(pdf, source("PDF"), { ...EXTRACTION_LIMIT_DEFAULTS, maxPdfPages: 2 });
  assert.match(text, /Bounded page 2/);
  assert.doesNotMatch(text, /Bounded page 3/);
});

test("PD-22: a malformed PDF and an oversized PDF are rejected, not half-extracted", async () => {
  await assert.rejects(processor.extractText(Buffer.from("%PDF-1.7\nnot an object graph\n".repeat(20)), source("PDF")));
  await assert.rejects(
    processor.extractText(syntheticPdf(["x"]), source("PDF"), { ...EXTRACTION_LIMIT_DEFAULTS, maxInputBytes: 64 }),
    (error: unknown) => error instanceof EvidenceExtractionError && error.code === "input_too_large",
  );
});

test("PD-23: a valid XLSX is extracted with its cell text", async () => {
  // A real workbook written by the product's own exceljs export path.
  const blob = await createWorkbookBlob({ sheetName: "Reqs", columns: [{ header: "ID", key: "id", width: 8 }, { header: "Requirement", key: "req", width: 40 }], rows: [{ id: "R1", req: "Phased cutover from legacy ledger" }] });
  const { text, method } = await processor.extractText(Buffer.from(await blob.arrayBuffer()), source("XLSX"));
  assert.equal(method, "xlsx:worksheet-values");
  assert.match(text, /Sheet: Reqs/);
  assert.match(text, /R1 \| Phased cutover from legacy ledger/);
});

test("PD-23 (PPTX assessment): a valid PPTX is extracted with its slide text", async () => {
  const zip = new JSZip();
  zip.file("[Content_Types].xml", "<Types/>");
  zip.file("ppt/presentation.xml", "<p:presentation xmlns:p=\"http://schemas.openxmlformats.org/presentationml/2006/main\"/>");
  zip.file("ppt/slides/slide1.xml", '<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:t>Steering deck</a:t><a:t>Decision: phased cutover</a:t></p:sld>');
  const { text } = await processor.extractText(await zip.generateAsync({ type: "nodebuffer" }), source("PPTX"));
  assert.match(text, /Slide 1:\nSteering deck\nDecision: phased cutover/);
});

// ─── Pins ─────────────────────────────────────────────────────────────────────

const processorSource = readFileSync("src/lib/project-evidence/evidence-processor.ts", "utf8");
const route = readFileSync("src/app/api/upload/route.ts", "utf8");
const migration = readFileSync("supabase/migrations/20261030000000_pd23_documents_bucket_office_mime_types.sql", "utf8");
const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const pdfParsePkg = JSON.parse(readFileSync("node_modules/pdf-parse/package.json", "utf8"));

test("PD-22: the pdf.js worker is registered in-process before any PDF is parsed", () => {
  assert.match(processorSource, /import\("pdfjs-dist\/legacy\/build\/pdf\.worker\.mjs"\)/);
  const fn = processorSource.slice(processorSource.indexOf("const extractPdfText"));
  assert.ok(fn.indexOf("await ensurePdfWorker();") < fn.indexOf("new PDFParse("), "worker before parser");
  assert.doesNotMatch(processorSource, /setWorker\(|workerSrc/, "no file-path worker configuration");
});

test("PD-22: pdfjs-dist is declared at exactly the version pdf-parse uses (worker and API must match)", () => {
  assert.equal(pkg.dependencies["pdfjs-dist"], pdfParsePkg.dependencies["pdfjs-dist"]);
});

test("PD-23: the bucket allows exactly the MIME types the upload route accepts", () => {
  const routeTypes = [...route.slice(route.indexOf("const ALLOWED_MIME_TYPES = new Set(["), route.indexOf("]);", route.indexOf("const ALLOWED_MIME_TYPES"))).matchAll(/"([^"]+)"/g)].map((m) => m[1]).sort();
  const bucketTypes = [...migration.slice(migration.indexOf("array["), migration.indexOf("]", migration.indexOf("array["))).matchAll(/'([^']+)'/g)].map((m) => m[1]).sort();
  assert.deepEqual(bucketTypes, routeTypes);
  assert.match(migration, /where id = 'pmfreak-documents';/);
  assert.doesNotMatch(migration, /public\s*=|file_size_limit|create policy|grant /i, "nothing but the MIME list changes");
});
