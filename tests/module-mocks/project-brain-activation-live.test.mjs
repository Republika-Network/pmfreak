/**
 * Project Brain activation — live integration against a DISPOSABLE local
 * Supabase stack with every migration applied (real GoTrue sessions, real
 * PostgREST, real RLS, real Postgres). Skipped unless the env below is set.
 *
 * Drives the real, unmodified `saveProjectOnboarding` server action. Only the
 * Next.js request context is faked: `next/headers` cookies() hands the action
 * the session cookies a real signInWithPassword wrote.
 *
 * Reproduces the production failure — "An unexpected error occurred" /
 * unexpected_exception for a workspace member without PMO-management rights in
 * a workspace that had no PMO yet ("Unable to ensure default PMO: new row
 * violates row-level security policy for table pmos") — and covers success,
 * retry, partial initialization, concurrency and authorization.
 *
 *   PROJECT_BRAIN_LIVE_SUPABASE_URL      loopback API URL, e.g. http://127.0.0.1:56321
 *   PROJECT_BRAIN_LIVE_ANON_KEY
 *   PROJECT_BRAIN_LIVE_SERVICE_ROLE_KEY
 *   PROJECT_BRAIN_LIVE_DB_CONTAINER      optional: the stack's supabase_db_* container,
 *                                        enables the database fault-injection cases
 *
 * Run: npx tsx --experimental-test-module-mocks --test tests/module-mocks/project-brain-activation-live.test.mjs
 */

import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mockModuleOptions, resolveMockTarget } from "./release-gate-01-fake-supabase.mjs";

const URL_ = process.env.PROJECT_BRAIN_LIVE_SUPABASE_URL;
const ANON = process.env.PROJECT_BRAIN_LIVE_ANON_KEY;
const SERVICE = process.env.PROJECT_BRAIN_LIVE_SERVICE_ROLE_KEY;
const enabled = Boolean(URL_ && ANON && SERVICE && ["127.0.0.1", "localhost", "[::1]"].includes(new URL(URL_ ?? "http://x").hostname));
const skip = enabled ? false : "set PROJECT_BRAIN_LIVE_* to a loopback, disposable Supabase stack to run";
const DB_CONTAINER = process.env.PROJECT_BRAIN_LIVE_DB_CONTAINER;
const skipFaults = skip || (DB_CONTAINER && /^supabase_db_[a-z0-9-]+$/.test(DB_CONTAINER) ? false : "set PROJECT_BRAIN_LIVE_DB_CONTAINER for fault injection");
function psql(sql) {
  const run = spawnSync("docker", ["exec", "-i", DB_CONTAINER, "psql", "-U", "postgres", "-v", "ON_ERROR_STOP=1", "-q"], { input: sql, encoding: "utf8" });
  if (run.status !== 0) throw new Error(run.stderr);
}

if (enabled) {
  process.env.NEXT_PUBLIC_SUPABASE_URL = URL_;
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = ANON;
  process.env.SUPABASE_SERVICE_ROLE_KEY = SERVICE;
}

// The cookie store the action sees for the CURRENT request.
let store = new Map();
const jar = {
  get: (name) => (store.has(name) ? { name, value: store.get(name) } : undefined),
  getAll: () => [...store].map(([name, value]) => ({ name, value })),
  set: (name, value) => (typeof name === "object" ? store.set(name.name, name.value) : store.set(name, value)),
  delete: (name) => store.delete(name),
  has: (name) => store.has(name),
};
mock.module(resolveMockTarget("next/headers"), mockModuleOptions({ cookies: async () => jar, headers: async () => new Headers() }));

const quiet = console.info;
console.info = () => {};

const SPANISH_PAYLOAD = () => ({
  identity: {
    projectName: "Lanzamiento de listalaboda.com",
    clientOrganization: "Lista La Boda S.A. de C.V.",
    projectType: "software-delivery",
    contractCode: "LLB-2026-001",
    pmAssigned: "Víctor Valverde",
    technicalLead: "María José Peña",
    targetDeliveryDate: "2026-12-15",
  },
  deliveryContext: {
    problemStatement: "Las parejas no tienen una forma sencilla de compartir su lista de bodas y recibir aportaciones en línea; hoy dependen de hojas de cálculo y transferencias.",
    mainDeliverable: "Plataforma web listalaboda.com en producción: registro de parejas, lista de regalos, pagos y panel de seguimiento.",
    externalDependencies: "Pasarela de pagos (Stripe), proveedor de correo transaccional, dominio .com y certificado TLS.",
    contractualMilestones: "Beta privada el 15 de noviembre; lanzamiento público antes del 15 de diciembre.",
    scopeType: "iterative",
  },
  governance: { raidInitialized: true, stakeholdersInitialized: true, deliveryCadenceInitialized: true, reportingStructureInitialized: true, escalationMapInitialized: true, healthBaselineInitialized: true },
  discovery: {
    unknowns: "Volumen esperado de tráfico en temporada alta; comisiones finales de la pasarela.",
    requirementsDefined: false,
    pendingClientDependencies: "Aprobación del diseño final y de los textos legales (aviso de privacidad).",
    pendingAccesses: "Acceso a la cuenta de Stripe y al DNS del dominio.",
    vendorDependencies: "Proveedor de hosting y servicio de correo.",
    financialBlockers: "Presupuesto de marketing de lanzamiento pendiente de aprobación.",
  },
  createdAt: "2026-10-11T18:00:00.000Z",
});

let admin;
let createServerClient;
let saveProjectOnboarding;
const password = `P-${randomUUID()}!`;

async function signIn(email) {
  store = new Map();
  const ssr = createServerClient(URL_, ANON, { cookies: { getAll: () => jar.getAll(), setAll: (c) => c.forEach(({ name, value }) => store.set(name, value)) } });
  const res = await ssr.auth.signInWithPassword({ email, password });
  assert.ifError(res.error);
}

async function newUser(label) {
  const email = `brain-${label}-${randomUUID().slice(0, 8)}@example.test`;
  const created = await admin.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { full_name: "Ana Pérez" } });
  assert.ifError(created.error);
  return { id: created.data.user.id, email };
}

/** A workspace owned by someone else in which `member` holds `role`; optionally with an active PMO. */
async function foreignWorkspace(member, role, { withPmo = false } = {}) {
  const owner = await newUser("owner");
  const { data: ws } = await admin.from("workspaces").insert({ name: "Espacio del cliente", created_by_user_id: owner.id }).select("id").single();
  await admin.from("workspace_memberships").insert([{ workspace_id: ws.id, user_id: owner.id, role: "owner" }, { workspace_id: ws.id, user_id: member.id, role }]);
  let pmoId = null;
  if (withPmo) {
    const { data: pmo } = await admin.from("pmos").insert({ workspace_id: ws.id, name: "PMO General", created_by_user_id: owner.id }).select("id").single();
    pmoId = pmo.id;
  }
  return { workspaceId: ws.id, pmoId };
}

async function footprint({ userId, projectId, workspaceId }) {
  const count = async (q) => {
    const { count: n, error } = await q;
    assert.ifError(error);
    return n;
  };
  const head = { count: "exact", head: true };
  return {
    projects: await count(admin.from("projects").select("id", head).eq("user_id", userId)),
    vaultDocuments: projectId ? await count(admin.from("vault_documents").select("id", head).eq("project_id", projectId)) : null,
    rawInputs: projectId ? await count(admin.from("operational_raw_inputs").select("id", head).eq("project_id", projectId)) : null,
    briefs: projectId ? await count(admin.from("operational_governance_briefs").select("id", head).eq("project_id", projectId)) : null,
    pmos: workspaceId ? await count(admin.from("pmos").select("id", head).eq("workspace_id", workspaceId)) : null,
  };
}

const projectRow = async (id) => (await admin.from("projects").select("id, workspace_id, pmo_id, name, description, onboarding_payload").eq("id", id).single()).data;
const key = () => `act_${randomUUID()}`;

test.before(async () => {
  if (!enabled) return;
  const { createClient } = await import("@supabase/supabase-js");
  admin = createClient(URL_, SERVICE, { auth: { persistSession: false } });
  ({ createServerClient } = await import("@supabase/ssr"));
  ({ saveProjectOnboarding } = await import("../../src/lib/projects/save-project-onboarding.ts"));
});

test.after(() => {
  console.info = quiet;
});

// ─── The production failure ──────────────────────────────────────────────────

test("viewer in a workspace with no PMO: activation succeeds, project is unassigned, NO pmos row is written", { skip }, async () => {
  const user = await newUser("viewer");
  const { workspaceId } = await foreignWorkspace(user, "viewer");
  await signIn(user.email);
  const result = await saveProjectOnboarding(SPANISH_PAYLOAD(), "cid-viewer", { workspaceId, activationRequestId: key() });
  assert.equal(result.status, "success", JSON.stringify(result));
  const row = await projectRow(result.projectId);
  assert.equal(row.workspace_id, workspaceId);
  assert.equal(row.pmo_id, null, "unassigned is a first-class state (ADR-PMF-003 rule 4)");
  assert.equal((await footprint({ userId: user.id, workspaceId })).pmos, 0, "the viewer still cannot create a PMO — RLS unchanged");
});

test("viewer whose only membership is that workspace (implicit target, as from /projects/new): succeeds", { skip }, async () => {
  const user = await newUser("viewer-implicit");
  await foreignWorkspace(user, "viewer");
  await signIn(user.email);
  const result = await saveProjectOnboarding(SPANISH_PAYLOAD(), "cid-viewer-implicit", { activationRequestId: key() });
  assert.equal(result.status, "success", JSON.stringify(result));
});

test("viewer in a workspace that already has a PMO is attached to it", { skip }, async () => {
  const user = await newUser("viewer-pmo");
  const { workspaceId, pmoId } = await foreignWorkspace(user, "viewer", { withPmo: true });
  await signIn(user.email);
  const result = await saveProjectOnboarding(SPANISH_PAYLOAD(), "cid", { workspaceId, activationRequestId: key() });
  assert.equal(result.status, "success");
  assert.equal((await projectRow(result.projectId)).pmo_id, pmoId);
});

// ─── Success: everything initialized, Spanish content verbatim ───────────────

test("owner success: project, PMO, setup context (vault + evidence), brief — Spanish content preserved verbatim", { skip }, async () => {
  const user = await newUser("owner-ok");
  await signIn(user.email);
  const payload = SPANISH_PAYLOAD();
  const activationRequestId = key();
  const result = await saveProjectOnboarding(payload, "cid-owner", { activationRequestId });
  assert.equal(result.status, "success", JSON.stringify(result));
  assert.equal(result.briefStatus, "generated");

  const row = await projectRow(result.projectId);
  assert.equal(row.name, "Lanzamiento de listalaboda.com");
  assert.equal(row.description, payload.deliveryContext.problemStatement);
  assert.ok(row.pmo_id, "owner gets the default PMO");
  const { brainActivation, ...content } = row.onboarding_payload;
  assert.deepEqual(content, payload, "every submitted field (identity, scope, stakeholders, constraints, discovery) persisted byte-for-byte");
  assert.equal(brainActivation.requestId, activationRequestId);
  assert.ok(brainActivation.setupContextCompletedAt && brainActivation.briefCompletedAt && brainActivation.completedAt);

  const fp = await footprint({ userId: user.id, projectId: result.projectId });
  assert.deepEqual({ vault: fp.vaultDocuments, raw: fp.rawInputs, briefs: fp.briefs }, { vault: 1, raw: 1, briefs: 1 });
});

// ─── Retry and idempotency ───────────────────────────────────────────────────

test("retry with the same activation key after success: same project, nothing duplicated", { skip }, async () => {
  const user = await newUser("retry");
  await signIn(user.email);
  const activationRequestId = key();
  const first = await saveProjectOnboarding(SPANISH_PAYLOAD(), "cid-1", { activationRequestId });
  const before = await footprint({ userId: user.id, projectId: first.projectId });
  const second = await saveProjectOnboarding(SPANISH_PAYLOAD(), "cid-2", { activationRequestId });
  assert.equal(second.status, "success");
  assert.equal(second.projectId, first.projectId);
  assert.deepEqual(await footprint({ userId: user.id, projectId: first.projectId }), before);
});

test("partial initialization (request died right after the insert) is resumed exactly once", { skip }, async () => {
  const user = await newUser("partial");
  await signIn(user.email);
  const activationRequestId = key();
  // Exactly what a request that died after the insert leaves behind: the row,
  // its marker, and no downstream step completed.
  const { data: ws } = await admin.from("workspace_memberships").select("workspace_id").eq("user_id", user.id).maybeSingle();
  let workspaceId = ws?.workspace_id;
  if (!workspaceId) {
    const bootstrap = await saveProjectOnboarding(SPANISH_PAYLOAD(), "bootstrap", { activationRequestId: key() });
    workspaceId = bootstrap.workspaceId;
  }
  const payload = SPANISH_PAYLOAD();
  const { data: orphan } = await admin
    .from("projects")
    .insert({ user_id: user.id, workspace_id: workspaceId, name: payload.identity.projectName, status: "active", onboarding_payload: { ...payload, brainActivation: { requestId: activationRequestId, startedAt: new Date().toISOString(), setupContextCompletedAt: null, briefCompletedAt: null, completedAt: null } } })
    .select("id")
    .single();

  const resumed = await saveProjectOnboarding(payload, "cid-resume", { activationRequestId });
  assert.equal(resumed.status, "success", JSON.stringify(resumed));
  assert.equal(resumed.projectId, orphan.id, "the existing project is finished, not duplicated");
  const fp = await footprint({ userId: user.id, projectId: orphan.id });
  assert.deepEqual({ vault: fp.vaultDocuments, raw: fp.rawInputs, briefs: fp.briefs }, { vault: 1, raw: 1, briefs: 1 });

  // A further retry changes nothing.
  await saveProjectOnboarding(payload, "cid-resume-2", { activationRequestId });
  assert.deepEqual(await footprint({ userId: user.id, projectId: orphan.id }), fp);
});

test("resume after the setup context completed but the brief did not: only the brief runs", { skip }, async () => {
  const user = await newUser("partial-brief");
  await signIn(user.email);
  const activationRequestId = key();
  const first = await saveProjectOnboarding(SPANISH_PAYLOAD(), "cid", { activationRequestId });
  // Simulate the brief never having been written.
  await admin.from("operational_governance_briefs").delete().eq("project_id", first.projectId);
  const row = await projectRow(first.projectId);
  await admin.from("projects").update({ onboarding_payload: { ...row.onboarding_payload, brainActivation: { ...row.onboarding_payload.brainActivation, briefCompletedAt: null, completedAt: null } } }).eq("id", first.projectId);
  const before = await footprint({ userId: user.id, projectId: first.projectId });

  const resumed = await saveProjectOnboarding(SPANISH_PAYLOAD(), "cid-2", { activationRequestId });
  assert.equal(resumed.projectId, first.projectId);
  const after = await footprint({ userId: user.id, projectId: first.projectId });
  assert.deepEqual({ ...after, briefs: before.briefs }, before, "setup context is not ingested again");
  assert.equal(after.briefs, 1);
});

test("an edit made before retrying is applied to the resumed project", { skip }, async () => {
  const user = await newUser("edit");
  await signIn(user.email);
  const activationRequestId = key();
  const first = await saveProjectOnboarding(SPANISH_PAYLOAD(), "cid", { activationRequestId });
  const edited = SPANISH_PAYLOAD();
  edited.identity.projectName = "Lanzamiento de listalaboda.com — fase 1";
  const second = await saveProjectOnboarding(edited, "cid-2", { activationRequestId });
  assert.equal(second.projectId, first.projectId);
  const row = await projectRow(first.projectId);
  assert.equal(row.name, "Lanzamiento de listalaboda.com — fase 1");
  assert.equal(row.onboarding_payload.identity.projectName, "Lanzamiento de listalaboda.com — fase 1");
});

test("5 concurrent attempts with one activation key create exactly one project", { skip }, async () => {
  const user = await newUser("race");
  await signIn(user.email);
  // Bootstrap the workspace first so the race is about the project, not the workspace.
  const warm = await saveProjectOnboarding(SPANISH_PAYLOAD(), "warm", { activationRequestId: key() });
  const activationRequestId = key();
  const results = await Promise.all(Array.from({ length: 5 }, (_, i) => saveProjectOnboarding(SPANISH_PAYLOAD(), `cid-${i}`, { activationRequestId })));
  assert.ok(results.every((r) => r.status === "success"), JSON.stringify(results));
  assert.equal(new Set(results.map((r) => r.projectId)).size, 1);
  assert.equal((await footprint({ userId: user.id })).projects, 2, "the warm-up project + exactly one more");
  assert.notEqual(results[0].projectId, warm.projectId);
});

test("without an activation key (older client) each call still creates a project, as before", { skip }, async () => {
  const user = await newUser("legacy");
  await signIn(user.email);
  const a = await saveProjectOnboarding(SPANISH_PAYLOAD(), "a");
  const b = await saveProjectOnboarding(SPANISH_PAYLOAD(), "b");
  assert.equal(a.status, "success");
  assert.notEqual(a.projectId, b.projectId);
});

// ─── Failure injected in the database ────────────────────────────────────────

test("brief generation fails: activation still succeeds (briefStatus generation_failed); the retry generates it, nothing duplicated", { skip: skipFaults }, async () => {
  psql(`
    create or replace function public._brain_fail_brief() returns trigger language plpgsql as $$
    begin
      if exists (select 1 from public.projects p where p.id = new.project_id and p.name like 'FAIL_BRIEF%') then
        raise exception 'injected brief failure';
      end if;
      return new;
    end $$;
    drop trigger if exists _brain_fail_brief on public.operational_governance_briefs;
    create trigger _brain_fail_brief before insert or update on public.operational_governance_briefs for each row execute function public._brain_fail_brief();
  `);
  try {
    const user = await newUser("brief-fail");
    await signIn(user.email);
    const activationRequestId = key();
    const failing = SPANISH_PAYLOAD();
    failing.identity.projectName = "FAIL_BRIEF Lanzamiento de listalaboda.com";
    const first = await saveProjectOnboarding(failing, "cid-1", { activationRequestId });
    assert.equal(first.status, "success");
    assert.equal(first.briefStatus, "generation_failed");
    const marker = (await projectRow(first.projectId)).onboarding_payload.brainActivation;
    assert.ok(marker.setupContextCompletedAt && !marker.briefCompletedAt);
    const before = await footprint({ userId: user.id, projectId: first.projectId });
    assert.equal(before.briefs, 0);

    // The user fixes the name (fault no longer matches) and retries with the same key.
    const second = await saveProjectOnboarding(SPANISH_PAYLOAD(), "cid-2", { activationRequestId });
    assert.equal(second.projectId, first.projectId);
    assert.equal(second.briefStatus, "generated");
    const after = await footprint({ userId: user.id, projectId: first.projectId });
    assert.deepEqual({ ...after, briefs: 0 }, before, "no second project, no second setup-context ingestion");
    assert.equal(after.briefs, 1);
  } finally {
    psql(`drop trigger if exists _brain_fail_brief on public.operational_governance_briefs; drop function if exists public._brain_fail_brief();`);
  }
});

test("project insert fails in the database: recoverable failure, nothing created, the retry succeeds once", { skip: skipFaults }, async () => {
  psql(`
    create or replace function public._brain_fail_insert() returns trigger language plpgsql as $$
    begin
      if new.name like 'FAIL_INSERT%' then raise exception 'injected insert failure'; end if;
      return new;
    end $$;
    drop trigger if exists _brain_fail_insert on public.projects;
    create trigger _brain_fail_insert before insert on public.projects for each row execute function public._brain_fail_insert();
  `);
  try {
    const user = await newUser("insert-fail");
    await signIn(user.email);
    const activationRequestId = key();
    const failing = SPANISH_PAYLOAD();
    failing.identity.projectName = "FAIL_INSERT Lanzamiento";
    const first = await saveProjectOnboarding(failing, "cid-1", { activationRequestId });
    assert.equal(first.status, "recoverable_failure");
    assert.equal(first.failureClass, "db_insert_error");
    assert.equal((await footprint({ userId: user.id })).projects, 0);
    const second = await saveProjectOnboarding(SPANISH_PAYLOAD(), "cid-2", { activationRequestId });
    assert.equal(second.status, "success");
    assert.equal((await footprint({ userId: user.id })).projects, 1);
  } finally {
    psql(`drop trigger if exists _brain_fail_insert on public.projects; drop function if exists public._brain_fail_insert();`);
  }
});

// ─── Authorization and entitlement unchanged ─────────────────────────────────

test("a workspace the user is not a member of is refused; nothing is created", { skip }, async () => {
  const user = await newUser("outsider");
  const stranger = await newUser("stranger");
  const { workspaceId } = await foreignWorkspace(stranger, "owner");
  await signIn(user.email);
  const result = await saveProjectOnboarding(SPANISH_PAYLOAD(), "cid", { workspaceId, activationRequestId: key() });
  assert.equal(result.status, "fatal_failure");
  assert.equal(result.failureClass, "target_workspace_not_writable");
  assert.equal((await footprint({ userId: user.id })).projects, 0);
});

test("another user's activation key cannot resume or touch their project", { skip }, async () => {
  const victim = await newUser("victim");
  await signIn(victim.email);
  const activationRequestId = key();
  const victimProject = await saveProjectOnboarding(SPANISH_PAYLOAD(), "v", { activationRequestId });
  const attacker = await newUser("attacker");
  await signIn(attacker.email);
  const edited = SPANISH_PAYLOAD();
  edited.identity.projectName = "secuestrado";
  const result = await saveProjectOnboarding(edited, "a", { activationRequestId });
  assert.equal(result.status, "success");
  assert.notEqual(result.projectId, victimProject.projectId, "keys are scoped to the caller");
  assert.equal((await projectRow(victimProject.projectId)).name, "Lanzamiento de listalaboda.com");
});

test("Free plan limit still applies to NEW projects, but never blocks resuming one already counted", { skip }, async () => {
  const user = await newUser("limit");
  await signIn(user.email);
  const keys = [key(), key(), key()];
  for (const k of keys) assert.equal((await saveProjectOnboarding(SPANISH_PAYLOAD(), k, { activationRequestId: k })).status, "success");
  const fourth = await saveProjectOnboarding(SPANISH_PAYLOAD(), "4", { activationRequestId: key() });
  assert.equal(fourth.failureClass, "upgrade_required");
  const resumeThird = await saveProjectOnboarding(SPANISH_PAYLOAD(), "3b", { activationRequestId: keys[2] });
  assert.equal(resumeThird.status, "success");
  assert.equal((await footprint({ userId: user.id })).projects, 3);
});
