import { getAuthUser } from "@/lib/auth";
import { isArchivedProjectStatus, projectArchivedResponse } from "@/lib/projects/archived-project";
import { AccessDeniedError, requireProjectPermission } from "@/aoc/runtime-consumer";
import { getCompanySubscription } from "@/lib/billing";
import {
  enrichWithPortfolioIntelligence,
  readProjectMemory,
  type StoredProjectAnalysis,
  writeProjectMemory,
} from "@/lib/project-memory";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { canCreateMoreProjects, canUseAdvancedAi, requireFeatureAccess } from "@/lib/feature-gates";
import { canUsePortfolioMemory } from "@/lib/usage-limits";
import { runInference } from "@/lib/ai/providers/router";
import { InferenceError } from "@/lib/ai/inference/types";
import { logger, safeErrorMessage } from "@/lib/observability/logger";

const ANALYSIS_SCHEMA: Record<string, unknown> = { type: "object", additionalProperties: false, properties: { executive_summary: { type: "string" }, functional_requirements: { type: "array", items: { type: "string" } }, non_functional_requirements: { type: "array", items: { type: "string" } }, risks: { type: "array", items: { type: "string" } }, dependencies: { type: "array", items: { type: "string" } }, ambiguities: { type: "array", items: { type: "string" } }, missing_information: { type: "array", items: { type: "string" } }, client_questions: { type: "array", items: { type: "string" } }, suggested_next_steps: { type: "array", items: { type: "string" } }, complexity: { type: "string", enum: ["Low", "Medium", "High"] } }, required: ["executive_summary", "functional_requirements", "non_functional_requirements", "risks", "dependencies", "ambiguities", "missing_information", "client_questions", "suggested_next_steps", "complexity"] };

type AnalyzeRequestPayload = { projectId?: string; projectName?: string; extractedScopeText?: string; sourceFileNames?: string[] };
type AIAnalysisResult = { executive_summary: string; functional_requirements: string[]; non_functional_requirements: string[]; risks: string[]; dependencies: string[]; ambiguities: string[]; missing_information: string[]; client_questions: string[]; suggested_next_steps: string[]; complexity: "Low" | "Medium" | "High" };
type AIAnalysisResponse = AIAnalysisResult & { similar_projects: string[]; historical_risks: string[]; estimated_relative_complexity: string };

const normalizeStringArray = (value: unknown) => Array.isArray(value) ? value.map((item) => (typeof item === "string" ? item.trim() : "")).filter((item) => item.length > 0).slice(0, 12) : [];
const coerceAnalysisResult = (value: unknown): AIAnalysisResult | null => {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<AIAnalysisResult>;
  const complexity = candidate.complexity === "Low" || candidate.complexity === "Medium" || candidate.complexity === "High" ? candidate.complexity : null;
  if (!complexity || typeof candidate.executive_summary !== "string") return null;
  return { executive_summary: candidate.executive_summary.trim(), functional_requirements: normalizeStringArray(candidate.functional_requirements), non_functional_requirements: normalizeStringArray(candidate.non_functional_requirements), risks: normalizeStringArray(candidate.risks), dependencies: normalizeStringArray(candidate.dependencies), ambiguities: normalizeStringArray(candidate.ambiguities), missing_information: normalizeStringArray(candidate.missing_information), client_questions: normalizeStringArray(candidate.client_questions), suggested_next_steps: normalizeStringArray(candidate.suggested_next_steps), complexity };
};

export async function POST(request: Request) {
  const user = await getAuthUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const advancedAiAccess = await canUseAdvancedAi(user.id);
  if (!advancedAiAccess.ok) {
    return Response.json(
      { error: advancedAiAccess.error, feature: advancedAiAccess.feature, requiredPlan: advancedAiAccess.requiredPlan },
      { status: 402 },
    );
  }

  const subscription = await getCompanySubscription(user.companyId);
  const analysisAccess = await requireFeatureAccess(user.companyId, "ai_analysis");
  if (!analysisAccess.ok) {
    return Response.json({ error: analysisAccess.code, feature: "ai_analysis", requiredPlan: analysisAccess.requiredPlan }, { status: analysisAccess.status });
  }

  let payload: AnalyzeRequestPayload = {};
  const contentType = request.headers.get("content-type") ?? "";
  try {
    if (contentType.includes("application/json")) payload = (await request.json()) as AnalyzeRequestPayload;
    else {
      const formData = await request.formData();
      payload = { projectId: String(formData.get("projectId") ?? ""), projectName: String(formData.get("projectName") ?? ""), extractedScopeText: String(formData.get("extractedScopeText") ?? "") };
    }
  } catch {
    return Response.json({ error: "Invalid request body." }, { status: 400 });
  }

  const projectId = payload.projectId?.trim() ?? "";
  const projectName = payload.projectName?.trim() ?? "";
  const extractedScopeText = payload.extractedScopeText?.trim() ?? "";
  const sourceFileNames = normalizeStringArray(payload.sourceFileNames);
  if (!projectId) return Response.json({ error: "projectId is required." }, { status: 400 });
  if (!projectName) return Response.json({ error: "Project name is required." }, { status: 400 });
  if (!extractedScopeText) return Response.json({ error: "Extracted scope text is required." }, { status: 400 });

  const supabase = await createSupabaseServerClient();
  let workspaceId = "";
  try {
    const access = await requireProjectPermission(projectId, "read") as { workspaceId: string };
    workspaceId = access.workspaceId;
  } catch (error) {
    if (error instanceof AccessDeniedError) return Response.json({ error: "Invalid project context." }, { status: 403 });
    throw error;
  }

  const { data: project } = await supabase.from("projects").select("id, status").eq("id", projectId).eq("workspace_id", workspaceId).maybeSingle();
  if (!project) return Response.json({ error: "Invalid project context." }, { status: 403 });
  // PD-25: an analysis is a new record on the project; an archived project takes none.
  if (isArchivedProjectStatus(project.status)) return projectArchivedResponse();

  const projectAccess = await canCreateMoreProjects(user.id);
  if (!projectAccess.ok) {
    return Response.json(
      { error: projectAccess.error, feature: projectAccess.feature, requiredPlan: projectAccess.requiredPlan },
      { status: 402 },
    );
  }

  const { count: analysisCount, error: analysisCountError } = await supabase
    .from("onboarding_analyses")
    .select("*", { count: "exact", head: true })
    .eq("user_id", user.id);
  if (analysisCountError) return Response.json({ error: "Unable to verify usage right now. Please retry shortly." }, { status: 500 });

  const currentUsageCount = analysisCount ?? 0;

  try {
    const inferenceResult = await runInference({
      moduleId: "scope-analysis",
      workspaceId,
      projectId,
      // B6: charges the per-user daily cost ceiling as well as the workspace's.
      actorId: user.id,
      messages: [
        { role: "system", content: "You are PMFreak AI. Return only valid JSON that matches the provided schema. Keep bullets practical and concise." },
        { role: "user", content: `Analyze this project scope and produce a complete structured assessment.\n\nProject Name: ${projectName}\n\nExtracted Scope Text:\n${extractedScopeText.slice(0, 16000)}` },
      ],
      responseFormat: {
        type: "json_schema",
        jsonSchema: { name: "pmfreak_ai_analysis", strict: true, schema: ANALYSIS_SCHEMA },
      },
      temperature: 0.2,
      timeoutMs: 30000,
      operationName: "scope-analysis",
      metadata: { actorUserId: user.id, companyId: user.companyId },
    });

    const analysis = coerceAnalysisResult(inferenceResult.parsedJson ?? (inferenceResult.content ? JSON.parse(inferenceResult.content) : null));
    if (!analysis) return Response.json({ error: "AI response could not be validated." }, { status: 502 });

    const portfolioEnabled = canUsePortfolioMemory(subscription.plan);
    const previousProjects = portfolioEnabled ? await readProjectMemory(user.companyId) : [];
    const recordBase: Omit<StoredProjectAnalysis, "similarProjects" | "historicalRisks" | "estimatedRelativeComplexity"> = { id: crypto.randomUUID(), projectName, uploadDate: new Date().toISOString(), executiveSummary: analysis.executive_summary, requirements: [...analysis.functional_requirements, ...analysis.non_functional_requirements], risks: analysis.risks, dependencies: analysis.dependencies, ambiguities: analysis.ambiguities, complexity: analysis.complexity, sourceFileNames };
    const intelligence = portfolioEnabled ? enrichWithPortfolioIntelligence(recordBase, previousProjects) : { similarProjects: [] as string[], historicalRisks: [] as string[], estimatedRelativeComplexity: "Portfolio memory is available on PMO plan." };
    if (portfolioEnabled) await writeProjectMemory(user.companyId, [{ ...recordBase, ...intelligence }, ...previousProjects]);

    const enrichedResponse: AIAnalysisResponse = { ...analysis, similar_projects: intelligence.similarProjects, historical_risks: intelligence.historicalRisks, estimated_relative_complexity: intelligence.estimatedRelativeComplexity };
    await supabase.from("onboarding_analyses").insert({ company_id: user.companyId, user_id: user.id, workspace_id: workspaceId, workspace: "project", role: user.role, project_type: "project_analysis", problem: projectName, analysis: JSON.stringify(enrichedResponse), source: "onboarding", project_id: projectId });
    return Response.json(enrichedResponse, { headers: { "X-Usage-Remaining": String(Math.max(0, projectAccess.projectLimit - (currentUsageCount + 1))) } });
  } catch (error) {
    if (error instanceof InferenceError) {
      // errorClass is app-controlled; error.message may embed upstream
      // provider/config details and stays server-side (F-07 sweep).
      logger.error("route_internal_error", { route: "/api/analyze-ai", error_code: error.errorClass, error_detail: safeErrorMessage(error) });
      const clientMessage = error.errorClass === "rate_limited"
        ? "AI analysis is rate-limited right now. Please retry in a few moments."
        : "AI analysis request failed. Please retry or use the fallback analysis.";
      return Response.json({ error: clientMessage }, { status: error.errorClass === "rate_limited" ? 429 : 502 });
    }
    return Response.json({ error: "Unable to run AI analysis right now. Please retry shortly." }, { status: 502 });
  }
}
