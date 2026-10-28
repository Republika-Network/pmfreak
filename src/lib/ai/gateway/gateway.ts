import { randomUUID } from "node:crypto";
import type { AIResponseEnvelope } from "@/lib/ai/types";
import { aiModuleRegistry } from "@/lib/ai/gateway/registry";
import type { AIModuleId, MemoryContext, RunAIModuleInput } from "@/lib/ai/gateway/types";
import { traceGatewayCall, traceGatewayError, measureAsync } from "@/lib/ai/gateway/tracer";
import { runInference } from "@/lib/ai/providers/router";
import { InferenceError } from "@/lib/ai/inference/types";
import { escalationGuidePromptPackV1 } from "@/lib/ai/prompts/escalation-guide.v1";
import { meetingsPromptPackV1 } from "@/lib/ai/prompts/meetings.v1";
import { messageNudgesPromptPackV1 } from "@/lib/ai/prompts/message-nudges.v1";
import { politicalRiskPromptPackV1 } from "@/lib/ai/prompts/political-risk.v1";
import { stakeholderIntelPromptPackV1 } from "@/lib/ai/prompts/stakeholder-intel.v1";
import type { MessageNudgesInputSchema, MessageNudgesOutputSchema } from "@/lib/ai/prompts/message-nudges.v1";
import { createSupabaseServerClient } from "@/lib/db/supabase-server";

type MessageNudgesContext = {
  projectMemory: string[];
  recentEvents: string[];
  stakeholderSignals: string[];
  derivedSignals: {
    toneTrend: "improving" | "worsening" | "stable" | "unknown";
    blamePattern: "increasing" | "decreasing" | "stable" | "spiky" | "unknown";
    riskTrend: "improving" | "worsening" | "stable" | "unknown";
    escalationSignal: "ready" | "watch" | "not-ready" | "unknown";
  };
};

type MessageAnalysisRow = {
  raw_message: string;
  created_at: string;
  decision: MessageNudgesDecision | null;
};

type MessageNudgesDecision = NonNullable<MessageNudgesOutputSchema["decision"]>;


const clampScore = (value: number) => Math.max(0, Math.min(1, value));

const scoreToneRisk = (message: string): number => {
  const lowered = message.toLowerCase();
  const hardTriggers = ["missed", "failed", "unacceptable", "why didn't", "you need to"];
  const softeners = ["we", "align", "please", "could", "let's"];
  const hardHits = hardTriggers.filter((phrase) => lowered.includes(phrase)).length;
  const softerHits = softeners.filter((phrase) => lowered.includes(phrase)).length;
  return clampScore(0.35 + hardHits * 0.14 - softerHits * 0.05);
};

const scoreBlame = (message: string): number => {
  const lowered = message.toLowerCase();
  const secondPersonCount = (lowered.match(/\byou\b/g) ?? []).length;
  const directBlamePhrases = ["your fault", "you missed", "you failed", "you caused"];
  const blameHits = directBlamePhrases.filter((phrase) => lowered.includes(phrase)).length;
  return clampScore(0.2 + secondPersonCount * 0.12 + blameHits * 0.25);
};

const scoreAmbiguity = (message: string): number => {
  const lowered = message.toLowerCase();
  const hasTimeAnchor = /\b(today|tomorrow|eod|by\s+\w+day|\d{1,2}[:/]\d{1,2})\b/.test(lowered);
  const hasConcreteAsk = /\b(please|need|request|confirm|share|send|align)\b/.test(lowered);
  const hasOutcome = /\b(plan|timeline|owner|decision|next step|update)\b/.test(lowered);
  const ambiguityBase = 0.72;
  const reductions = (hasTimeAnchor ? 0.2 : 0) + (hasConcreteAsk ? 0.18 : 0) + (hasOutcome ? 0.18 : 0);
  return clampScore(ambiguityBase - reductions);
};

const toLevel = (score: number): "low" | "medium" | "high" => {
  if (score >= 0.7) {
    return "high";
  }
  if (score >= 0.4) {
    return "medium";
  }
  return "low";
};

const avg = (items: number[]) => (items.length ? items.reduce((sum, item) => sum + item, 0) / items.length : null);

const getTrend = (first: number[], second: number[]): "improving" | "worsening" | "stable" | "unknown" => {
  const a = avg(first);
  const b = avg(second);
  if (a === null || b === null) {
    return "unknown";
  }
  const delta = b - a;
  if (delta <= -0.08) {
    return "improving";
  }
  if (delta >= 0.08) {
    return "worsening";
  }
  return "stable";
};

const deriveSignals = (events: MessageAnalysisRow[]) => {
  if (events.length < 2) {
    return {
      toneTrend: "unknown",
      blamePattern: "unknown",
      riskTrend: "unknown",
      escalationSignal: "unknown",
    } as const;
  }

  const newestFirst = events.slice(0, 10);
  const oldestFirst = [...newestFirst].reverse();
  const midpoint = Math.max(1, Math.floor(oldestFirst.length / 2));
  const older = oldestFirst.slice(0, midpoint);
  const newer = oldestFirst.slice(midpoint);

  const olderTone = older.map((event) => event.decision?.risk?.tone ?? scoreToneRisk(event.raw_message));
  const newerTone = newer.map((event) => event.decision?.risk?.tone ?? scoreToneRisk(event.raw_message));
  const olderBlame = older.map((event) => event.decision?.risk?.blame ?? scoreBlame(event.raw_message));
  const newerBlame = newer.map((event) => event.decision?.risk?.blame ?? scoreBlame(event.raw_message));
  const olderAmbiguity = older.map((event) => event.decision?.risk?.ambiguity ?? scoreAmbiguity(event.raw_message));
  const newerAmbiguity = newer.map((event) => event.decision?.risk?.ambiguity ?? scoreAmbiguity(event.raw_message));
  const olderOverall = older.map((event) => event.decision?.risk?.overall ?? 0);
  const newerOverall = newer.map((event) => event.decision?.risk?.overall ?? 0);

  const toneTrend = getTrend(olderTone, newerTone);
  const blameTrend = getTrend(olderBlame, newerBlame);
  const ambiguityTrend = getTrend(olderAmbiguity, newerAmbiguity);
  const riskTrend = getTrend(olderOverall, newerOverall);

  const blameVolatility = Math.abs((avg(newerBlame) ?? 0) - (avg(olderBlame) ?? 0));
  const blamePattern =
    blameVolatility >= 0.22 && blameTrend === "stable"
      ? "spiky"
      : blameTrend === "worsening"
        ? "increasing"
        : blameTrend === "improving"
          ? "decreasing"
          : "stable";

  const currentRisk = avg(newerOverall) ?? 0;
  const currentAmbiguity = avg(newerAmbiguity) ?? 0;
  const escalationSignal =
    (riskTrend === "worsening" && currentRisk >= 0.58) || (blamePattern === "increasing" && currentAmbiguity >= 0.5)
      ? "ready"
      : riskTrend === "worsening" || ambiguityTrend === "worsening"
        ? "watch"
        : "not-ready";

  return {
    toneTrend,
    blamePattern,
    riskTrend,
    escalationSignal,
  } as const;
};

const buildMessageNudgesContext = (events: MessageAnalysisRow[]): MessageNudgesContext => {
  const recentThree = events.slice(0, 3);
  const messages = recentThree.map((event) => event.raw_message);
  const decisions = recentThree
    .map((event) => event.decision?.recommendation?.primaryAction)
    .filter((value): value is string => Boolean(value));

  const derivedSignals = deriveSignals(events);
  const avgRisk =
    recentThree.length === 0
      ? null
      : recentThree.reduce((sum, event) => sum + (event.decision?.risk?.overall ?? 0), 0) / recentThree.length;

  const riskPattern =
    avgRisk === null
      ? "No historical risk pattern yet."
      : avgRisk >= 0.7
        ? "Recent communications trend high risk; prioritize neutral language and explicit asks."
        : avgRisk >= 0.4
          ? "Recent communications trend moderate risk; tighten ownership framing."
          : "Recent communications trend low risk; preserve clarity baseline.";

  return {
    projectMemory: messages,
    recentEvents: decisions,
    stakeholderSignals: [riskPattern, `Ambiguity trend: ${derivedSignals.riskTrend}. Escalation signal: ${derivedSignals.escalationSignal}.`],
    derivedSignals,
  };
};

const saveMessageAnalysis = async (input: {
  projectId: string;
  rawMessage: string;
  audience: string;
  toneScore: number;
  blameScore: number;
  ambiguityScore: number;
  overallRisk: number;
  decision: MessageNudgesDecision;
  aiOutput: MessageNudgesOutputSchema;
}) => {
  try {
    const supabase = createSupabaseServerClient();
    await supabase.from("message_analyses").insert({
      project_id: input.projectId,
      raw_message: input.rawMessage,
      audience: input.audience,
      tone_score: Number(input.toneScore.toFixed(2)),
      blame_score: Number(input.blameScore.toFixed(2)),
      ambiguity_score: Number(input.ambiguityScore.toFixed(2)),
      overall_risk: Number(input.overallRisk.toFixed(2)),
      decision: input.decision,
      ai_output: input.aiOutput,
      created_at: new Date().toISOString(),
    });
  } catch {
    // best-effort memory persistence only
  }
};

const promptPacks: Partial<Record<AIModuleId, unknown>> = {
  "stakeholder-intel": stakeholderIntelPromptPackV1,
  meetings: meetingsPromptPackV1,
  "political-risk": politicalRiskPromptPackV1,
  "escalation-guide": escalationGuidePromptPackV1,
  "message-nudges": messageNudgesPromptPackV1,
};

export const getProjectContext = async (projectId?: string): Promise<MemoryContext> => {
  const scopedProjectId = projectId?.trim() || "demo-project";

  try {
    const supabase = createSupabaseServerClient();
    const { data, error } = await supabase
      .from("message_analyses")
      .select("raw_message, decision, created_at")
      .eq("project_id", scopedProjectId)
      .order("created_at", { ascending: false })
      .limit(10);

    if (error) {
      throw error;
    }

    const recentEvents = (data ?? []) as MessageAnalysisRow[];

    return {
      projectMemory: recentEvents.map((event) => event.raw_message),
      recentEvents: recentEvents.map((event) => ({
        rawMessage: event.raw_message,
        decision: event.decision,
        createdAt: event.created_at,
      })),
      stakeholderSignals: [],
      derivedSignals: deriveSignals(recentEvents),
    };
  } catch {
    return {
      projectMemory: [],
      recentEvents: [],
      stakeholderSignals: [],
      derivedSignals: {
        toneTrend: "unknown",
        blamePattern: "unknown",
        riskTrend: "unknown",
        escalationSignal: "unknown",
      },
    };
  }
};

export async function runAIModule({
  moduleId,
  input,
  context,
}: RunAIModuleInput): Promise<AIResponseEnvelope<unknown>> {
  const moduleConfig = aiModuleRegistry.get(moduleId);

  if (!moduleConfig) {
    throw new Error(`Unknown AI module: ${moduleId}`);
  }

  const _startMs = Date.now();

  try {
  const promptPack = promptPacks[moduleId];
  void promptPack;

  const memoryContext = await getProjectContext(context?.projectId);
  const messageNudgesContext = buildMessageNudgesContext(memoryContext.recentEvents as MessageAnalysisRow[]);

  if (moduleConfig.mode === "openai") {
    if (moduleId !== "message-nudges") {
      console.warn("[gateway] openai_not_implemented_fallback", {
        moduleId,
        reason: "OpenAI mode only implemented for message-nudges; falling back to mock handler"
      });
      const { result, durationMs } = await measureAsync(() =>
        moduleConfig.handler({ input, context, memory: memoryContext })
      );
      traceGatewayCall({
        moduleId,
        mode: "openai_fallback_mock",
        projectId: context?.projectId ?? null,
        durationMs,
        outcome: "fallback",
        fallbackReason: "openai_not_implemented",
        memoryEventCount: memoryContext.recentEvents.length,
        memoryProjectCount: memoryContext.projectMemory.length,
      });
      return { ...result, inferenceMode: "fallback" as const, isSimulated: true, productionReady: false };
    }

    const payload = input as Partial<MessageNudgesInputSchema & { projectId?: string }>;
    const projectId = context?.projectId?.toString().trim() || payload.projectId?.trim() || "demo-project";
    const rawMessage = payload.rawMessage?.trim() ?? "";
    const audience = payload.audience?.trim() ?? "";
    if (!rawMessage || !audience) {
      throw new Error("message-nudges requires rawMessage and audience.");
    }

    const userContent = [
      `Audience: ${audience}`,
      `Raw message: ${rawMessage}`,
      "Context for better organizational fit:",
      ...messageNudgesContext.projectMemory.slice(0, 3).map((item) => `- Past message: ${item}`),
      ...messageNudgesContext.recentEvents.slice(0, 3).map((item) => `- Past decision: ${item}`),
      ...messageNudgesContext.stakeholderSignals.map((item) => `- Risk pattern: ${item}`),
      "- Derived trend signals:",
      `  toneTrend=${messageNudgesContext.derivedSignals.toneTrend}`,
      `  blamePattern=${messageNudgesContext.derivedSignals.blamePattern}`,
      `  riskTrend=${messageNudgesContext.derivedSignals.riskTrend}`,
      `  escalationSignal=${messageNudgesContext.derivedSignals.escalationSignal}`,
    ].join("\n");

    let inferenceResult: Awaited<ReturnType<typeof runInference>>;
    try {
      inferenceResult = await runInference({
        moduleId: "message-nudges",
        projectId,
        // B6: the budget scope. The route passes the authenticated user; without one the
        // router refuses the request rather than run it uncharged.
        workspaceId: typeof context?.workspaceId === "string" ? context.workspaceId : undefined,
        actorId: context?.actor?.actorUserId ?? undefined,
        messages: [
          { role: "system", content: messageNudgesPromptPackV1.systemPrompt },
          { role: "user", content: userContent },
        ],
        responseFormat: {
          type: "json_schema",
          jsonSchema: {
            name: "message_nudges_v1",
            strict: true,
            schema: {
              type: "object",
              additionalProperties: false,
              properties: {
                toneRisk: { type: "string", enum: ["low", "medium", "high"] },
                rewriteSuggestion: { type: "string" },
                improvedVersion: { type: "string" },
                confidence: { type: "string", enum: ["low", "medium", "high", "very-high"] },
                rationale: { type: "string" },
              },
              required: ["toneRisk", "rewriteSuggestion", "improvedVersion", "confidence", "rationale"],
            },
          },
        },
        temperature: 0.2,
        timeoutMs: 20000,
        maxAttempts: 3,
        retryDelayMs: 500,
        operationName: "message-nudges",
        idempotencyKey: randomUUID(),
      });
    } catch (error) {
      if (error instanceof InferenceError) {
        throw new Error(`Inference request failed: ${error.errorClass}`);
      }
      throw error;
    }

    const output = (inferenceResult.parsedJson ?? JSON.parse(inferenceResult.content)) as MessageNudgesOutputSchema;
    const toneScore = scoreToneRisk(rawMessage);
    const blameScore = scoreBlame(rawMessage);
    const ambiguityScore = scoreAmbiguity(rawMessage);
    const overallRisk = clampScore(toneScore * 0.45 + blameScore * 0.35 + ambiguityScore * 0.2);

    const trendRiskBump =
      (messageNudgesContext.derivedSignals.riskTrend === "worsening" ? 0.08 : 0) +
      (messageNudgesContext.derivedSignals.blamePattern === "increasing" ? 0.07 : 0) +
      (messageNudgesContext.derivedSignals.escalationSignal === "ready" ? 0.1 : 0);
    const adjustedRisk = clampScore(overallRisk + trendRiskBump);

    const recommendation =
      adjustedRisk >= 0.7
        ? "Rewrite with neutral facts, shared accountability, and a concrete ask before sending."
        : adjustedRisk >= 0.4
          ? "Tighten language with clearer ask and less direct attribution."
          : "Message is mostly safe; apply minor clarity polish.";

    const decision: MessageNudgesDecision = {
      risk: {
        tone: Number(toneScore.toFixed(2)),
        blame: Number(blameScore.toFixed(2)),
        ambiguity: Number(ambiguityScore.toFixed(2)),
        overall: Number(adjustedRisk.toFixed(2)),
      },
      recommendation: {
        primaryAction: recommendation,
        reason: `Tone=${toLevel(toneScore)}, Blame=${toLevel(blameScore)}, Ambiguity=${toLevel(ambiguityScore)}. trend=${messageNudgesContext.derivedSignals.riskTrend}, blamePattern=${messageNudgesContext.derivedSignals.blamePattern}, escalation=${messageNudgesContext.derivedSignals.escalationSignal}.`,
      },
      alternatives: [
        "Use a neutral fact + recovery-plan framing.",
        "Convert 'you' statements into joint ownership language.",
        "Add explicit timeline and owner request.",
      ],
      confidence: Number((0.55 + adjustedRisk * 0.35).toFixed(2)),
    };

    const enrichedOutput: MessageNudgesOutputSchema = {
      ...output,
      toneRisk: toLevel(Math.max(toneScore, overallRisk)),
      confidence:
        decision.confidence >= 0.86
          ? "very-high"
          : decision.confidence >= 0.72
            ? "high"
            : decision.confidence >= 0.52
              ? "medium"
              : "low",
      decision,
    };

    await saveMessageAnalysis({
      projectId,
      rawMessage,
      audience,
      toneScore,
      blameScore,
      ambiguityScore,
      overallRisk,
      decision,
      aiOutput: enrichedOutput,
    });

    traceGatewayCall({
      moduleId,
      mode: "openai",
      projectId: context?.projectId ?? null,
      durationMs: 0,
      outcome: "success",
      memoryEventCount: memoryContext.recentEvents.length,
      memoryProjectCount: memoryContext.projectMemory.length,
    });
    return {
      module: moduleId,
      generatedAt: new Date().toISOString(),
      confidence: enrichedOutput.confidence,
      summary: enrichedOutput.rewriteSuggestion,
      data: enrichedOutput,
      inferenceMode: "live" as const,
      isSimulated: false,
      productionReady: true,
    };
  }

  if (moduleConfig.mode === "hybrid") {
    console.warn("[gateway] hybrid_not_implemented_fallback", {
      moduleId,
      reason: "Hybrid mode not yet implemented; falling back to mock handler"
    });
    const { result, durationMs } = await measureAsync(() =>
      moduleConfig.handler({ input, context, memory: memoryContext })
    );
    traceGatewayCall({
      moduleId,
      mode: "hybrid_fallback_mock",
      projectId: context?.projectId ?? null,
      durationMs,
      outcome: "fallback",
      fallbackReason: "hybrid_not_implemented",
      memoryEventCount: memoryContext.recentEvents.length,
      memoryProjectCount: memoryContext.projectMemory.length,
    });
    return { ...result, inferenceMode: "fallback" as const, isSimulated: true, productionReady: false };
  }

  // mock mode — module is pre-production and returns static fixture data.
  const { result, durationMs } = await measureAsync(() =>
    moduleConfig.handler({ input, context, memory: memoryContext })
  );
  traceGatewayCall({
    moduleId,
    mode: moduleConfig.mode,
    projectId: context?.projectId ?? null,
    durationMs,
    outcome: "success",
    memoryEventCount: memoryContext.recentEvents.length,
    memoryProjectCount: memoryContext.projectMemory.length,
  });
  return { ...result, inferenceMode: "mock" as const, isSimulated: true, productionReady: moduleConfig.productionReady ?? false };
  } catch (error) {
    traceGatewayError(moduleId, moduleConfig?.mode ?? "unknown", error);
    throw error;
  }
}
