import type { Usage } from "../store/types";
import type { Model } from "./catalog";

/** What the SDK reports after a call or a step. The cache split is under `inputTokenDetails`. */
export type RawUsage = {
  inputTokens?: number | undefined;
  outputTokens?: number | undefined;
  inputTokenDetails?: { cacheReadTokens?: number | undefined; noCacheTokens?: number | undefined } | undefined;
};

/**
 * What the usage cost, at the model's prices.
 *
 * Input is split: what the provider had in its cache costs a fraction of what
 * it had to read again, and without the split the number says nothing about
 * whether the prompt is built well. Without the split from the provider, all
 * input counts as read again: overestimating beats hiding real spend.
 *
 * A model without prices counts tokens and costs zero: the truth for a free
 * one, and a visible underestimate for a paid one still to be declared.
 */
export function computeUsage(prices: Pick<Model, "cacheHitInput" | "cacheMissInput" | "output"> | undefined, raw: RawUsage, steps = 1): Usage {
  const inputTotal = raw.inputTokens ?? 0;
  const cacheHit = raw.inputTokenDetails?.cacheReadTokens ?? 0;
  const cacheMiss = raw.inputTokenDetails?.noCacheTokens ?? Math.max(0, inputTotal - cacheHit);
  const output = raw.outputTokens ?? 0;
  const costUsd =
    prices === undefined
      ? 0
      : (cacheHit * prices.cacheHitInput + cacheMiss * prices.cacheMissInput + output * prices.output) / 1_000_000;
  return { tokensIn: cacheHit + cacheMiss, tokensOut: output, cacheHit, cacheMiss, costUsd, steps };
}
