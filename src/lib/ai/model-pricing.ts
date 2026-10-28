// B6 — the explicit price table that AI cost control depends on.
//
// Every billable model request is priced BEFORE it is sent (src/lib/ai/providers/router.ts
// refuses an unpriced model) and settled against the usage the provider reports. Prices are
// indicative per-1M-token USD list prices used for ceilings and reporting, not for billing.
//
// Model ids are matched exactly, never by prefix:
//   * a family id ("gpt-4.1-mini") is priced at its family price;
//   * a dated snapshot ("gpt-4.1-mini-2025-04-14") is priced only when that exact date is
//     allowlisted for the family. A snapshot that is not listed is unpriced, because a
//     provider can price snapshots of one family differently (gpt-4o-2024-05-13 costs twice
//     gpt-4o-2024-08-06), so it is refused rather than guessed;
//   * anything else (fine-tunes, other providers, suffixes, other casing) is unpriced.
//
// Adding a model or snapshot means adding it here with its price and bumping
// AI_PRICE_TABLE_VERSION; the version is stored on every cost reservation.

export const AI_PRICE_TABLE_VERSION = "openai-2026-10-26";

export type ModelPrice = {
  readonly provider: "openai";
  readonly family: string;
  readonly inputPerMillionUsd: number;
  readonly outputPerMillionUsd: number;
  /** The model's own output-token maximum: the bound when a request sets no max_tokens. */
  readonly maxOutputTokens: number;
  /** Dated snapshots (YYYY-MM-DD) that bill at this family price. */
  readonly snapshots: readonly string[];
};

const PRICED_MODELS: Readonly<Record<string, ModelPrice>> = Object.freeze({
  "gpt-4.1": { provider: "openai", family: "gpt-4.1", inputPerMillionUsd: 2.0, outputPerMillionUsd: 8.0, maxOutputTokens: 32_768, snapshots: ["2025-04-14"] },
  "gpt-4.1-mini": { provider: "openai", family: "gpt-4.1-mini", inputPerMillionUsd: 0.4, outputPerMillionUsd: 1.6, maxOutputTokens: 32_768, snapshots: ["2025-04-14"] },
  "gpt-4.1-nano": { provider: "openai", family: "gpt-4.1-nano", inputPerMillionUsd: 0.1, outputPerMillionUsd: 0.4, maxOutputTokens: 32_768, snapshots: ["2025-04-14"] },
  "gpt-4o": { provider: "openai", family: "gpt-4o", inputPerMillionUsd: 2.5, outputPerMillionUsd: 10.0, maxOutputTokens: 16_384, snapshots: ["2024-08-06", "2024-11-20"] },
  "gpt-4o-mini": { provider: "openai", family: "gpt-4o-mini", inputPerMillionUsd: 0.15, outputPerMillionUsd: 0.6, maxOutputTokens: 16_384, snapshots: ["2024-07-18"] },
});

const DATED_SNAPSHOT = /^(.+)-(\d{4}-\d{2}-\d{2})$/;

export type ModelPriceResolution =
  | { ok: true; modelId: string; family: string; snapshot: string | null; priceVersion: string; price: ModelPrice }
  | { ok: false; modelId: string; reason: "unknown_model" | "unlisted_snapshot" };

/** Resolve a provider model id to its price, or say why it cannot be priced. Never guesses. */
export function resolveModelPrice(provider: string, modelId: string | null | undefined): ModelPriceResolution {
  const id = typeof modelId === "string" ? modelId : "";
  if (provider !== "openai" || !id) return { ok: false, modelId: id, reason: "unknown_model" };

  const family = Object.prototype.hasOwnProperty.call(PRICED_MODELS, id) ? PRICED_MODELS[id] : undefined;
  if (family) return { ok: true, modelId: id, family: family.family, snapshot: null, priceVersion: AI_PRICE_TABLE_VERSION, price: family };

  const dated = DATED_SNAPSHOT.exec(id);
  if (dated) {
    const [, familyId, date] = dated;
    const datedFamily = Object.prototype.hasOwnProperty.call(PRICED_MODELS, familyId) ? PRICED_MODELS[familyId] : undefined;
    if (datedFamily) {
      return datedFamily.snapshots.includes(date)
        ? { ok: true, modelId: id, family: datedFamily.family, snapshot: date, priceVersion: AI_PRICE_TABLE_VERSION, price: datedFamily }
        : { ok: false, modelId: id, reason: "unlisted_snapshot" };
    }
  }
  return { ok: false, modelId: id, reason: "unknown_model" };
}

/** USD cost of reported usage; null when the model is unpriced or no token count was reported. */
export function costOfUsageUsd(price: ModelPrice, inputTokens?: number, outputTokens?: number): number | null {
  const validInput = typeof inputTokens === "number" && Number.isFinite(inputTokens) && inputTokens >= 0;
  const validOutput = typeof outputTokens === "number" && Number.isFinite(outputTokens) && outputTokens >= 0;
  if (!validInput || !validOutput) return null;
  const cost = (inputTokens / 1_000_000) * price.inputPerMillionUsd + (outputTokens / 1_000_000) * price.outputPerMillionUsd;
  return roundUsdUp(cost);
}

/**
 * An UPPER bound on the prompt tokens of a chat request. Byte-level BPE tokens cover at
 * least one UTF-8 byte each, so a text never has more tokens than bytes; the serialized
 * messages and response format over-count the text itself (quoting, keys), and the
 * per-message allowance covers the chat framing tokens.
 */
export function inputTokenUpperBound(payload: { messages: unknown; responseFormat?: unknown }): number {
  const messages = Array.isArray(payload.messages) ? payload.messages.length : 0;
  const bytes = Buffer.byteLength(JSON.stringify({ messages: payload.messages ?? [], response_format: payload.responseFormat ?? null }), "utf8");
  return bytes + 16 * messages + 64;
}

/** The output tokens a request can be billed for: its max_tokens, capped by the model maximum. */
export function outputTokenUpperBound(price: ModelPrice, maxTokens?: number): number {
  if (typeof maxTokens === "number" && Number.isInteger(maxTokens) && maxTokens > 0) return Math.min(maxTokens, price.maxOutputTokens);
  return price.maxOutputTokens;
}

/** Worst-case USD cost of ONE provider attempt. */
export function worstCaseAttemptCostUsd(price: ModelPrice, inputTokens: number, outputTokens: number): number {
  return roundUsdUp((inputTokens / 1_000_000) * price.inputPerMillionUsd + (outputTokens / 1_000_000) * price.outputPerMillionUsd);
}

/** Round UP to the ledger's precision (8 decimals), so rounding can never under-count. */
export function roundUsdUp(value: number): number {
  return Math.ceil(value * 1e8 - 1e-6) / 1e8;
}
