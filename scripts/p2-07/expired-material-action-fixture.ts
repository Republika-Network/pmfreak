/**
 * TEST-SIDE SERVER FIXTURE for `check:p2-07-db`. NOT PRODUCT CODE, never
 * imported from `src/**`.
 *
 * Since P2-12 the HTTP proposal route no longer forwards `createdAt` /
 * `evaluationTime` / `expiresAt`: the server owns the governance window, so a
 * browser can no longer manufacture an expired Action (the verifier proves that
 * separately). `proposeGovernedMaterialAction` still lets a server-side caller
 * pin the window — that is the documented seam for tests and fixtures — and the
 * dispatch RPC still refuses any Action whose persisted `expires_at <= now()`.
 *
 * This fixture is the narrowest way to reach that seam. It calls the canonical
 * service as the REAL authenticated principal (its own session, its own RLS, its
 * own membership role — nothing is taken on trust from the caller), so the
 * proposal is built, digested and persisted by the product's own code through
 * `persist_governed_material_action`. There is no service-role write, no direct
 * insert, and no re-implementation of the proposal or its digest.
 *
 * It is deliberately limited to windows that are ALREADY EXPIRED: it can pin
 * time only into the past, so it cannot be used to extend an authorization.
 *
 * Protocol: one JSON request on stdin; one `P2_07_FIXTURE_RESULT <json>` line on
 * stdout. Credentials travel on stdin only and are never echoed.
 */
import { createClient } from "@supabase/supabase-js";
import {
  proposeGovernedMaterialAction,
  type ProposeMaterialActionInput,
} from "@/lib/operational-flow/operational-flow-service";

const FIXTURE_RESULT_PREFIX = "P2_07_FIXTURE_RESULT ";

type WindowKeys = "createdAt" | "evaluationTime" | "expiresAt";

type FixtureRequest = {
  supabaseUrl: string;
  anonKey: string;
  email: string;
  password: string;
  workspaceId: string;
  projectId: string;
  action: Omit<ProposeMaterialActionInput, WindowKeys>;
  window: Required<Pick<ProposeMaterialActionInput, WindowKeys>>;
};

function fail(message: string): never {
  console.error(`[p2-07 expired-action fixture] ${message}`);
  process.exit(1);
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

async function main() {
  let request: FixtureRequest;
  try {
    request = JSON.parse(await readStdin()) as FixtureRequest;
  } catch {
    fail("stdin must carry one JSON fixture request.");
  }

  let host: string;
  try {
    host = new URL(request.supabaseUrl).hostname;
  } catch {
    fail("invalid Supabase URL.");
  }
  if (!["localhost", "127.0.0.1", "[::1]"].includes(host)) {
    fail("SAFETY ABORT: Supabase must use a literal loopback host.");
  }

  const createdAt = Date.parse(request.window.createdAt);
  const evaluationTime = Date.parse(request.window.evaluationTime);
  const expiresAt = Date.parse(request.window.expiresAt);
  if ([createdAt, evaluationTime, expiresAt].some(Number.isNaN)) fail("window timestamps must be ISO-8601.");
  if (!(createdAt <= evaluationTime && evaluationTime < expiresAt)) fail("window must satisfy createdAt <= evaluationTime < expiresAt.");
  if (expiresAt >= Date.now()) fail("this fixture only pins windows that have ALREADY expired.");

  const client = createClient(request.supabaseUrl, request.anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const signedIn = await client.auth.signInWithPassword({ email: request.email, password: request.password });
  if (signedIn.error || !signedIn.data.user) fail("principal could not authenticate.");
  const userId = signedIn.data.user.id;

  // The role is read through the principal's own session, exactly as the route
  // resolves it — never accepted from the caller.
  const membership = await client
    .from("workspace_memberships")
    .select("role")
    .eq("workspace_id", request.workspaceId)
    .eq("user_id", userId)
    .maybeSingle();
  if (membership.error || !membership.data?.role) fail("principal has no membership in the workspace.");

  const result = await proposeGovernedMaterialAction(
    client,
    { workspaceId: request.workspaceId, projectId: request.projectId, userId, role: String(membership.data.role) },
    { ...request.action, ...request.window },
  );
  process.stdout.write(`${FIXTURE_RESULT_PREFIX}${JSON.stringify(result)}\n`);
}

main().catch((error: unknown) => fail(error instanceof Error ? error.message : String(error)));
