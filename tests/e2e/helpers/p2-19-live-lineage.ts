/**
 * P2-19 browser-scenario seeding: REAL, LIVE canonical lineages and P2-18 Learning Candidates,
 * created through the product's own routes and RPCs as the signed-in owner (the same chain
 * scripts/check-p2-19-db.mts builds). The service-role client only seeds tenants, projects,
 * memberships and the trial gate.
 */
import { createHash, randomUUID } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { createVerifierFronteraOperator, requireDisposableFronteraStore } from "../../../scripts/frontera-verifier-authority.mjs";

const supabaseUrl = process.env.OPERATIONAL_FLOW_TEST_SUPABASE_URL ?? "";
const anonKey = process.env.OPERATIONAL_FLOW_TEST_ANON_KEY ?? "";
const serviceRoleKey = process.env.OPERATIONAL_FLOW_TEST_SERVICE_ROLE_KEY ?? "";
const baseUrl = (process.env.OPERATIONAL_FLOW_TEST_BASE_URL ?? "http://localhost:3000").replace(/\/$/, "");

export const liveStackConfigured = Boolean(supabaseUrl && anonKey && serviceRoleKey && process.env.OPERATIONAL_FLOW_TEST_ALLOW_DESTRUCTIVE === "true");
export const serviceClient = createClient(supabaseUrl || "http://127.0.0.1:54321", serviceRoleKey || "missing", { auth: { persistSession: false, autoRefreshToken: false } });

export type Scope = { workspaceId: string; projectId: string };
export type ApiBody = {
  normalizedEvent?: { id: string };
  evidence?: { id: string };
  chain?: Array<{ signal?: { id: string } }>;
  decision?: { id: string };
  proposal?: { id: string; proposal_digest: string };
  evaluation?: { governance_state: string };
  task?: { id: string };
  executionTask?: { id: string };
  candidateId?: string;
  disposition?: string;
  [key: string]: unknown;
};
export type LiveUser = { id: string; email: string; password: string; client: SupabaseClient; cookie: string };

function must<T>(result: { data: T; error: { message: string } | null }, label: string): T {
  if (result.error) throw new Error(`${label}: ${result.error.message}`);
  return result.data;
}

export async function createLiveUser(label: string, suffix: string, password: string): Promise<LiveUser> {
  const email = `p2-19-e2e-${label}-${suffix}@example.test`;
  const created = await serviceClient.auth.admin.createUser({ email, password, email_confirm: true });
  if (created.error) throw new Error(created.error.message);
  const client = createClient(supabaseUrl, anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const signedIn = await client.auth.signInWithPassword({ email, password });
  if (signedIn.error) throw new Error(signedIn.error.message);
  const form = new FormData();
  form.set("email", email);
  form.set("password", password);
  form.set("next", "/projects");
  const response = await fetch(`${baseUrl}/api/login`, { method: "POST", body: form, redirect: "manual" });
  const values = typeof response.headers.getSetCookie === "function" ? response.headers.getSetCookie() : [];
  if (values.length === 0) throw new Error(`${email} could not log in`);
  return { id: created.data.user!.id, email, password, client, cookie: values.map((v) => v.split(";", 1)[0]).join("; ") };
}

/** A workspace with an active trial (the protected layout's gate) and the given members. */
export async function seedWorkspace(owner: LiveUser, members: Array<[LiveUser, string]>, label: string): Promise<string> {
  const workspaceId = randomUUID();
  must(await serviceClient.from("workspaces").insert({ id: workspaceId, name: `P2-19 ${label}`, created_by_user_id: owner.id }), "workspace");
  must(await serviceClient.from("workspace_memberships").insert([[owner, "owner"] as [LiveUser, string], ...members].map(([u, role]) => ({ workspace_id: workspaceId, user_id: u.id, role }))), "memberships");
  const inviteId = randomUUID();
  const trialEnd = new Date(Date.now() + 365 * 86_400_000).toISOString();
  must(await serviceClient.from("early_access_invites").insert({
    id: inviteId, invite_email: owner.email, invite_token_hash: createHash("sha256").update(`p2-19-consumed:${inviteId}`).digest("hex"),
    invite_note: "P2-19 browser scenario", inviter_user_id: owner.id, expires_at: trialEnd, accepted_at: new Date().toISOString(),
    requires_approval: false, workspace_id: workspaceId,
  }), "invite");
  must(await serviceClient.from("trial_licenses").insert({ id: randomUUID(), invite_id: inviteId, workspace_id: workspaceId, trial_start_at: new Date().toISOString(), trial_end_at: trialEnd, trial_status: "active" }), "trial");
  return workspaceId;
}

export async function seedProject(owner: LiveUser, workspaceId: string, name: string): Promise<Scope> {
  const projectId = randomUUID();
  // Past its guided first-run, so the Command Center opens on the attention canvas.
  must(await serviceClient.from("projects").insert({ id: projectId, workspace_id: workspaceId, user_id: owner.id, name, onboarding_payload: { initialIngestion: { status: "completed" } } }), "project");
  return { workspaceId, projectId };
}

async function http(user: LiveUser, method: "GET" | "POST", route: string, body?: unknown) {
  const response = await fetch(`${baseUrl}${route}`, {
    method, headers: { "content-type": "application/json", cookie: user.cookie },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(90_000),
  });
  return { status: response.status, body: (await response.json().catch(() => ({}))) as ApiBody };
}

let frontera: ReturnType<typeof createVerifierFronteraOperator> | null = null;
const provisioned = new Set<string>();

/** One REAL, LIVE lineage ending in an `achieved` Observation; returns its Outcome. */
export async function buildLiveLineage(owner: LiveUser, t: Scope, key: string): Promise<{ outcomeId: string; decisionId: string }> {
  frontera ??= createVerifierFronteraOperator({ storePath: requireDisposableFronteraStore("P2-19 browser"), operatorActorId: "operator-p2-19-browser" });
  const flow = async (data: Record<string, unknown>, expected: number) => {
    const r = await http(owner, "POST", "/api/operational-flow", { workspaceId: t.workspaceId, projectId: t.projectId, ...data });
    if (r.status !== expected) throw new Error(`${key}: ${String(data.operation)} → ${r.status} ${JSON.stringify(r.body).slice(0, 300)}`);
    return r.body;
  };
  const now = new Date().toISOString();
  const captured = await flow({ operation: "capture_live_input", idempotencyKey: `p2-19-e2e-capture:${key}`, title: `P2-19 decision context ${key}`, content: "A decision is needed before proceeding with this governed project change.", occurredAt: now, correlationId: randomUUID() }, 201);
  const derived = await flow({ operation: "derive_evidence", normalizedEventId: captured.normalizedEvent!.id, idempotencyKey: `p2-19-e2e-evidence:${key}`, assertionType: "FACT", classification: "DECISION_CONTEXT", confidenceScore: 0.95, missingDataState: "COMPLETE", evaluatedAt: now }, 201);
  const chain = await flow({ operation: "run_chain", evidenceItemId: derived.evidence!.id }, 200);
  const signalId = chain.chain?.[0]?.signal?.id ?? "";
  const recommendation = must(await serviceClient.from("recommended_actions").select("id").eq("project_id", t.projectId).eq("source_signal_id", signalId).not("governance_event_id", "is", null).single(), "recommendation") as { id: string };
  const decision = await flow({ operation: "record_decision", recommendationId: recommendation.id, decisionStatus: "accepted", decision: `Accepted ${key}`, rationale: "P2-19 browser scenario." }, 201);
  const proposed = await flow({
    operation: "propose_material_action", decisionId: decision.decision!.id, idempotencyKey: `p2-19-e2e-action:${key}`,
    actionClass: "external_write", actionType: "schedule_change_proposal", targetResourceType: "project_schedule", targetResourceId: t.projectId,
    intendedOperation: "propose_only", intendedEffect: "Apply the governed change and later observe its expected result.",
    risk: "high", reversibility: "partially_reversible", sideEffect: "external", justification: "P2-19 browser scenario.",
    createdAt: now, evaluationTime: now, expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  }, 201);
  if (!provisioned.has(t.projectId)) {
    await frontera.provision({ workspaceId: t.workspaceId, principalUserId: owner.id, projectId: t.projectId });
    provisioned.add(t.projectId);
  }
  const dispatched = await flow({ operation: "dispatch_material_action_to_task", actionId: proposed.proposal!.id, expectedProposalDigest: proposed.proposal!.proposal_digest }, 201);
  const task = (dispatched.task ?? dispatched.executionTask)!;
  for (const command of ["queue", "start", "complete"]) {
    const step = await http(owner, "POST", "/api/execution-tasks/internal-execution", { taskId: task.id, command });
    if (![200, 201].includes(step.status)) throw new Error(`${key}: execution ${command} → ${step.status}`);
  }
  const outcome = must(await owner.client.rpc("ensure_expected_task_outcome", {
    p_workspace_id: t.workspaceId, p_project_id: t.projectId, p_task_id: task.id,
    p_expected_result: "The governed change produces the expected project result.",
    p_success_criteria: [{ criterion: "Evidence shows the expected result occurred." }],
    p_correlation_id: `p2-19-e2e-outcome-${key}`, p_causation_id: task.id,
  }), `${key}: outcome`) as { outcome: { id: string } };
  const obsNow = new Date().toISOString();
  const intake = must(await owner.client.rpc("capture_live_operational_input", {
    p_workspace_id: t.workspaceId, p_project_id: t.projectId, p_source_key: "p2-19-e2e-observation:v1",
    p_idempotency_key: `p2-19-e2e-obs-intake:${key}`, p_title: `P2-19 observation ${key}`,
    p_content: "External telemetry explicitly reports the governed change's operational result.", p_occurred_at: obsNow,
    p_correlation_id: randomUUID(), p_causation_id: null, p_external_id: null,
  }), `${key}: observation intake`) as { normalizedEvent: { id: string } };
  const evidence = must(await owner.client.rpc("derive_operational_evidence", {
    p_workspace_id: t.workspaceId, p_project_id: t.projectId, p_normalized_event_id: intake.normalizedEvent.id,
    p_idempotency_key: `p2-19-e2e-obs-evidence:${key}`, p_assertion_type: "FACT", p_classification: "DELIVERY",
    p_confidence_score: 0.97, p_missing_data_state: "COMPLETE", p_evaluated_at: obsNow, p_stale_at: null,
  }), `${key}: observation evidence`) as { evidence: { id: string } };
  must(await owner.client.rpc("record_canonical_outcome_observation", {
    p_workspace_id: t.workspaceId, p_project_id: t.projectId, p_outcome_id: outcome.outcome.id, p_observation_state: "achieved",
    p_summary: `P2-19 achieved observation ${key}`, p_evidence_reference_ids: [evidence.evidence.id], p_confidence_score: 0.9,
    p_missing_data_state: "COMPLETE", p_observed_at: obsNow, p_evaluated_at: obsNow,
    p_stale_at: new Date(Date.now() + 7 * 86_400_000).toISOString(),
    p_correlation_id: randomUUID(), p_causation_id: outcome.outcome.id, p_idempotency_key: `p2-19-e2e-observation:${key}`,
  }), `${key}: observation`);
  return { outcomeId: outcome.outcome.id, decisionId: decision.decision!.id };
}

/** Links a live lineage to a P2-18 candidate through the P2-18 route; returns the candidate id. */
export async function proposeCandidate(proposer: LiveUser, t: Scope, outcomeId: string): Promise<string> {
  const created = await http(proposer, "POST", "/api/learning-candidates", { workspaceId: t.workspaceId, projectId: t.projectId, outcomeId });
  if (![200, 201].includes(created.status)) throw new Error(`candidate proposal → ${created.status} ${JSON.stringify(created.body)}`);
  return String(created.body.candidateId);
}

export const apiAs = http;
