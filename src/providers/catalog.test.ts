import { expect, test } from "bun:test";
import { contextWindowOf, loadCatalog, parseModelRef, priceOf, seesImages, withBaseUrls } from "./catalog";

const FILE = {
  _comment: "who answers",
  deepseek: {
    protocol: "deepseek",
    baseURL: "https://api.deepseek.com",
    _order: "flash first",
    models: {
      "deepseek-v4-flash": { tiers: ["fast"], context: 1_000_000, cacheHitInput: 0.0028, cacheMissInput: 0.14, output: 0.28 },
      "deepseek-v4-pro": { tiers: ["balanced", "quality", "reasoning"], effort: true, cacheHitInput: 0.003625, cacheMissInput: 0.435, output: 0.87 },
    },
  },
  zen: {
    protocol: "openai",
    baseURL: "https://opencode.ai/zen/v1",
    models: { "space-bunny-free": { tiers: ["fast", "balanced", "quality", "reasoning"], vision: true, cacheHitInput: 0, cacheMissInput: 0, output: 0 } },
  },
  voice: { stt: "deepgram" },
};

test("the file loads: comments and entries without a protocol are skipped, the rest is typed", () => {
  const catalog = loadCatalog(FILE);
  expect(Object.keys(catalog).sort()).toEqual(["deepseek", "zen"]);
  expect(catalog.deepseek!.models["deepseek-v4-pro"]).toEqual({
    tiers: ["balanced", "quality", "reasoning"], effort: true, cacheHitInput: 0.003625, cacheMissInput: 0.435, output: 0.87,
  });
  expect(catalog.zen!.models["space-bunny-free"]!.vision).toBe(true);
});

test("what breaks a turn is refused with the entry named", () => {
  expect(() => loadCatalog({ x: { protocol: "grpc", models: {} } })).toThrow("provider 'x' speaks protocol 'grpc'");
  expect(() => loadCatalog({ x: { protocol: "openai", models: { m: { cacheHitInput: 1, output: 1 } } } })).toThrow(
    "model 'x/m' has no cacheMissInput price",
  );
  expect(() => loadCatalog({ x: { protocol: "openai", models: { m: { tiers: ["huge"], cacheHitInput: 1, cacheMissInput: 1, output: 1 } } } })).toThrow(
    "model 'x/m' declares a tier that does not exist",
  );
  expect(() => loadCatalog([])).toThrow("JSON object");
});

test("a model ref parses with or without its provider", () => {
  expect(parseModelRef("anthropic/claude-sonnet-5")).toEqual({ provider: "anthropic", model: "claude-sonnet-5" });
  expect(parseModelRef("deepseek-v4-flash", "deepseek")).toEqual({ provider: "deepseek", model: "deepseek-v4-flash" });
  expect(() => parseModelRef("deepseek-v4-flash")).toThrow("names no provider");
});

test("price, window and vision read from the catalog, with the conservative window when unsaid", () => {
  const catalog = loadCatalog(FILE);
  expect(priceOf(catalog, { provider: "deepseek", model: "deepseek-v4-flash" })).toBeCloseTo(0.4228, 6);
  expect(priceOf(catalog, { provider: "deepseek", model: "unknown" })).toBe(Infinity);
  expect(contextWindowOf(catalog, { provider: "deepseek", model: "deepseek-v4-flash" })).toBe(1_000_000);
  expect(contextWindowOf(catalog, { provider: "deepseek", model: "deepseek-v4-pro" })).toBe(32_000);
  expect(seesImages(catalog, { provider: "zen", model: "space-bunny-free" })).toBe(true);
  expect(seesImages(catalog, { provider: "deepseek", model: "deepseek-v4-flash" })).toBe(false);
});

test("base URLs can be pointed elsewhere, and an unknown provider added as openai", () => {
  const catalog = withBaseUrls(loadCatalog(FILE), { deepseek: "http://stub:5050", "stub-compat": "http://stub:6060" });
  expect(catalog.deepseek!.baseURL).toBe("http://stub:5050");
  expect(catalog.deepseek!.protocol).toBe("deepseek");
  expect(catalog["stub-compat"]).toEqual({ protocol: "openai", baseURL: "http://stub:6060", models: {} });
});
