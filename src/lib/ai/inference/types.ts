export type InferenceRole = "system" | "user" | "assistant" | "tool";

export type DataSensitivity = "restricted" | "confidential" | "internal" | "public";

export interface InferenceMessage {
  role: InferenceRole;
  content: string;
}

export interface InferenceJsonSchema {
  name: string;
  schema: Record<string, unknown>;
  strict?: boolean;
}

export interface InferenceRequest {
  moduleId?: string;
  workspaceId?: string;
  projectId?: string;
  actorId?: string;
  actorType?: string;
  dataSensitivity?: DataSensitivity;
  messages: InferenceMessage[];
  responseFormat?: {
    type: "json_schema" | "json_object" | "text";
    jsonSchema?: InferenceJsonSchema;
  };
  modelPreference?: string;
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
  maxAttempts?: number;
  retryDelayMs?: number;
  /**
   * Depth of the agent chain that produced this request (0 = user-initiated).
   * Enforced against AI_MAX_CHAIN_DEPTH in the router so recursive/agent-
   * chained invocations are always bounded (Perilla 11).
   */
  chainDepth?: number;
  operationName?: string;
  idempotencyKey?: string;
  // Routing metadata: routingMode, preferredProvider, allowFallback,
  // requireLocalExecution, tenantRegion, dataResidency
  metadata?: Record<string, unknown>;
}

export interface InferenceUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

export interface InferenceResponse {
  provider: string;
  model: string;
  content: string;
  parsedJson?: unknown;
  usage?: InferenceUsage;
  finishReason?: string;
  latencyMs?: number;
  /** HTTP attempts the provider made for this response (retries included). */
  attempts?: number;
}

export interface InferenceProvider {
  readonly id: string;
  /**
   * B6: "metered" (the default when absent) means every call costs money, so the router
   * prices, reserves and settles it. Only a provider that cannot bill (a local stub) may
   * declare "unmetered".
   */
  readonly metering?: "metered" | "unmetered";
  complete(request: InferenceRequest): Promise<InferenceResponse>;
}

export class InferenceError extends Error {
  constructor(
    message: string,
    public readonly errorClass:
      | "rate_limited"
      | "server_error"
      | "network_error"
      | "timeout"
      | "auth_error"
      | "bad_request"
      | "unknown",
    public readonly provider: string,
    public readonly attempts?: number,
  ) {
    super(message);
    this.name = "InferenceError";
  }
}
