import { randomUUID } from "node:crypto";
import { resilientFetch } from "@/lib/ai/resilient-fetch";
import type { InferenceProvider, InferenceRequest, InferenceResponse } from "@/lib/ai/inference/types";
import { InferenceError } from "@/lib/ai/inference/types";

const DEFAULT_MODEL = "gpt-4.1-mini";
const OPENAI_CHAT_URL = "https://api.openai.com/v1/chat/completions";

type OpenAIChatResponse = {
  model?: string;
  choices?: Array<{
    message?: { content?: string };
    finish_reason?: string;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
  error?: { message?: string };
};

function buildResponseFormat(
  responseFormat: InferenceRequest["responseFormat"],
): Record<string, unknown> | undefined {
  if (!responseFormat || responseFormat.type === "text") return undefined;
  if (responseFormat.type === "json_object") {
    return { type: "json_object" };
  }
  if (responseFormat.type === "json_schema" && responseFormat.jsonSchema) {
    return {
      type: "json_schema",
      json_schema: {
        name: responseFormat.jsonSchema.name,
        strict: responseFormat.jsonSchema.strict ?? true,
        schema: responseFormat.jsonSchema.schema,
      },
    };
  }
  return undefined;
}

function tryParseJson(content: string): unknown {
  try {
    return JSON.parse(content);
  } catch {
    return undefined;
  }
}

export function isOpenAIProviderConfigured(): boolean {
  return Boolean(process.env.OPENAI_API_KEY);
}

export const openAIProvider: InferenceProvider = {
  id: "openai",
  metering: "metered",

  async complete(request: InferenceRequest): Promise<InferenceResponse> {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new InferenceError(
        "Missing OPENAI_API_KEY on the server.",
        "auth_error",
        "openai",
        0,
      );
    }

    const model = request.modelPreference ?? process.env.DEFAULT_AI_MODEL ?? DEFAULT_MODEL;
    const responseFormat = buildResponseFormat(request.responseFormat);

    const body: Record<string, unknown> = {
      model,
      temperature: request.temperature ?? 0.2,
      messages: request.messages,
    };
    if (responseFormat) body.response_format = responseFormat;
    if (request.maxTokens) body.max_tokens = request.maxTokens;

    const startMs = Date.now();

    const fetchResult = await resilientFetch<OpenAIChatResponse>(
      OPENAI_CHAT_URL,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
      },
      {
        timeoutMs: request.timeoutMs ?? 25000,
        maxAttempts: request.maxAttempts ?? 2,
        retryDelayMs: request.retryDelayMs ?? 500,
        operationName: request.operationName ?? "inference",
        idempotencyKey: request.idempotencyKey ?? randomUUID(),
      },
    );

    const latencyMs = Date.now() - startMs;

    if (!fetchResult.ok) {
      throw new InferenceError(
        `OpenAI request failed: ${fetchResult.message}`,
        fetchResult.errorClass,
        "openai",
        fetchResult.attempts,
      );
    }

    const data = fetchResult.data;
    const content = data.choices?.[0]?.message?.content ?? "";
    if (!content) {
      throw new InferenceError(
        "OpenAI returned an empty response.",
        "server_error",
        "openai",
        fetchResult.attempts,
      );
    }

    const shouldParseJson =
      request.responseFormat?.type === "json_schema" ||
      request.responseFormat?.type === "json_object";

    return {
      provider: "openai",
      model: data.model ?? model,
      content,
      parsedJson: shouldParseJson ? tryParseJson(content) : undefined,
      usage: data.usage
        ? {
            inputTokens: data.usage.prompt_tokens,
            outputTokens: data.usage.completion_tokens,
            totalTokens: data.usage.total_tokens,
          }
        : undefined,
      finishReason: data.choices?.[0]?.finish_reason,
      latencyMs,
      attempts: fetchResult.attempts,
    };
  },
};
