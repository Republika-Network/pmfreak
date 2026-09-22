/**
 * P2-19 live verification — Governed Ratification, Revocation and Learning Review, against a
 * disposable local stack.
 *
 * Every Learning Candidate here is built from REAL, LIVE P2-18 lineages through the product's
 * own routes and RPCs (live capture → Evidence → Finding/Recommendation → Decision → Material
 * Action → Frontera-authorised dispatch → execution → Outcome → LIVE Observation → P2-18
 * candidate). The P2-19 path is then exercised through its routes (which evaluate the real
 * in-process governance runtime) and its RPCs directly, asserting the database-side
 * guarantees: owner/admin authority, stale-review protection, current-support, one terminal
 * review per exact Candidate state, ratify/reject races, idempotency, atomic events,
 * revocation, retrieval exclusions, explicit validity, tenancy/IDOR, the direct-DML boundary
 * and that the generic Material Action knowledge_elevation class stays denied.
 *
 * Requires: OPERATIONAL_FLOW_TEST_SUPABASE_URL, OPERATIONAL_FLOW_TEST_ANON_KEY,
 * OPERATIONAL_FLOW_TEST_SERVICE_ROLE_KEY, OPERATIONAL_FLOW_TEST_BASE_URL (exactly
 * http://localhost:3000, serving the SAME stack), OPERATIONAL_FLOW_TEST_DATABASE_URL (loopback;
 * `psql` on PATH for the owner-level guard, fixture and privilege checks),
 * OPERATIONAL_FLOW_TEST_ALLOW_DESTRUCTIVE=true and AOC_ENTERPRISE_KERNEL_AUTHORITY_SQLITE_PATH
 * (the disposable Frontera store the app reads). Loopback targets only. Nothing is deleted
 * afterwards; every run uses fresh tenants.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { createVerifierFronteraOperator, requireDisposableFronteraStore } from "./frontera-verifier-authority.mjs";
import type {
  CanonicalLearningCandidateReviewRow,
  CanonicalLearningCandidateRow,
  CanonicalProjectKnowledgeRecordRow,
} from "../src/lib/db/database-contract";
import type { ProjectKnowledgeView } from "../src/lib/project-knowledge/types";

type ApiBody = {
  normalizedEvent?: { id: string };
  evidence?: { id: string; fixture_state: string };
  chain?: Array<{ signal?: { id: string } }>;
  decision?: { id: string };
  proposal?: { id: string; proposal_digest: string };
  evaluation?: { governance_state: string };
  task?: { id: string };
  executionTask?: { id: string };
  disposition?: string;
  candidateId?: string;
  failureClass?: string | null;
  error?: string;
  currentVersion?: number;
  review?: { id: string; outcome: string; reviewerIsCandidateCreator: boolean };
  knowledge?: ProjectKnowledgeView | ProjectKnowledgeView[] | null;
  history?: { records: ProjectKnowledgeView[]; reviews: Array<{ id: string; outcome: string }> };
  canGovern?: boolean;
  eventId?: string | null;
};
type RpcBody = {
  disposition: string;
  review?: CanonicalLearningCandidateReviewRow;
  knowledge?: CanonicalProjectKnowledgeRecordRow | null;
  eventId?: string;
  reason?: string;
  currentVersion?: number;
};
type Scope = { workspaceId: string; projectId: string };

const supabaseUrl = process.env.OPERATIONAL_FLOW_TEST_SUPABASE_URL ?? "";
const anonKey = process.env.OPERATIONAL_FLOW_TEST_ANON_KEY ?? "";
const serviceRoleKey = process.env.OPERATIONAL_FLOW_TEST_SERVICE_ROLE_KEY ?? "";
const appBaseUrl = process.env.OPERATIONAL_FLOW_TEST_BASE_URL?.replace(/\/$/, "") ?? "";
const databaseUrl = process.env.OPERATIONAL_FLOW_TEST_DATABASE_URL ?? "";

if (!supabaseUrl || !anonKey || !serviceRoleKey || !appBaseUrl || !databaseUrl || process.env.OPERATIONAL_FLOW_TEST_ALLOW_DESTRUCTIVE !== "true") {
  console.error("P2-19 live verification requires the disposable local stack (OPERATIONAL_FLOW_TEST_* incl. DATABASE_URL, and OPERATIONAL_FLOW_TEST_ALLOW_DESTRUCTIVE=true).");
  process.exit(2);
}
for (const [name, target] of [["Supabase API", supabaseUrl], ["PMFreak", appBaseUrl], ["Postgres", databaseUrl]] as const) {
  const host = new URL(target).hostname;
  if (!["localhost", "127.0.0.1", "[::1]"].includes(host)) {
    console.error(`SAFETY ABORT: ${name} must use a literal loopback host.`);
    process.exit(2);
  }
}
if (appBaseUrl !== "http://localhost:3000") {
  console.error("SAFETY ABORT: the app origin must be http://localhost:3000.");
  process.exit(2);
}

const frontera = createVerifierFronteraOperator({ storePath: requireDisposableFronteraStore("P2-19"), operatorActorId: "operator-p2-19-verifier" });
const admin = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } });
const makeClient = () => createClient(supabaseUrl, anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
const anon = makeClient();

const suffix = `${Date.now()}-${randomUUID().slice(0, 8)}`;
const password = `P2-19-${randomUUID()}!`;
let assertions = 0;
const check = (condition: unknown, message: string) => { assert.ok(condition, message); assertions += 1; };
const equal = (actual: unknown, expected: unknown, message: string) => { assert.deepEqual(actual, expected, message); assertions += 1; };
const must = <T,>(result: { data: T; error: { message: string } | null }, label: string): T => { assert.ifError(result.error ? new Error(`${label}: ${result.error.message}`) : null); return result.data; };
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Owner-level SQL through `psql` (loopback only). Returns stdout, or the error text. */
function sql(statement: string): { ok: boolean; out: string } {
  try {
    const out = execFileSync("psql", ["-v", "ON_ERROR_STOP=1", databaseUrl, "-At", "-c", statement], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return { ok: true, out: out.trim() };
  } catch (error) {
    const e = error as { stderr?: string; message?: string };
    return { ok: false, out: `${e.stderr ?? ""}${e.message ?? ""}` };
  }
}

type User = { id: string; email: string; client: SupabaseClient; cookie?: string };

async function createUser(label: string): Promise<User> {
  const email = `p2-19-${label}-${suffix}@example.test`;
  const created = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  assert.ifError(created.error);
  const client = makeClient();
  assert.ifError((await client.auth.signInWithPassword({ email, password })).error);
  return { id: created.data.user!.id, email, client };
}

async function authCookie(user: User) {
  const form = new FormData();
  form.set("email", user.email);
  form.set("password", password);
  form.set("next", "/projects");
  const response = await fetch(`${appBaseUrl}/api/login`, { method: "POST", body: form, redirect: "manual" });
  const values = typeof response.headers.getSetCookie === "function" ? response.headers.getSetCookie() : [response.headers.get("set-cookie") ?? ""].filter(Boolean);
  check(values.length > 0, `${user.email} logs in`);
  user.cookie = values.map((v) => v.split(";", 1)[0]).join("; ");
}

async function http(user: User | null, method: "GET" | "POST", route: string, body?: unknown) {
  const response = await fetch(`${appBaseUrl}${route}`, {
    method,
    headers: { "content-type": "application/json", ...(user?.cookie ? { cookie: user.cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(90_000),
  });
  return { status: response.status, body: (await response.json().catch(() => ({}))) as ApiBody };
}

const flow = (user: User, t: Scope, data: Record<string, unknown>) => http(user, "POST", "/api/operational-flow", { workspaceId: t.workspaceId, projectId: t.projectId, ...data });

async function seedWorkspace(owner: User, label: string): Promise<string> {
  const workspaceId = randomUUID();
  must(await admin.from("workspaces").insert({ id: workspaceId, name: `P2-19 ${label} ${suffix}`, created_by_user_id: owner.id }), "workspace");
  must(await admin.from("workspace_memberships").insert({ workspace_id: workspaceId, user_id: owner.id, role: "owner" }), "membership");
  return workspaceId;
}

async function seedProject(owner: User, workspaceId: string, label: string): Promise<Scope> {
  const projectId = randomUUID();
  must(await admin.from("projects").insert({ id: projectId, workspace_id: workspaceId, user_id: owner.id, name: `P2-19 ${label} ${suffix}` }), "project");
  return { workspaceId, projectId };
}

const provisioned = new Set<string>();

/** One REAL, LIVE canonical lineage ending in an Observation of `observationState`. */
async function buildLiveLineage(owner: User, t: Scope, key: string, observationState: "achieved" | "partial" | "failed", options: { observationValiditySeconds?: number } = {}) {
  const now = new Date().toISOString();
  const captured = await flow(owner, t, {
    operation: "capture_live_input", idempotencyKey: `p2-19-capture:${key}`, title: `P2-19 live decision context ${key}`,
    content: "A decision is needed before proceeding with this governed project change.", occurredAt: now, correlationId: randomUUID(),
  });
  equal(captured.status, 201, `${key}: LIVE input captured`);
  const derived = await flow(owner, t, {
    operation: "derive_evidence", normalizedEventId: captured.body.normalizedEvent!.id, idempotencyKey: `p2-19-evidence:${key}`,
    assertionType: "FACT", classification: "DECISION_CONTEXT", confidenceScore: 0.95, missingDataState: "COMPLETE", evaluatedAt: now,
  });
  equal(derived.status, 201, `${key}: LIVE Evidence derived`);
  const chain = await flow(owner, t, { operation: "run_chain", evidenceItemId: derived.body.evidence!.id });
  equal(chain.status, 200, `${key}: governed chain materialised`);
  const signalId = chain.body.chain?.[0]?.signal?.id ?? "";
  check(Boolean(signalId), `${key}: Finding exists`);
  const recommendation = must(await admin.from("recommended_actions").select("id").eq("project_id", t.projectId).eq("source_signal_id", signalId).not("governance_event_id", "is", null).single(), "recommendation") as { id: string };
  const decision = await flow(owner, t, {
    operation: "record_decision", recommendationId: recommendation.id, decisionStatus: "accepted",
    decision: `Accepted P2-19 decision ${key}`, rationale: "P2-19 disposable local verification.",
  });
  equal(decision.status, 201, `${key}: Decision recorded`);
  const proposed = await flow(owner, t, {
    operation: "propose_material_action", decisionId: decision.body.decision!.id, idempotencyKey: `p2-19-action:${key}`,
    actionClass: "external_write", actionType: "schedule_change_proposal", targetResourceType: "project_schedule", targetResourceId: t.projectId,
    intendedOperation: "propose_only", intendedEffect: "Apply the governed change and later observe its expected result.",
    risk: "high", reversibility: "partially_reversible", sideEffect: "external", justification: "P2-19 disposable local verification.",
    createdAt: now, evaluationTime: now, expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  });
  equal(proposed.status, 201, `${key}: Material Action proposed`);
  if (!provisioned.has(t.projectId)) {
    await frontera.provision({ workspaceId: t.workspaceId, principalUserId: owner.id, projectId: t.projectId });
    provisioned.add(t.projectId);
  }
  const dispatched = await flow(owner, t, {
    operation: "dispatch_material_action_to_task", actionId: proposed.body.proposal!.id, expectedProposalDigest: proposed.body.proposal!.proposal_digest,
  });
  equal(dispatched.status, 201, `${key}: governed Task dispatched`);
  const task = (dispatched.body.task ?? dispatched.body.executionTask)!;
  for (const command of ["queue", "start", "complete"]) {
    const step = await http(owner, "POST", "/api/execution-tasks/internal-execution", { taskId: task.id, command });
    check([200, 201].includes(step.status), `${key}: execution ${command}`);
  }
  const outcome = must(await owner.client.rpc("ensure_expected_task_outcome", {
    p_workspace_id: t.workspaceId, p_project_id: t.projectId, p_task_id: task.id,
    p_expected_result: "The governed change produces the expected project result.",
    p_success_criteria: [{ criterion: "Evidence shows the expected result occurred." }],
    p_correlation_id: `p2-19-outcome-${key}`, p_causation_id: task.id,
  }), `${key}: outcome`) as { outcome: { id: string } };
  const observationId = await observe(owner, t, outcome.outcome.id, `${key}-1`, observationState, options.observationValiditySeconds);
  return { outcomeId: outcome.outcome.id, observationId, decisionId: decision.body.decision!.id };
}

async function observe(owner: User, t: Scope, outcomeId: string, key: string, state: string, validitySeconds?: number) {
  const now = new Date().toISOString();
  const staleAt = new Date(Date.now() + (validitySeconds ?? 7 * 86_400) * 1000).toISOString();
  const captured = must(await owner.client.rpc("capture_live_operational_input", {
    p_workspace_id: t.workspaceId, p_project_id: t.projectId, p_source_key: "p2-19-live-observation:v1",
    p_idempotency_key: `p2-19-obs-intake:${key}`, p_title: `P2-19 observation telemetry ${key}`,
    p_content: "External telemetry explicitly reports the governed change's operational result.", p_occurred_at: now,
    p_correlation_id: randomUUID(), p_causation_id: null, p_external_id: null,
  }), `${key}: observation intake`) as { normalizedEvent: { id: string } };
  const evidence = must(await owner.client.rpc("derive_operational_evidence", {
    p_workspace_id: t.workspaceId, p_project_id: t.projectId, p_normalized_event_id: captured.normalizedEvent.id,
    p_idempotency_key: `p2-19-obs-evidence:${key}`, p_assertion_type: "FACT", p_classification: "DELIVERY",
    p_confidence_score: 0.97, p_missing_data_state: "COMPLETE", p_evaluated_at: now, p_stale_at: validitySeconds ? staleAt : null,
  }), `${key}: observation evidence`) as { evidence: { id: string } };
  const observed = must(await owner.client.rpc("record_canonical_outcome_observation", {
    p_workspace_id: t.workspaceId, p_project_id: t.projectId, p_outcome_id: outcomeId, p_observation_state: state,
    p_summary: `P2-19 ${state} observation ${key}`, p_evidence_reference_ids: [evidence.evidence.id], p_confidence_score: 0.9,
    p_missing_data_state: "COMPLETE", p_observed_at: now, p_evaluated_at: now, p_stale_at: staleAt,
    p_correlation_id: randomUUID(), p_causation_id: outcomeId, p_idempotency_key: `p2-19-observation:${key}`,
  }), `${key}: observation`) as { observation: { id: string } };
  return observed.observation.id;
}

/** A P2-18 candidate from one live lineage, proposed through the P2-18 route by `proposer`. */
async function proposeCandidate(proposer: User, t: Scope, lineage: { outcomeId: string }) {
  const created = await http(proposer, "POST", "/api/learning-candidates", { workspaceId: t.workspaceId, projectId: t.projectId, outcomeId: lineage.outcomeId });
  check([200, 201].includes(created.status), `P2-18 candidate proposed — ${JSON.stringify(created.body)}`);
  return readCandidate(created.body.candidateId!);
}

const readCandidate = async (id: string) => must(await admin.from("canonical_learning_candidates").select("*").eq("id", id).single(), "candidate") as CanonicalLearningCandidateRow;

const count = async (table: string, filter: Record<string, unknown>) => {
  let q = admin.from(table).select("id", { count: "exact", head: true });
  for (const [k, v] of Object.entries(filter)) q = q.eq(k, v as string);
  const { count: n, error } = await q;
  assert.ifError(error);
  return n ?? 0;
};
const reviewsOf = (candidateId: string) => count("canonical_learning_candidate_reviews", { candidate_id: candidateId });
const knowledgeOf = (candidateId: string) => count("canonical_project_knowledge_records", { candidate_id: candidateId });
const learningEvents = (eventType: string, projectId: string) => count("platform_events", { event_type: eventType, project_id: projectId });

/** The ALLOW reference the application layer attests after the in-process runtime allows. */
const allow = (action: "knowledge.ratify" | "knowledge.reject" | "knowledge.revoke") => ({
  action, decision: "allow", decisionId: `p2-19-checker-${randomUUID()}`, evaluatedAt: new Date().toISOString(), contract: "pmfreak.aoc-e.in-process-governance.v1",
});

const ratifyRpc = (user: User | SupabaseClient, t: Scope, c: { id: string; version: number; evidence_digest: string }, extra: Partial<{ mode: string | null; until: string | null; rationale: string; governance: unknown }> = {}) =>
  ("client" in user ? user.client : user).rpc("ratify_canonical_learning_candidate", {
    p_workspace_id: t.workspaceId, p_project_id: t.projectId, p_candidate_id: c.id, p_candidate_version: c.version,
    p_candidate_evidence_digest: c.evidence_digest, p_rationale: extra.rationale ?? "Pattern holds for this project.",
    p_validity_mode: extra.mode === undefined ? "until_revoked" : extra.mode, p_effective_until: extra.until ?? null,
    p_governance: extra.governance === undefined ? allow("knowledge.ratify") : extra.governance,
  });

const rejectRpc = (user: User, t: Scope, c: { id: string; version: number; evidence_digest: string }, rationale = "Not a useful pattern.") =>
  user.client.rpc("reject_canonical_learning_candidate", {
    p_workspace_id: t.workspaceId, p_project_id: t.projectId, p_candidate_id: c.id, p_candidate_version: c.version,
    p_candidate_evidence_digest: c.evidence_digest, p_rationale: rationale, p_governance: allow("knowledge.reject"),
  });

const revokeRpc = (user: User, t: Scope, knowledgeId: string, reason = "No longer holds.") =>
  user.client.rpc("revoke_canonical_project_knowledge", {
    p_workspace_id: t.workspaceId, p_project_id: t.projectId, p_knowledge_id: knowledgeId, p_reason: reason, p_governance: allow("knowledge.revoke"),
  });

const reviewBody = (t: Scope, c: { id: string; version: number; evidence_digest: string }, decision: "ratify" | "reject", extra: Record<string, unknown> = {}) => ({
  workspaceId: t.workspaceId, projectId: t.projectId, candidateId: c.id, candidateVersion: c.version, candidateEvidenceDigest: c.evidence_digest,
  decision, rationale: decision === "ratify" ? "Repeated outcomes in this project support keeping this pattern." : "Not a pattern this project should keep.",
  ...(decision === "ratify" ? { validityMode: "until_revoked", effectiveUntil: null } : {}), ...extra,
});

const retrieve = async (user: User, t: Scope) => must(await user.client.rpc("retrieve_project_knowledge", { p_workspace_id: t.workspaceId, p_project_id: t.projectId }), "retrieve") as CanonicalProjectKnowledgeRecordRow[];

// ── Tenants and actors ─────────────────────────────────────────────────────────────────
const owner = await createUser("owner");
const adminUser = await createUser("admin");
const pm = await createUser("pm");
const viewer = await createUser("viewer");
const outsider = await createUser("outsider");
const wsA = await seedWorkspace(owner, "A");
for (const [user, role] of [[adminUser, "admin"], [pm, "pm"], [viewer, "viewer"]] as const) {
  must(await admin.from("workspace_memberships").insert({ workspace_id: wsA, user_id: user.id, role }), `${role} membership`);
}
const a1 = await seedProject(owner, wsA, "A1");
const a2 = await seedProject(owner, wsA, "A2");
const a3 = await seedProject(owner, wsA, "A3");
const a4 = await seedProject(owner, wsA, "A4");
const a5 = await seedProject(owner, wsA, "A5");
const wsB = await seedWorkspace(outsider, "B");
const b1 = await seedProject(outsider, wsB, "B1");
for (const user of [owner, adminUser, pm, viewer, outsider]) await authCookie(user);

// ── 1. A real P2-18 candidate, then a newer version from more live evidence ─────────────
const lineage1 = await buildLiveLineage(owner, a1, `a1-${suffix}`, "achieved");
const c1v1 = await proposeCandidate(owner, a1, lineage1);
equal([c1v1.status, c1v1.version, c1v1.causality_claim], ["proposed", 1, "correlation_only"], "a proposed, correlation-only P2-18 candidate v1");

// ── 2. Authority: PM/viewer/outsider/anonymous are refused; nothing is written ─────────
const pmRoute = await http(pm, "POST", "/api/learning-candidates/review", reviewBody(a1, c1v1, "ratify"));
equal([pmRoute.status, pmRoute.body.disposition], [403, "governance_denied"], "PM cannot ratify (knowledge.ratify DENY from the in-process runtime)");
const pmReject = await http(pm, "POST", "/api/learning-candidates/review", reviewBody(a1, c1v1, "reject"));
equal([pmReject.status, pmReject.body.disposition], [403, "governance_denied"], "PM cannot reject");
const viewerRoute = await http(viewer, "POST", "/api/learning-candidates/review", reviewBody(a1, c1v1, "ratify"));
equal(viewerRoute.status, 403, "viewer cannot ratify");
equal((await http(outsider, "POST", "/api/learning-candidates/review", reviewBody(a1, c1v1, "ratify"))).status, 403, "another tenant cannot ratify tenant A's candidate");
equal((await http(null, "POST", "/api/learning-candidates/review", reviewBody(a1, c1v1, "ratify"))).status, 401, "anonymous cannot ratify");
// IDOR: tenant A's candidate named under tenant B's own scope.
const idor = await http(outsider, "POST", "/api/learning-candidates/review", reviewBody(b1, c1v1, "ratify"));
equal(idor.status, 404, "IDOR: A's candidate under B's scope is not found");
// A candidate named under another Project of the same Workspace is not found either.
equal((await http(owner, "POST", "/api/learning-candidates/review", reviewBody(a2, c1v1, "ratify"))).status, 404, "a candidate is bound to its own project");
// Direct RPC: the database re-derives manage_workspace (owner/admin) whatever the caller attests.
check(/project_knowledge_authority_denied/.test((await ratifyRpc(pm, a1, c1v1)).error?.message ?? ""), "PM with a forged ALLOW reference is refused by the database");
check(/project_knowledge_authority_denied/.test((await ratifyRpc(viewer, a1, c1v1)).error?.message ?? ""), "viewer with a forged ALLOW reference is refused by the database");
check(/project_knowledge_scope_denied/.test((await ratifyRpc(outsider, a1, c1v1)).error?.message ?? ""), "outsider is refused by the database");
check(/project_knowledge_candidate_not_found/.test((await ratifyRpc(outsider, b1, c1v1)).error?.message ?? ""), "IDOR at the database: A's candidate under B's scope");
check(/unauthenticated/.test((await ratifyRpc(admin, a1, c1v1)).error?.message ?? ""), "service_role has no actor and cannot ratify");
check(/unauthenticated|permission denied/.test((await ratifyRpc(anon, a1, c1v1)).error?.message ?? ""), "anon cannot ratify");
check(/governance_projection_mismatch/.test((await ratifyRpc(owner, a1, c1v1, { governance: allow("knowledge.reject") })).error?.message ?? ""), "an ALLOW for another action is refused");
check(/governance_projection_mismatch/.test((await ratifyRpc(owner, a1, c1v1, { governance: { ...allow("knowledge.ratify"), decision: "deny" } })).error?.message ?? ""), "a DENY decision is refused");
check(/governance_projection_mismatch/.test((await ratifyRpc(owner, a1, c1v1, { governance: { ...allow("knowledge.ratify"), decision: "require_admin_approval" } })).error?.message ?? ""), "an approval-routed decision is not success");
check(/governance_projection_mismatch/.test((await ratifyRpc(owner, a1, c1v1, { governance: null })).error?.message ?? ""), "no governance reference is refused");
// Validation: explicit validity, a reason, and no backdating.
check(/project_knowledge_validity_invalid/.test((await ratifyRpc(owner, a1, c1v1, { mode: null })).error?.message ?? ""), "no validity choice is refused (no default)");
check(/project_knowledge_validity_invalid/.test((await ratifyRpc(owner, a1, c1v1, { mode: "until_revoked", until: new Date(Date.now() + 86_400_000).toISOString() })).error?.message ?? ""), "until_revoked with an expiry is refused");
check(/project_knowledge_validity_invalid/.test((await ratifyRpc(owner, a1, c1v1, { mode: "until_date", until: null })).error?.message ?? ""), "until_date without a date is refused");
check(/project_knowledge_validity_invalid/.test((await ratifyRpc(owner, a1, c1v1, { mode: "until_date", until: new Date(Date.now() - 60_000).toISOString() })).error?.message ?? ""), "a past expiry is refused (database clock)");
check(/project_knowledge_validity_invalid/.test((await ratifyRpc(owner, a1, c1v1, { mode: "forever" })).error?.message ?? ""), "no invented validity mode");
check(/project_knowledge_rationale_required/.test((await ratifyRpc(owner, a1, c1v1, { rationale: "   " })).error?.message ?? ""), "a blank reason is refused");
equal((await http(owner, "POST", "/api/learning-candidates/review", reviewBody(a1, c1v1, "ratify", { validityMode: undefined }))).status, 400, "the route requires an explicit validity choice");
equal((await http(owner, "POST", "/api/learning-candidates/review", reviewBody(a1, c1v1, "ratify", { rationale: "" }))).status, 400, "the route requires a reason");
equal([await reviewsOf(c1v1.id), await knowledgeOf(c1v1.id)], [0, 0], "no refusal wrote a review or knowledge");

// REVOKED authority: an admin downgraded to PM loses knowledge.ratify immediately.
must(await admin.from("workspace_memberships").update({ role: "pm" }).eq("workspace_id", wsA).eq("user_id", adminUser.id), "downgrade admin");
const downgraded = await http(adminUser, "POST", "/api/learning-candidates/review", reviewBody(a1, c1v1, "ratify"));
equal([downgraded.status, downgraded.body.disposition], [403, "governance_denied"], "a revoked/downgraded admin is denied at once");
must(await admin.from("workspace_memberships").update({ role: "admin" }).eq("workspace_id", wsA).eq("user_id", adminUser.id), "restore admin");
equal(await reviewsOf(c1v1.id), 0, "the revoked-authority attempt wrote nothing");

// ── 3. Stale review: a reviewer opened v1; new live evidence makes v2 ───────────────────
const lineage2 = await buildLiveLineage(owner, a1, `a1b-${suffix}`, "achieved");
const linked = await http(owner, "POST", "/api/learning-candidates", { workspaceId: a1.workspaceId, projectId: a1.projectId, outcomeId: lineage2.outcomeId });
equal(linked.body.disposition, "evidence_linked", "a second live lineage is linked to the same hypothesis");
const c1v2 = await readCandidate(c1v1.id);
check(c1v2.version === 2 && c1v2.evidence_digest !== c1v1.evidence_digest, "the candidate is now v2 with a new digest");
const eventsBeforeStale = await learningEvents("CANONICAL_LEARNING_CANDIDATE_RATIFIED_V1", a1.projectId);
const stale = await http(owner, "POST", "/api/learning-candidates/review", reviewBody(a1, c1v1, "ratify"));
equal([stale.status, stale.body.disposition, stale.body.currentVersion], [409, "stale_review", 2], "finalising the v1 review is a stale_review");
const staleReject = must(await rejectRpc(owner, a1, c1v1), "stale reject") as RpcBody;
equal(staleReject.disposition, "stale_review", "a stale rejection is refused at the database too");
equal([await reviewsOf(c1v1.id), await knowledgeOf(c1v1.id), await learningEvents("CANONICAL_LEARNING_CANDIDATE_RATIFIED_V1", a1.projectId)], [0, 0, eventsBeforeStale], "stale review: no terminal review, no knowledge, no event");

// ── 4. Owner ratifies the current v2 (scenario A) ────────────────────────────────────────
const ratified = await http(owner, "POST", "/api/learning-candidates/review", reviewBody(a1, c1v2, "ratify"));
equal([ratified.status, ratified.body.disposition], [201, "ratified"], `owner ratifies v2 — ${JSON.stringify(ratified.body).slice(0, 300)}`);
const k1 = must(await admin.from("canonical_project_knowledge_records").select("*").eq("candidate_id", c1v1.id).single(), "k1") as CanonicalProjectKnowledgeRecordRow;
const r1 = must(await admin.from("canonical_learning_candidate_reviews").select("*").eq("id", k1.review_id).single(), "r1") as CanonicalLearningCandidateReviewRow;
equal([k1.workspace_id, k1.project_id, k1.candidate_version, k1.candidate_evidence_digest], [a1.workspaceId, a1.projectId, 2, c1v2.evidence_digest], "knowledge binds the exact reviewed Candidate state and its scope");
equal([k1.applicability_scope, k1.status, k1.validity_mode, k1.effective_until, k1.version], ["source_project", "active", "until_revoked", null, 1], "applicability fixed to the source project; until_revoked has no expiry");
equal([k1.causality_claim, k1.confidence_method, k1.evidence_tier, k1.lineage_count], ["correlation_only", "weakest_linked_observation:v1", c1v2.evidence_tier, c1v2.lineage_count], "correlation_only survives ratification; confidence method and tier copied");
check(!k1.limitations.includes("not_ratified") && k1.limitations.includes("applies_to_source_project_only") && k1.limitations.includes("ratification_is_not_causal_evidence") && k1.limitations.includes("correlation_only"), "knowledge limitations: candidate limitations kept, pre-ratification statement replaced");
check(/does not establish causation/.test(k1.statement) && k1.statement.length <= 2000, "a bounded statement that states correlation only");
equal(k1.source_ids.length, 2, "provenance: the two current source ids at ratification");
equal([k1.ratified_by, r1.reviewed_by, r1.reviewer_role, r1.review_outcome, r1.governance_action, r1.governance_decision_state], [owner.id, owner.id, "owner", "ratified", "knowledge.ratify", "allow"], "attributable ratifier, role and ALLOW decision");
check(r1.governance_decision_id.length > 0 && !r1.governance_decision_id.startsWith("p2-19-checker"), "the route recorded the in-process runtime's own decision id");
equal([r1.candidate_created_by, r1.reviewer_is_candidate_creator], [owner.id, true], "reviewer = creator is allowed and stays visible");
equal((await readCandidate(c1v1.id)).status, "proposed", "the Candidate is never mutated into knowledge (status stays proposed)");
equal((await readCandidate(c1v1.id)).version, 2, "ratification does not version the Candidate");
const ratEvents = must(await admin.from("platform_events").select("*").eq("raw_reference_table", "canonical_project_knowledge_records").eq("raw_reference_id", k1.id), "events") as Array<{ event_type: string; learning_eligible: boolean; actor_id: string; event_payload: Record<string, unknown> & { actors: Record<string, unknown>; governance: Record<string, unknown> } }>;
equal(ratEvents.length, 1, "exactly one ratification event");
equal([ratEvents[0].event_type, ratEvents[0].learning_eligible, ratEvents[0].actor_id], ["CANONICAL_LEARNING_CANDIDATE_RATIFIED_V1", false, owner.id], "event type, not learning-eligible, actor");
equal([ratEvents[0].event_payload.actors.candidateCreatedBy, ratEvents[0].event_payload.actors.ratifiedBy, ratEvents[0].event_payload.actors.reviewerIsCandidateCreator], [owner.id, owner.id, true], "event lineage keeps every actor identity");
equal([ratEvents[0].event_payload.crossWorkspace, ratEvents[0].event_payload.elevationInferred, ratEvents[0].event_payload.causalityClaim], [false, false, "correlation_only"], "event: no cross-workspace, no elevation, correlation only");

// Retrieval at the data layer: RLS-scoped, active only.
equal((await retrieve(owner, a1)).map((k) => k.id), [k1.id], "authoritative retrieval returns the ratified knowledge");
equal((await retrieve(pm, a1)).map((k) => k.id), [k1.id], "a PM can read project knowledge");
equal((await retrieve(outsider, a1)).length, 0, "another tenant retrieves nothing (RLS)");
equal((await retrieve(owner, a2)).length, 0, "another project's retrieval does not include it");
const outsiderRead = await outsider.client.from("canonical_project_knowledge_records").select("id").eq("workspace_id", wsA);
equal([outsiderRead.error, (outsiderRead.data ?? []).length], [null, 0], "cross-tenant table read returns nothing");
const pmGet = await http(pm, "GET", `/api/project-knowledge?workspaceId=${a1.workspaceId}&projectId=${a1.projectId}`);
equal([pmGet.status, pmGet.body.canGovern, (pmGet.body.knowledge as ProjectKnowledgeView[]).map((k) => k.id)], [200, false, [k1.id]], "PM reads knowledge; no governing controls");
equal((await http(outsider, "GET", `/api/project-knowledge?workspaceId=${a1.workspaceId}&projectId=${a1.projectId}`)).status, 403, "another tenant cannot read project knowledge");

// Idempotent retry and no flip.
const replay = await http(owner, "POST", "/api/learning-candidates/review", reviewBody(a1, c1v2, "ratify"));
equal([replay.status, replay.body.disposition], [200, "duplicate"], "the same ratification replays");
const flip = await http(owner, "POST", "/api/learning-candidates/review", reviewBody(a1, c1v2, "reject"));
equal([flip.status, flip.body.disposition], [409, "already_finalized"], "a ratified version can never be rejected");
equal([await reviewsOf(c1v1.id), await knowledgeOf(c1v1.id), ratEvents.length], [1, 1, 1], "retry and flip wrote nothing");
equal(await learningEvents("CANONICAL_LEARNING_CANDIDATE_RATIFIED_V1", a1.projectId), 1, "still exactly one ratification event");

// ── 5. N concurrent first ratifications → exactly one commits (admin, scenario B) ──────
const lineage3 = await buildLiveLineage(owner, a2, `a2-${suffix}`, "achieved");
const c2 = await proposeCandidate(pm, a2, lineage3);
const burst = await Promise.all(Array.from({ length: 8 }, () => ratifyRpc(adminUser, a2, c2)));
const burstDispositions = burst.map((r) => (r.data as RpcBody | null)?.disposition ?? r.error?.message).sort();
equal(burstDispositions, ["duplicate", "duplicate", "duplicate", "duplicate", "duplicate", "duplicate", "duplicate", "ratified"], "8 concurrent ratifications: one ratified, seven duplicates");
equal([await reviewsOf(c2.id), await knowledgeOf(c2.id), await learningEvents("CANONICAL_LEARNING_CANDIDATE_RATIFIED_V1", a2.projectId)], [1, 1, 1], "one review, one knowledge record, one event");
const r2 = must(await admin.from("canonical_learning_candidate_reviews").select("*").eq("candidate_id", c2.id).single(), "r2") as CanonicalLearningCandidateReviewRow;
equal([r2.reviewer_role, r2.candidate_created_by, r2.reviewer_is_candidate_creator], ["admin", pm.id, false], "admin ratified a PM-created candidate; both identities recorded");
const k2 = must(await admin.from("canonical_project_knowledge_records").select("*").eq("candidate_id", c2.id).single(), "k2") as CanonicalProjectKnowledgeRecordRow;

// ── 6. Ratify vs reject race → exactly one terminal result ─────────────────────────────
const lineage4 = await buildLiveLineage(owner, a3, `a3-${suffix}`, "achieved");
const c3 = await proposeCandidate(owner, a3, lineage4);
const race = await Promise.all(Array.from({ length: 8 }, (_, i) => (i % 2 === 0 ? ratifyRpc(owner, a3, c3) : rejectRpc(adminUser, a3, c3))));
const raceDispositions = race.map((r) => (r.data as RpcBody | null)?.disposition ?? r.error?.message);
const winners = raceDispositions.filter((d) => d === "ratified" || d === "rejected");
equal(winners.length, 1, `ratify/reject race has one winner — ${JSON.stringify(raceDispositions)}`);
check(raceDispositions.every((d) => ["ratified", "rejected", "duplicate", "already_finalized"].includes(String(d))), "every loser is duplicate or already_finalized");
equal(await reviewsOf(c3.id), 1, "exactly one terminal review for the exact state");
equal(await knowledgeOf(c3.id), winners[0] === "ratified" ? 1 : 0, "knowledge exists only if ratification won");

// ── 7. Rejection by admin (scenario D), then a new version may be reviewed ─────────────
const lineage5 = await buildLiveLineage(owner, a4, `a4-${suffix}`, "achieved");
const c4v1 = await proposeCandidate(pm, a4, lineage5);
const rejected = await http(adminUser, "POST", "/api/learning-candidates/review", reviewBody(a4, c4v1, "reject"));
equal([rejected.status, rejected.body.disposition, rejected.body.review?.reviewerIsCandidateCreator], [201, "rejected", false], "admin rejects the exact version");
equal([await reviewsOf(c4v1.id), await knowledgeOf(c4v1.id)], [1, 0], "rejection creates no knowledge");
equal(await learningEvents("CANONICAL_LEARNING_CANDIDATE_REJECTED_V1", a4.projectId), 1, "one rejection event");
const rejectRetry = await http(adminUser, "POST", "/api/learning-candidates/review", reviewBody(a4, c4v1, "reject"));
equal([rejectRetry.status, rejectRetry.body.disposition], [200, "duplicate"], "the same rejection replays");
const ratifyRejected = await http(owner, "POST", "/api/learning-candidates/review", reviewBody(a4, c4v1, "ratify"));
equal([ratifyRejected.status, ratifyRejected.body.disposition], [409, "already_finalized"], "a rejected version can never be ratified");
equal([await reviewsOf(c4v1.id), await knowledgeOf(c4v1.id), await learningEvents("CANONICAL_LEARNING_CANDIDATE_REJECTED_V1", a4.projectId)], [1, 0, 1], "retries wrote nothing");
equal((await retrieve(owner, a4)).length, 0, "retrieval excludes a rejected candidate");
const lineage6 = await buildLiveLineage(owner, a4, `a4b-${suffix}`, "achieved");
equal((await http(owner, "POST", "/api/learning-candidates", { workspaceId: a4.workspaceId, projectId: a4.projectId, outcomeId: lineage6.outcomeId })).body.disposition, "evidence_linked", "new live evidence is linked to the rejected candidate");
const c4v2 = await readCandidate(c4v1.id);
equal(c4v2.version, 2, "new evidence makes v2");

// ── 8. Explicit until_date validity: retrievable before the date, excluded after ────────
const expiresAt = new Date(Date.now() + 25_000).toISOString();
const dated = await http(owner, "POST", "/api/learning-candidates/review", reviewBody(a4, c4v2, "ratify", { validityMode: "until_date", effectiveUntil: expiresAt }));
equal([dated.status, dated.body.disposition], [201, "ratified"], "v2 of a previously rejected candidate can be ratified");
const k4 = must(await admin.from("canonical_project_knowledge_records").select("*").eq("candidate_id", c4v1.id).single(), "k4") as CanonicalProjectKnowledgeRecordRow;
equal([k4.validity_mode, new Date(k4.effective_until ?? "").toISOString()], ["until_date", expiresAt], "the explicit expiry is stored as chosen");
equal(await reviewsOf(c4v1.id), 2, "the earlier rejection remains as history beside the new ratification");
equal((await retrieve(owner, a4)).map((k) => k.id), [k4.id], "retrievable before its date");
await sleep(Math.max(0, new Date(expiresAt).getTime() - Date.now()) + 2_000);
equal((await retrieve(owner, a4)).length, 0, "excluded from retrieval after its date (database clock)");
const afterExpiry = await http(owner, "GET", `/api/project-knowledge?workspaceId=${a4.workspaceId}&projectId=${a4.projectId}`);
equal((afterExpiry.body.history?.records ?? []).find((r) => r.id === k4.id)?.effectiveState, "expired", "history labels it expired; status is still active (derived, not persisted)");
equal((must(await admin.from("canonical_project_knowledge_records").select("status").eq("id", k4.id).single(), "k4 status") as { status: string }).status, "active", "no expiry transition is persisted");

// ── 9. Not supported: a candidate whose only source has lapsed cannot be ratified ──────
const lineage7 = await buildLiveLineage(owner, a5, `a5-${suffix}`, "achieved", { observationValiditySeconds: 20 });
const c5 = await proposeCandidate(owner, a5, lineage7);
const lapse = must(await admin.from("canonical_outcome_observations").select("stale_at").eq("id", lineage7.observationId).single(), "lapse") as { stale_at: string };
await sleep(Math.max(0, new Date(lapse.stale_at).getTime() - Date.now()) + 2_000);
const unsupported = await http(owner, "POST", "/api/learning-candidates/review", reviewBody(a5, c5, "ratify"));
equal([unsupported.status, unsupported.body.disposition], [409, "not_supported"], "the route refuses an unsupported candidate");
const unsupportedRpc = must(await ratifyRpc(owner, a5, c5), "unsupported rpc") as RpcBody;
equal([unsupportedRpc.disposition, unsupportedRpc.reason], ["not_supported", "no_current_sources"], "the database refuses it too, whatever the stored summary says");
equal([await reviewsOf(c5.id), await knowledgeOf(c5.id)], [0, 0], "nothing written for an unsupported candidate");

// ── 10. Revocation (scenario F) ─────────────────────────────────────────────────────────
equal((await http(pm, "POST", "/api/project-knowledge/revoke", { workspaceId: a1.workspaceId, projectId: a1.projectId, knowledgeId: k1.id, reason: "PM attempt" })).status, 403, "PM cannot revoke");
check(/project_knowledge_authority_denied/.test((await revokeRpc(pm, a1, k1.id)).error?.message ?? ""), "PM cannot revoke at the database");
equal((await http(outsider, "POST", "/api/project-knowledge/revoke", { workspaceId: b1.workspaceId, projectId: b1.projectId, knowledgeId: k1.id, reason: "IDOR" })).status, 404, "IDOR: A's knowledge under B's scope is not found");
equal((await http(owner, "POST", "/api/project-knowledge/revoke", { workspaceId: a1.workspaceId, projectId: a1.projectId, knowledgeId: k1.id, reason: " " })).status, 400, "a revocation needs a reason");
const revoked = await http(owner, "POST", "/api/project-knowledge/revoke", { workspaceId: a1.workspaceId, projectId: a1.projectId, knowledgeId: k1.id, reason: "Superseded by later outcomes in this project." });
equal([revoked.status, revoked.body.disposition], [200, "revoked"], "owner revokes");
equal((await retrieve(owner, a1)).length, 0, "revoked knowledge disappears from authoritative retrieval immediately");
const k1After = must(await admin.from("canonical_project_knowledge_records").select("*").eq("id", k1.id).single(), "k1 after") as CanonicalProjectKnowledgeRecordRow;
equal([k1After.status, k1After.revoked_by, k1After.version, k1After.revocation_reason], ["revoked", owner.id, 2, "Superseded by later outcomes in this project."], "revocation is recorded and attributable");
check(Boolean(k1After.revocation_governance_decision_id) && Boolean(k1After.revoked_at), "revocation keeps its governance decision reference");
const LIFECYCLE = ["status", "version", "updated_at", "revoked_at", "revoked_by", "revocation_reason", "revocation_governance_decision_id", "revocation_governance_evaluated_at"];
const withoutLifecycle = (row: CanonicalProjectKnowledgeRecordRow) => Object.fromEntries(Object.entries(row).filter(([key]) => !LIFECYCLE.includes(key)));
const k1Content = withoutLifecycle(k1After);
const k1Original = withoutLifecycle(k1);
equal(k1Content, k1Original, "the ratified content and provenance are unchanged by revocation");
const history = await http(owner, "GET", `/api/project-knowledge?workspaceId=${a1.workspaceId}&projectId=${a1.projectId}`);
equal((history.body.history?.records ?? []).find((r) => r.id === k1.id)?.effectiveState, "revoked", "history keeps the revoked record, labelled");
equal(await learningEvents("CANONICAL_PROJECT_KNOWLEDGE_REVOKED_V1", a1.projectId), 1, "one revocation event");
const revokeRetry = await http(owner, "POST", "/api/project-knowledge/revoke", { workspaceId: a1.workspaceId, projectId: a1.projectId, knowledgeId: k1.id, reason: "again" });
equal([revokeRetry.status, revokeRetry.body.disposition], [200, "already_revoked"], "a repeated revocation is already_revoked");
equal(await learningEvents("CANONICAL_PROJECT_KNOWLEDGE_REVOKED_V1", a1.projectId), 1, "no second revocation event");
const reratify = await http(owner, "POST", "/api/learning-candidates/review", reviewBody(a1, c1v2, "ratify"));
equal([reratify.status, reratify.body.disposition], [200, "duplicate"], "re-submitting the ratified state replays; it never reactivates");
equal([await knowledgeOf(c1v1.id), (await retrieve(owner, a1)).length], [1, 0], "no reactivation: still one (revoked) record and nothing retrievable");
// Concurrent revocations → one revoked, the rest already_revoked, one event.
const revokeBurst = await Promise.all(Array.from({ length: 6 }, () => revokeRpc(adminUser, a2, k2.id)));
equal(revokeBurst.map((r) => (r.data as RpcBody | null)?.disposition ?? r.error?.message).sort(), ["already_revoked", "already_revoked", "already_revoked", "already_revoked", "already_revoked", "revoked"], "concurrent revocations: exactly one revokes");
equal(await learningEvents("CANONICAL_PROJECT_KNOWLEDGE_REVOKED_V1", a2.projectId), 1, "one event for the concurrent revocations");

// ── 11. Direct-DML boundary: no role writes these tables directly ─────────────────────
const PRIVILEGE_DENIED = /permission denied for table canonical_(learning_candidate_reviews|project_knowledge_records)/;
const k2BeforeDml = must(await admin.from("canonical_project_knowledge_records").select("*").eq("id", k2.id).single(), "k2 before") as CanonicalProjectKnowledgeRecordRow;
const r2BeforeDml = must(await admin.from("canonical_learning_candidate_reviews").select("*").eq("id", r2.id).single(), "r2 before") as CanonicalLearningCandidateReviewRow;
const forgedKnowledge = { ...k2, id: randomUUID(), review_id: r2.id, status: "active" };
const attempts = {
  serviceInsertKnowledge: await admin.from("canonical_project_knowledge_records").insert(forgedKnowledge),
  serviceReactivate: await admin.from("canonical_project_knowledge_records").update({ status: "active", revoked_at: null, revoked_by: null, revocation_reason: null, revocation_governance_decision_id: null, revocation_governance_evaluated_at: null, version: 3 }).eq("id", k2.id),
  serviceDeleteKnowledge: await admin.from("canonical_project_knowledge_records").delete().eq("id", k2.id),
  serviceInsertReview: await admin.from("canonical_learning_candidate_reviews").insert({ ...r2, id: randomUUID(), candidate_version: 99 }),
  serviceFlipReview: await admin.from("canonical_learning_candidate_reviews").update({ review_outcome: "rejected", governance_action: "knowledge.reject" }).eq("id", r2.id),
  serviceDeleteReview: await admin.from("canonical_learning_candidate_reviews").delete().eq("id", r2.id),
  ownerInsertKnowledge: await owner.client.from("canonical_project_knowledge_records").insert(forgedKnowledge),
  ownerUpdateKnowledge: await owner.client.from("canonical_project_knowledge_records").update({ statement: "forged" }).eq("id", k2.id),
  ownerInsertReview: await owner.client.from("canonical_learning_candidate_reviews").insert({ ...r2, id: randomUUID(), candidate_version: 98 }),
  anonInsertKnowledge: await anon.from("canonical_project_knowledge_records").insert(forgedKnowledge),
};
for (const [name, result] of Object.entries(attempts)) {
  check(PRIVILEGE_DENIED.test(result.error?.message ?? ""), `direct DML refused: ${name} — ${result.error?.message ?? "SUCCEEDED"}`);
}
equal(must(await admin.from("canonical_project_knowledge_records").select("*").eq("id", k2.id).single(), "k2 after"), k2BeforeDml, "the knowledge row is byte-for-byte unchanged by every direct DML attempt");
equal(must(await admin.from("canonical_learning_candidate_reviews").select("*").eq("id", r2.id).single(), "r2 after"), r2BeforeDml, "the review row is byte-for-byte unchanged by every direct DML attempt");
equal(await knowledgeOf(c2.id), 1, "no forged knowledge exists");

// ── 12. Owner-level guards, fixture exclusion and effective privileges (psql) ─────────
const guardReactivate = sql(`update public.canonical_project_knowledge_records set status='active', revoked_at=null, revoked_by=null, revocation_reason=null, revocation_governance_decision_id=null, revocation_governance_evaluated_at=null, version=version+1 where id='${k1.id}'`);
check(!guardReactivate.ok && /project_knowledge_immutable/.test(guardReactivate.out), "even the table owner cannot reactivate revoked knowledge");
const guardEdit = sql(`update public.canonical_project_knowledge_records set statement='rewritten' where id='${k2.id}'`);
check(!guardEdit.ok && /project_knowledge_immutable/.test(guardEdit.out), "even the table owner cannot edit knowledge content");
const guardReview = sql(`update public.canonical_learning_candidate_reviews set review_outcome='rejected', governance_action='knowledge.reject' where id='${r2.id}'`);
check(!guardReview.ok && /project_knowledge_immutable/.test(guardReview.out), "even the table owner cannot flip a terminal review");
const guardDelete = sql(`delete from public.canonical_learning_candidate_reviews where id='${r1.id}'`);
check(!guardDelete.ok && /project_knowledge_immutable/.test(guardDelete.out), "reviews cannot be deleted");
// A DEMO / FIXTURE record (owner-level insert; no product path can create one) is never retrieved.
const c5Row = await readCandidate(c5.id);
const fixtureReviewId = randomUUID();
const fixtureKnowledgeId = randomUUID();
const fixtureInsert = sql(`
  insert into public.canonical_learning_candidate_reviews (id, workspace_id, project_id, candidate_id, candidate_version, candidate_evidence_digest, review_outcome, reviewed_by, reviewer_role, reviewed_at, candidate_created_by, candidate_last_evaluated_by, reviewer_is_candidate_creator, reviewed_summary, causality_claim, limitations, rationale, governance_action, governance_decision_id, governance_decision_state, governance_contract, governance_evaluated_at, fixture_label)
  values ('${fixtureReviewId}', '${a5.workspaceId}', '${a5.projectId}', '${c5Row.id}', ${c5Row.version}, '${c5Row.evidence_digest}', 'ratified', '${owner.id}', 'owner', now(), '${owner.id}', '${owner.id}', true, '{}'::jsonb, 'correlation_only', array['correlation_only'], 'DEMO / FIXTURE — expires when the Expansion gate becomes VERIFIED', 'knowledge.ratify', 'fixture', 'allow', 'pmfreak.aoc-e.in-process-governance.v1', now(), 'DEMO / FIXTURE');
  insert into public.canonical_project_knowledge_records (id, workspace_id, project_id, candidate_id, candidate_version, candidate_evidence_digest, review_id, knowledge_kind, pattern_key, pattern_signature, statement, evidence_tier, lineage_count, independent_lineage_count, result_counts, confidence_score, confidence_method, causality_claim, limitations, source_ids, applicability_scope, status, validity_mode, effective_from, ratified_at, ratified_by, ratification_governance_decision_id, version, fixture_label)
  select '${fixtureKnowledgeId}', workspace_id, project_id, id, version, evidence_digest, '${fixtureReviewId}', candidate_kind, pattern_key, pattern_signature, 'DEMO / FIXTURE knowledge', evidence_tier, lineage_count, independent_lineage_count, result_counts, confidence_score, confidence_method, causality_claim, limitations, array[gen_random_uuid()], 'source_project', 'active', 'until_revoked', now(), now(), '${owner.id}', 'fixture', 1, 'DEMO / FIXTURE'
  from public.canonical_learning_candidates where id = '${c5Row.id}';`);
check(fixtureInsert.ok, `fixture rows inserted at owner level — ${fixtureInsert.out}`);
equal((await retrieve(owner, a5)).length, 0, "a DEMO / FIXTURE record is excluded from authoritative retrieval");
const fixtureHistory = await http(owner, "GET", `/api/project-knowledge?workspaceId=${a5.workspaceId}&projectId=${a5.projectId}`);
equal([(fixtureHistory.body.knowledge as ProjectKnowledgeView[]).length, (fixtureHistory.body.history?.records ?? []).find((r) => r.id === fixtureKnowledgeId)?.fixture], [0, true], "the route never returns a fixture as knowledge; history labels it");

const privileges = sql(`select string_agg(r || ':' || t || ':' || p || '=' || has_table_privilege(r, 'public.' || t, p)::text, ' ' order by r, t, p)
  from unnest(array['anon','authenticated','service_role']) r, unnest(array['canonical_learning_candidate_reviews','canonical_project_knowledge_records']) t,
       unnest(array['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) p`);
check(privileges.ok, "effective table privileges readable");
for (const entry of privileges.out.split(" ")) {
  const [key, value] = entry.split("=");
  const [role, , privilege] = key.split(":");
  const expected = privilege === "SELECT" && role !== "anon";
  equal(value === "true", expected, `effective privilege ${key}`);
}
const fnPrivileges = sql(`select string_agg(r || ':' || f || '=' || has_function_privilege(r, f, 'EXECUTE')::text, ' ' order by r, f)
  from unnest(array['anon','authenticated','service_role']) r,
       unnest(array['public.ratify_canonical_learning_candidate(uuid,uuid,uuid,integer,text,text,text,timestamptz,jsonb)','public.reject_canonical_learning_candidate(uuid,uuid,uuid,integer,text,text,jsonb)','public.revoke_canonical_project_knowledge(uuid,uuid,uuid,text,jsonb)','public.canonical_learning_candidate_current_support(uuid,timestamptz)','public.canonical_project_knowledge_assert_authority(uuid,uuid,text,jsonb)','public.retrieve_project_knowledge(uuid,uuid)']) f`);
for (const entry of fnPrivileges.out.split(" ")) {
  const [key, value] = entry.split("=");
  const role = key.slice(0, key.indexOf(":"));
  const internal = /current_support|assert_authority/.test(key);
  equal(value === "true", !internal && role !== "anon", `effective EXECUTE ${key}`);
}

// ── 13. The generic knowledge_elevation Material Action stays hard-denied ──────────────
const elevation = await flow(owner, a1, {
  operation: "propose_material_action", decisionId: lineage1.decisionId, idempotencyKey: `p2-19-elevation:${suffix}`,
  actionClass: "knowledge_elevation", actionType: "prohibited_knowledge_elevation", targetResourceType: "project_schedule", targetResourceId: a1.projectId,
  intendedOperation: "propose_only", intendedEffect: "Attempt a generic knowledge elevation.", risk: "high", reversibility: "partially_reversible",
  sideEffect: "knowledge", justification: "P2-19 negative control.", createdAt: new Date().toISOString(), evaluationTime: new Date().toISOString(),
  expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
});
equal([elevation.status, elevation.body.evaluation?.governance_state], [201, "denied"], "generic knowledge_elevation is still DENIED (P2-06 guarantee unchanged)");
const elevationDispatch = await flow(owner, a1, { operation: "dispatch_material_action_to_task", actionId: elevation.body.proposal!.id, expectedProposalDigest: elevation.body.proposal!.proposal_digest });
check(elevationDispatch.status >= 400, "a denied knowledge_elevation action cannot be dispatched");

// ── 14. Nothing crossed a Workspace or became organizational knowledge ────────────────
const crossWorkspace = must(await admin.from("canonical_project_knowledge_records").select("id").eq("workspace_id", wsB), "ws B knowledge") as unknown[];
equal(crossWorkspace.length, 0, "tenant B has no knowledge (nothing crossed workspaces)");
equal(await count("organizational_patterns", { workspace_id: wsA }), 0, "no legacy organizational pattern was written");
const candidateStatuses = must(await admin.from("canonical_learning_candidates").select("status").eq("workspace_id", wsA), "statuses") as Array<{ status: string }>;
check(candidateStatuses.every((s) => s.status === "proposed"), "every Candidate is still proposed");

console.log(`P2-19 DB verification PASS (${assertions} assertions).`);
console.log(`KNOWLEDGE k1=${k1.id} (revoked) k2=${k2.id} (revoked) k4=${k4.id} (expired) race=${winners[0]} fixture=${fixtureKnowledgeId}`);
