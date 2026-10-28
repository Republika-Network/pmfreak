/**
 * SEC-W3-1 / SEC-W3-2 (five-persona QA, Wave 3).
 *
 * SEC-W3-1 — POST /api/projects/[id]/operational-governance-brief only authenticated, and
 * operational_governance_briefs let any member insert/update, so a viewer could overwrite the
 * project's governance brief. The route now requires project write (owner/admin/pm) and
 * 20261029000000_sec_w3_1_governance_brief_writers.sql makes the table writer-only with the
 * project tied to the row's workspace.
 *
 * SEC-W3-2 — document extraction had no decompression, text or time bound for DOCX/PPTX/PDF.
 * ZIP-based documents are now inflated under a budget at upload (before storage or quota
 * commit) and again by the background processor; extracted text is capped.
 *
 * Synthetic, bounded inputs only: the limits are lowered for this file so the archives stay
 * a few megabytes when expanded. No uncontrolled decompression test is run.
 */
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import JSZip from "jszip";
import { bindAppEnvToHarness, createTenantFixtures, requireHarnessEnv } from "./support/harness.mjs";
import { actAs, installAppRouteMocks } from "./support/app-route-mocks.mjs";

const env = requireHarnessEnv();
bindAppEnvToHarness(env);
installAppRouteMocks();

// Bounded test limits (clamped minimums): 1 MB inflated, 5,000 extracted characters.
process.env.EVIDENCE_EXTRACTION_MAX_DECOMPRESSED_BYTES = String(1024 * 1024);
process.env.EVIDENCE_EXTRACTION_MAX_CHARS = "5000";

const { POST: briefPost } = await import("../../src/app/api/projects/[id]/operational-governance-brief/route.ts");
const { POST: uploadPost } = await import("../../src/app/api/upload/route.ts");

const INSUFFICIENT_PRIVILEGE = "42501";
const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

let fx;
const sessions = {};

before(async () => {
  fx = await createTenantFixtures(env, { label: "secw3" });
  for (const who of ["bOwner", "bAdmin", "bPm", "bViewer", "aOwner"]) sessions[who] = await fx.signIn(fx.users[who]);
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

const waitFor = async (what, probe, timeoutMs = 30000) => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`[sec-w3] timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
};

// ─── SEC-W3-1 ────────────────────────────────────────────────────────────────

const regenerate = (projectId) =>
  briefPost(new Request(`http://127.0.0.1:3000/api/projects/${projectId}/operational-governance-brief`, { method: "POST", body: "{}" }), { params: Promise.resolve({ id: projectId }) });

const briefOf = async (projectId) => {
  const { data, error } = await fx.admin.from("operational_governance_briefs").select("id, generated_at, brief_payload, confidence_score, created_by").eq("project_id", projectId).maybeSingle();
  if (error) throw new Error(`[sec-w3] read brief: ${error.message}`);
  return data;
};

test("SEC-W3-1: owner, admin and pm regenerate the brief; each regeneration is attributed to its writer", async () => {
  for (const who of ["bOwner", "bAdmin", "bPm"]) {
    actAs(sessions[who]);
    const response = await regenerate(fx.projects.B);
    assert.equal(response.status, 200, `${who}: ${JSON.stringify(await response.clone().json())}`);
    assert.equal((await briefOf(fx.projects.B))?.created_by, fx.users[who].id);
  }
});

test("SEC-W3-1: a viewer is refused by the route and the brief is left exactly as it was", async () => {
  const before = await briefOf(fx.projects.B);
  assert.ok(before, "a brief exists");
  actAs(sessions.bViewer);
  const response = await regenerate(fx.projects.B);
  assert.equal(response.status, 403);
  assert.deepEqual(await briefOf(fx.projects.B), before);
});

test("SEC-W3-1: a viewer cannot write the brief directly through PostgREST either", async () => {
  const before = await briefOf(fx.projects.B);
  const update = await sessions.bViewer.from("operational_governance_briefs").update({ confidence_score: 0.01 }).eq("project_id", fx.projects.B).select("id");
  assert.deepEqual(update.data ?? [], [], `update reached a row: ${JSON.stringify(update)}`);
  assert.deepEqual(await briefOf(fx.projects.B), before);
  const freshProject = await fx.createProject(fx.workspaces.B, fx.users.bOwner.id, `secw3 viewer insert ${fx.tag}`);
  const insert = await sessions.bViewer.from("operational_governance_briefs").insert({ workspace_id: fx.workspaces.B, project_id: freshProject, brief_payload: {}, confidence_score: 0, created_by: fx.users.bViewer.id });
  assert.equal(insert.error?.code, INSUFFICIENT_PRIVILEGE, JSON.stringify(insert));
  assert.equal(await briefOf(freshProject), null);
});

test("SEC-W3-1: another tenant can neither regenerate B's brief nor squat B's project slot from its own workspace", async () => {
  const before = await briefOf(fx.projects.B);
  actAs(sessions.aOwner);
  const response = await regenerate(fx.projects.B);
  assert.ok([403, 404].includes(response.status), `status ${response.status}`);
  assert.deepEqual(await briefOf(fx.projects.B), before);
  // A writer of A inserts a brief that names B's (brief-less) project under A's workspace.
  const victim = await fx.createProject(fx.workspaces.B, fx.users.bOwner.id, `secw3 squat target ${fx.tag}`);
  const squat = await sessions.aOwner.from("operational_governance_briefs").insert({ workspace_id: fx.workspaces.A, project_id: victim, brief_payload: {}, confidence_score: 0, created_by: fx.users.aOwner.id });
  assert.equal(squat.error?.code, INSUFFICIENT_PRIVILEGE, JSON.stringify(squat));
  assert.equal(await briefOf(victim), null);
  // B's owner can still create the brief for that project.
  actAs(sessions.bOwner);
  assert.equal((await regenerate(victim)).status, 200);
  assert.equal((await briefOf(victim))?.created_by, fx.users.bOwner.id);
});

// ─── SEC-W3-2 ────────────────────────────────────────────────────────────────

/** A minimal, valid DOCX whose document.xml holds `paragraphs` copies of `text`. */
const docx = async (text, paragraphs = 1) => {
  const zip = new JSZip();
  zip.file("[Content_Types].xml", '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
  zip.file("_rels/.rels", '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  zip.file("word/document.xml", `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${`<w:p><w:r><w:t>${text}</w:t></w:r></w:p>`.repeat(paragraphs)}</w:body></w:document>`);
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE", compressionOptions: { level: 9 } });
};

const uploadFile = (projectId, name, type, bytes) => {
  const form = new FormData();
  form.set("projectId", projectId);
  form.append("documents", new File([bytes], name, { type }));
  return uploadPost(new Request("http://localhost/api/upload", { method: "POST", body: form }));
};

const usageOf = async (userId) => {
  const { data } = await fx.admin.from("company_usage").select("upload_count").eq("company_id", userId);
  return (data ?? []).reduce((sum, row) => sum + Number(row.upload_count ?? 0), 0);
};
const evidenceCount = async (projectId) => (await fx.admin.from("project_evidence").select("id").eq("project_id", projectId)).data?.length ?? 0;
const storedObjects = async (userId, projectId) => ((await fx.admin.storage.from("pmfreak-documents").list(`${userId}/${projectId}`)).data ?? []).filter((object) => object.id).length;

test("SEC-W3-2: a DOCX that inflates past the bound is refused at upload — no row, no stored object, no quota", async () => {
  const bomb = await docx("qa synthetic filler ".repeat(40), 2_000); // ~2 MB of XML from a few KB
  assert.ok(bomb.length < 64 * 1024, `bomb stays small: ${bomb.length} bytes`);
  actAs(sessions.bPm);
  const [rows, objects, usage] = [await evidenceCount(fx.projects.B), await storedObjects(fx.users.bPm.id, fx.projects.B), await usageOf(fx.users.bPm.id)];
  const response = await uploadFile(fx.projects.B, `secw3-bomb-${randomBytes(3).toString("hex")}.docx`, DOCX_MIME, bomb);
  const body = await response.json();
  assert.equal(response.status, 400, JSON.stringify(body));
  assert.equal(body.code, "UNSAFE_DOCUMENT");
  assert.match(body.error, /decompressed_size_limit|compression_ratio_limit/);
  assert.equal(await evidenceCount(fx.projects.B), rows);
  assert.equal(await storedObjects(fx.users.bPm.id, fx.projects.B), objects);
  assert.equal(await usageOf(fx.users.bPm.id), usage);
});

test("SEC-W3-2: an XLSX inflation bomb is refused by the same bound (400, not a 500 later)", async () => {
  const zip = new JSZip();
  zip.file("[Content_Types].xml", "<Types/>");
  zip.file("xl/workbook.xml", "<workbook/>");
  zip.file("xl/worksheets/sheet1.xml", `<worksheet><sheetData>${"<row><c><v>1</v></c></row>".repeat(80_000)}</sheetData></worksheet>`);
  const bytes = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE", compressionOptions: { level: 9 } });
  actAs(sessions.bPm);
  const response = await uploadFile(fx.projects.B, "secw3-bomb.xlsx", XLSX_MIME, bytes);
  const body = await response.json();
  assert.equal(response.status, 400, JSON.stringify(body));
  assert.equal(body.code, "UNSAFE_DOCUMENT");
});

test("SEC-W3-2: a document that is not the declared container is refused before storage", async () => {
  const zip = new JSZip();
  zip.file("notes.txt", "a zip, but not a Word document");
  const bytes = await zip.generateAsync({ type: "nodebuffer" });
  actAs(sessions.bPm);
  const rows = await evidenceCount(fx.projects.B);
  const response = await uploadFile(fx.projects.B, "secw3-not-docx.docx", DOCX_MIME, bytes);
  const body = await response.json();
  assert.equal(response.status, 400, JSON.stringify(body));
  assert.equal(body.code, "UNSAFE_DOCUMENT");
  assert.equal(await evidenceCount(fx.projects.B), rows);
});

test("SEC-W3-2: a small legitimate DOCX is still accepted and extracted", async () => {
  actAs(sessions.bAdmin);
  const bytes = await docx("Risk: the vendor API access is pending. Decision: phased cutover.");
  const response = await uploadFile(fx.projects.B, `secw3-ok-${randomBytes(3).toString("hex")}.docx`, DOCX_MIME, bytes);
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  const evidenceId = body.evidenceIds[0];
  const status = await waitFor("processed", async () => {
    const { data } = await fx.admin.from("project_evidence").select("status").eq("id", evidenceId).single();
    return data?.status === "processing" ? null : data?.status;
  });
  assert.equal(status, "processed");
  const { data: content } = await fx.admin.from("project_evidence_content").select("extracted_text").eq("evidence_id", evidenceId).single();
  assert.match(content.extracted_text, /phased cutover/);
});

test("SEC-W3-2: text beyond the extraction bound ends as an honest failure — no stored content, no success record", async () => {
  actAs(sessions.bAdmin);
  const text = "Synthetic status line for the extraction bound.\n".repeat(200); // ~10,000 characters
  const response = await uploadFile(fx.projects.B, `secw3-long-${randomBytes(3).toString("hex")}.txt`, "text/plain", Buffer.from(text));
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  const evidenceId = body.evidenceIds[0];
  const status = await waitFor("final status", async () => {
    const { data } = await fx.admin.from("project_evidence").select("status").eq("id", evidenceId).single();
    return data?.status === "processing" ? null : data?.status;
  });
  assert.equal(status, "failed");
  const { data: content } = await fx.admin.from("project_evidence_content").select("id").eq("evidence_id", evidenceId);
  assert.deepEqual(content, []);
});
