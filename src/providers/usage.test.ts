import { expect, test } from "bun:test";
import { computeUsage } from "./usage";

const flash = { cacheHitInput: 0.0028, cacheMissInput: 0.14, output: 0.28 };

test("input in the cache costs far less than input read again", () => {
  const cached = computeUsage(flash, { inputTokens: 1_000_000, inputTokenDetails: { cacheReadTokens: 1_000_000, noCacheTokens: 0 } });
  const read = computeUsage(flash, { inputTokens: 1_000_000, inputTokenDetails: { cacheReadTokens: 0, noCacheTokens: 1_000_000 } });
  expect(cached.costUsd).toBeCloseTo(0.0028, 6);
  expect(read.costUsd).toBeCloseTo(0.14, 6);
  expect(cached).toMatchObject({ tokensIn: 1_000_000, cacheHit: 1_000_000, cacheMiss: 0, steps: 1 });
});

test("output is charged apart", () => {
  expect(computeUsage(flash, { outputTokens: 1_000_000 }).costUsd).toBeCloseTo(0.28, 6);
});

test("without the provider's split, all input counts as read again", () => {
  const u = computeUsage(flash, { inputTokens: 1_000_000 });
  expect(u.cacheMiss).toBe(1_000_000);
  expect(u.costUsd).toBeCloseTo(0.14, 6);
});

test("a model without prices counts tokens and costs zero, and steps are what the caller says", () => {
  const u = computeUsage(undefined, { inputTokens: 500, outputTokens: 100 }, 3);
  expect(u).toEqual({ tokensIn: 500, tokensOut: 100, cacheHit: 0, cacheMiss: 500, costUsd: 0, steps: 3 });
});
