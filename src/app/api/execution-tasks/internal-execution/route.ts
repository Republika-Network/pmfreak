import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { requireAuthenticatedUser } from "@/lib/security/server-authorization";
import type {
  ExecutionTaskRow,
  InternalTaskExecutionRow,
} from "@/lib/db/database-contract";
import {
  isGovernedExecutionTask,
  isInternalExecutionCommand,
  queueInternalTaskExecution,
  transitionInternalTaskExecution,
} from "@/lib/execution-tasks/internal-execution-provider";
import { governedDenialBody } from "@/lib/operational-flow/governed-denial-contract";
import { logger, safeErrorMessage } from "@/lib/observability/logger";

const TASK_COLUMNS =
  "id,workspace_id,project_id,task_draft_id,recommended_action_id,raid_item_id,title,description,status,priority,owner_user_id,owner_name,start_date,due_date,completed_at,progress_percent,acceptance_criteria,checklist,confidence_score,source_payload,created_by,created_at,updated_at";

const ROUTE_ID = "/api/execution-tasks/internal-execution";
const WRITE_ROLES = new Set(["owner", "admin", "pm"]);

async function canAccessTaskProject(
  task: Pick<ExecutionTaskRow, "workspace_id" | "project_id">,
  userId: string,
  permission: "read" | "write",
): Promise<boolean> {
  const supabase = await createSupabaseServerClient();
  const [{ data: project, error: projectError }, { data: membership, error: membershipError }] =
    await Promise.all([
      supabase
        .from("projects")
        .select("id,workspace_id")
        .eq("id", task.project_id)
        .eq("workspace_id", task.workspace_id)
        .maybeSingle(),
      supabase
        .from("workspace_memberships")
        .select("role")
        .eq("workspace_id", task.workspace_id)
        .eq("user_id", userId)
        .maybeSingle(),
    ]);

  if (projectError || membershipError || !project || !membership?.role) {
    return false;
  }

  if (permission === "write" && !WRITE_ROLES.has(String(membership.role))) {
    return false;
  }

  return true;
}

async function loadTask(taskId: string) {
  const supabase = await createSupabaseServerClient();
  const { data: task, error } = await supabase
    .from("execution_tasks")
    .select(TASK_COLUMNS)
    .eq("id", taskId)
    .maybeSingle<ExecutionTaskRow>();
  return { supabase, task, error };
}

export async function GET(request: NextRequest) {
  let userId: string;
  try {
    const { user } = await requireAuthenticatedUser();
    userId = user.id;
  } catch {
    return NextResponse.json(
      { ok: false, error: "Unauthenticated.", failureClass: "unauthenticated" },
      { status: 401 },
    );
  }

  const taskId = request.nextUrl.searchParams.get("taskId")?.trim();
  if (!taskId) {
    return NextResponse.json(
      { ok: false, error: "taskId is required.", failureClass: "validation_failed" },
      { status: 400 },
    );
  }

  const { supabase, task, error } = await loadTask(taskId);
  if (error) {
    return NextResponse.json(
      { ok: false, error: "Unable to load task.", failureClass: "persistence_failed" },
      { status: 500 },
    );
  }
  if (!task) {
    return NextResponse.json(
      { ok: false, error: "Task not found.", failureClass: "not_found" },
      { status: 404 },
    );
  }

  if (!(await canAccessTaskProject(task, userId, "read"))) {
    return NextResponse.json(
      { ok: false, error: "Access denied.", failureClass: "unauthorized" },
      { status: 403 },
    );
  }

  if (!isGovernedExecutionTask(task)) {
    return NextResponse.json({ ok: true, task, execution: null });
  }

  const { data: execution, error: executionError } = await supabase
    .from("internal_task_executions")
    .select(
      "id,workspace_id,project_id,task_id,source_action_id,governance_evaluation_id,provider_key,status,attempt_count,idempotency_key,correlation_id,causation_id,failure_class,failure_message,queued_at,started_at,blocked_at,failed_at,completed_at,last_transition_at,dispatched_by,created_at,updated_at",
    )
    .eq("task_id", task.id)
    .maybeSingle<InternalTaskExecutionRow>();

  if (executionError) {
    return NextResponse.json(
      { ok: false, error: "Unable to load internal execution.", failureClass: "persistence_failed" },
      { status: 500 },
    );
  }

  return NextResponse.json({ ok: true, task, execution: execution ?? null });
}

export async function POST(request: NextRequest) {
  let userId: string;
  try {
    const { user } = await requireAuthenticatedUser();
    userId = user.id;
  } catch {
    return NextResponse.json(
      { ok: false, error: "Unauthenticated.", failureClass: "unauthenticated" },
      { status: 401 },
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { ok: false, error: "Invalid JSON.", failureClass: "validation_failed" },
      { status: 400 },
    );
  }

  const input = body as Record<string, unknown>;
  const taskId = typeof input.taskId === "string" ? input.taskId.trim() : "";
  const command = input.command;

  if (!taskId || !isInternalExecutionCommand(command)) {
    return NextResponse.json(
      { ok: false, error: "taskId and a valid command are required.", failureClass: "validation_failed" },
      { status: 400 },
    );
  }

  const { supabase, task, error } = await loadTask(taskId);
  if (error) {
    return NextResponse.json(
      { ok: false, error: "Unable to load task.", failureClass: "persistence_failed" },
      { status: 500 },
    );
  }
  if (!task) {
    return NextResponse.json(
      { ok: false, error: "Task not found.", failureClass: "not_found" },
      { status: 404 },
    );
  }

  if (!(await canAccessTaskProject(task, userId, "write"))) {
    return NextResponse.json(
      { ok: false, error: "Access denied.", failureClass: "unauthorized" },
      { status: 403 },
    );
  }

  if (!isGovernedExecutionTask(task)) {
    return NextResponse.json(
      {
        ok: false,
        error: "Internal execution requires a governed Action Task.",
        failureClass: "not_governed",
      },
      { status: 409 },
    );
  }

  try {
    const result =
      command === "queue"
        ? await queueInternalTaskExecution(supabase, task.id)
        : await transitionInternalTaskExecution(supabase, task.id, command);

    if (result.disposition === "denied" || result.disposition === "conflict") {
      // CHAT-GOV-01a. The P2-08 refusal keeps its 409 and its own fields, and gains the safe
      // `error` / `code` / `recovery` plus a reference id logged on this line.
      const referenceId = randomUUID();
      logger.warn("internal_execution_refused", {
        route: ROUTE_ID, reference_id: referenceId, task_id: task.id, command, user_id: userId,
        disposition: result.disposition, failure_class: result.failureClass, reason: result.reason,
      });
      return NextResponse.json({ ok: false, ...governedDenialBody(result, referenceId) }, { status: 409 });
    }

    const status = result.disposition === "queued" ? 201 : 200;
    return NextResponse.json({ ok: true, ...result }, { status });
  } catch (error) {
    const referenceId = randomUUID();
    logger.error("internal_execution.persistence_failed", {
      route: ROUTE_ID, reference_id: referenceId, task_id: task.id, command,
      error_detail: safeErrorMessage(error),
    });
    return NextResponse.json(
      { ok: false, error: "Unable to persist internal execution.", failureClass: "persistence_failed", referenceId },
      { status: 500 },
    );
  }
}