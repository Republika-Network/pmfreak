/**
 * PD-22 / PD-23 (five-persona QA, Wave 3) — supported document formats reach extracted content.
 *
 * PD-23: the `pmfreak-documents` bucket allowed only PDF, DOCX and plain text, so every XLSX and
 * PPTX upload failed with 500 "Storage failed" (20261030000000_pd23_documents_bucket_office_mime_types.sql
 * aligns the bucket with ALLOWED_MIME_TYPES). PD-22 (the pdf.js worker in production builds) is
 * build-specific — proven by the QA browser harness and the CI build; here PDFs run in-process.
 *
 * Real sessions, the real upload route, the real bucket and the background processor: each
 * supported format is stored, processed and its text persisted in the project's workspace; a
 * viewer cannot upload; another tenant reads nothing; rejected archives are not charged.
 */
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import JSZip from "jszip";
import { bindAppEnvToHarness, createTenantFixtures, requireHarnessEnv } from "./support/harness.mjs";
import { actAs, installAppRouteMocks } from "./support/app-route-mocks.mjs";
import { syntheticPdf } from "../support/synthetic-pdf.mjs";

const env = requireHarnessEnv();
bindAppEnvToHarness(env);
installAppRouteMocks();

const { POST: uploadPost } = await import("../../src/app/api/upload/route.ts");
const { GET: contentGet } = await import("../../src/app/api/project-evidence-content/route.ts");
const { createWorkbookBlob } = await import("../../src/lib/spreadsheets/workbook-writer.ts");

const MIME = {
  pdf: "application/pdf",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};

let fx;
const sessions = {};

before(async () => {
  fx = await createTenantFixtures(env, { label: "pd2223" });
  for (const who of ["bPm", "bAdmin", "bViewer", "aOwner"]) sessions[who] = await fx.signIn(fx.users[who]);
});

after(async () => {
  if (!fx) return;
  const workspaces = [fx.workspaces.A, fx.workspaces.B];
  const { data: leftovers } = await fx.admin.from("project_evidence").select("storage_path").in("workspace_id", workspaces);
  const paths = (leftovers ?? []).map((row) => row.storage_path).filter(Boolean);
  if (paths.length) await fx.admin.storage.from("pmfreak-documents").remove(paths);
  for (const table of ["recommended_actions", "raid_items"]) await fx.admin.from(table).delete().in("workspace_id", workspaces);
  await fx.teardown();
});

const uploadFile = (projectId, name, type, bytes) => {
  const form = new FormData();
  form.set("projectId", projectId);
  form.append("documents", new File([bytes], name, { type }));
  return uploadPost(new Request("http://localhost/api/upload", { method: "POST", body: form }));
};

const finalStatus = async (evidenceId, timeoutMs = 60000) => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { data } = await fx.admin.from("project_evidence").select("status").eq("id", evidenceId).single();
    if (data?.status !== "processing") return data?.status;
    if (Date.now() > deadline) throw new Error("[pd22-pd23] extraction did not finish");
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
};

const persisted = async (evidenceId) => {
  const { data } = await fx.admin.from("project_evidence_content").select("extracted_text, extraction_method, workspace_id, project_id").eq("evidence_id", evidenceId).single();
  return data;
};

const xlsxBytes = async () => {
  const blob = await createWorkbookBlob({ sheetName: "Reqs", columns: [{ header: "ID", key: "id", width: 8 }, { header: "Requirement", key: "req", width: 40 }], rows: [{ id: "R1", req: "Phased cutover from legacy ledger" }] });
  return Buffer.from(await blob.arrayBuffer());
};
const pptxBytes = async () => {
  const zip = new JSZip();
  zip.file("[Content_Types].xml", "<Types/>");
  zip.file("ppt/presentation.xml", "<p:presentation/>");
  zip.file("ppt/slides/slide1.xml", '<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:t>Steering deck</a:t></p:sld>');
  return zip.generateAsync({ type: "nodebuffer" });
};

for (const [label, type, build, phrase, method] of [
  ["XLSX", MIME.xlsx, xlsxBytes, /R1 \| Phased cutover from legacy ledger/, "xlsx:worksheet-values"],
  ["PPTX", MIME.pptx, pptxBytes, /Steering deck/, "pptx:slide-xml-text"],
  ["multi-page PDF", MIME.pdf, async () => syntheticPdf(["Page one kickoff", "Page two vendor access", "Page three cutover"]), /Page three cutover/, "pdf-parse:text"],
]) {
  test(`PD-22/PD-23: a valid ${label} is stored, processed and its text persisted in the project's workspace`, async () => {
    actAs(sessions.bPm);
    const ext = { XLSX: "xlsx", PPTX: "pptx", "multi-page PDF": "pdf" }[label];
    const response = await uploadFile(fx.projects.B, `pd2223-${randomBytes(3).toString("hex")}.${ext}`, type, await build());
    const body = await response.json();
    assert.equal(response.status, 200, JSON.stringify(body));
    const evidenceId = body.evidenceIds[0];
    assert.equal(await finalStatus(evidenceId), "processed");
    const content = await persisted(evidenceId);
    assert.equal(content.extraction_method, method);
    assert.match(content.extracted_text, phrase);
    assert.equal(content.workspace_id, fx.workspaces.B);
    assert.equal(content.project_id, fx.projects.B);
  });
}

test("PD-23: a viewer still cannot upload an XLSX, and nothing is stored or charged", async () => {
  actAs(sessions.bViewer);
  const before = (await fx.admin.from("project_evidence").select("id").eq("project_id", fx.projects.B)).data.length;
  const response = await uploadFile(fx.projects.B, "viewer.xlsx", MIME.xlsx, await xlsxBytes());
  assert.equal(response.status, 403);
  assert.equal((await fx.admin.from("project_evidence").select("id").eq("project_id", fx.projects.B)).data.length, before);
  const { data: usage } = await fx.admin.from("company_usage").select("upload_count").eq("company_id", fx.users.bViewer.id);
  assert.equal((usage ?? []).reduce((n, row) => n + Number(row.upload_count ?? 0), 0), 0);
});

test("PD-22/PD-23: another tenant cannot read the extracted text", async () => {
  actAs(sessions.aOwner);
  const response = await contentGet(new Request(`http://localhost/api/project-evidence-content?projectId=${fx.projects.B}`));
  assert.ok([403, 404].includes(response.status), `status ${response.status}`);
  assert.doesNotMatch(await response.text(), /Phased cutover|Steering deck|Page three/);
});
