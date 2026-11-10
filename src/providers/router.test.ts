import { describe, expect, test } from "bun:test";
import { loadCatalog } from "./catalog";
import { available, byTier, onlyElected, sideModel, type Credential, type RouteRequest } from "./router";

// The agent asks for capacity, not a model. The classification lives with each
// model in the catalog, and between two that serve the cheapest wins.

const catalog = loadCatalog({
  deepseek: {
    protocol: "deepseek",
    models: {
      "deepseek-v4-flash": { tiers: ["fast"], cacheHitInput: 0.0028, cacheMissInput: 0.14, output: 0.28 },
      "deepseek-v4-pro": { tiers: ["balanced", "quality", "reasoning"], cacheHitInput: 0.003625, cacheMissInput: 0.435, output: 0.87 },
    },
  },
  anthropic: {
    protocol: "anthropic",
    models: {
      "claude-haiku": { tiers: ["fast"], vision: true, cacheHitInput: 0.1, cacheMissInput: 1, output: 5 },
      "claude-sonnet": { tiers: ["balanced"], vision: true, cacheHitInput: 0.2, cacheMissInput: 2, output: 10 },
      "claude-opus": { tiers: ["quality", "reasoning"], vision: true, cacheHitInput: 0.5, cacheMissInput: 5, output: 25 },
      "claude-fable": { cacheHitInput: 1, cacheMissInput: 10, output: 50 },
    },
  },
  zen: {
    protocol: "openai",
    baseURL: "https://zen.example",
    models: {
      "bunny-free": { tiers: ["fast", "balanced", "quality", "reasoning"], cacheHitInput: 0, cacheMissInput: 0, output: 0 },
      "paid-on-zen": { tiers: ["quality"], cacheHitInput: 1, cacheMissInput: 1, output: 1 },
    },
  },
});

/** The person's keys, plus the system's free one that is always there. */
const keys = (...providers: string[]): Credential[] => [
  ...providers.map((provider) => ({ provider, apiKey: `key-${provider}`, system: false })),
  { provider: "zen", apiKey: "system", system: true },
];
const tree = (...providers: string[]) => available(catalog, keys(...providers));
const request = (r: Partial<RouteRequest>): RouteRequest => ({ model: null, tier: null, ...r });
const choose = (r: Partial<RouteRequest>, d: ReturnType<typeof tree>) => byTier({ defaultProvider: "deepseek" }).choose(request(r), d, catalog);

describe("what a person can use", () => {
  test("on the system's key only what costs nothing runs", () => {
    const d = tree();
    expect(d.candidates.map((c) => c.model)).toEqual(["bunny-free"]);
    expect(d.candidates[0]!.own).toBe(false);
  });

  test("with a key of their own, the free models are out of the candidates and kept apart", () => {
    const d = tree("anthropic");
    expect(d.candidates.every((c) => c.provider === "anthropic" && c.own)).toBe(true);
    expect(d.free.map((c) => c.model)).toEqual(["bunny-free"]);
  });

  test("a candidate carries its capabilities", () => {
    expect(tree("anthropic").candidates.find((c) => c.model === "claude-haiku")!.capabilities).toEqual(["vision"]);
  });
});

describe("byTier", () => {
  test("a tier is served by the cheapest that reaches it", () => {
    expect(choose({ tier: "fast" }, tree("anthropic"))!.candidate.model).toBe("claude-haiku");
    expect(choose({ tier: "balanced" }, tree("anthropic"))!.candidate.model).toBe("claude-sonnet");
    expect(choose({ tier: "fast" }, tree("anthropic"))!.trace).toEqual({ policy: "byTier", reason: "tier", tier: "fast" });
  });

  test("with two keys, the cheapest across both: the choice is not by order", () => {
    expect(choose({ tier: "fast" }, tree("anthropic", "deepseek"))!.candidate.provider).toBe("deepseek");
  });

  test("a tier is a floor: when none reaches it the next up serves, never one below", () => {
    const onlyFast = available(catalog, [{ provider: "deepseek", apiKey: "k", system: false }]);
    expect(choose({ tier: "balanced" }, onlyFast)!.candidate.model).toBe("deepseek-v4-pro");
    const noReasoning = loadCatalog({ x: { protocol: "openai", baseURL: "u", models: { small: { tiers: ["fast"], cacheHitInput: 1, cacheMissInput: 1, output: 1 } } } });
    const d = available(noReasoning, [{ provider: "x", apiKey: "k", system: false }]);
    const decision = byTier().choose(request({ tier: "reasoning" }), d, noReasoning)!;
    expect(decision.candidate.model).toBe("small");
    expect(decision.trace.reason).toBe("no-tier");
  });

  test("no tier declared asks for balanced", () => {
    expect(choose({}, tree("anthropic"))!.candidate.model).toBe("claude-sonnet");
  });

  test("a named model runs on the person's key for that provider, even outside the catalog", () => {
    const d = choose({ model: "anthropic/claude-fable" }, tree("anthropic"))!;
    expect(d.candidate).toMatchObject({ provider: "anthropic", model: "claude-fable", apiKey: "key-anthropic", own: true });
    expect(d.trace.reason).toBe("named-model");
    expect(choose({ model: "anthropic/claude-next" }, tree("anthropic"))!.candidate.price).toBe(Infinity);
    // A bare name belongs to the default provider.
    expect(choose({ model: "deepseek-v4-pro" }, tree("deepseek"))!.candidate.provider).toBe("deepseek");
  });

  test("a named model whose provider the person lacks falls to the free branch, never to another paid model", () => {
    const d = choose({ model: "anthropic/claude-opus" }, tree("deepseek"))!;
    expect(d.candidate.model).toBe("bunny-free");
    expect(d.candidate.own).toBe(false);
  });

  test("with nothing at all, null", () => {
    expect(byTier().choose(request({ tier: "fast" }), available(catalog, []), catalog)).toBeNull();
    expect(byTier().choose(request({ model: "x/y" }), available(catalog, []), catalog)).toBeNull();
  });

  test("what the person elected narrows the tier, and survives being unavailable", () => {
    const d = tree("anthropic", "deepseek");
    expect(choose({ tier: "fast", elected: { fast: ["anthropic/claude-haiku"] } }, d)!.candidate.model).toBe("claude-haiku");
    expect(choose({ tier: "fast", elected: { fast: ["openai/gpt"] } }, d)!.candidate.model).toBe("deepseek-v4-flash");
    expect(onlyElected([], ["a/b"])).toEqual([]);
  });
});

test("background work asks for fast of the same tree", () => {
  expect(sideModel(tree("anthropic", "deepseek"), catalog)!.model).toBe("deepseek-v4-flash");
  expect(sideModel(tree(), catalog)!.model).toBe("bunny-free");
  expect(sideModel(available(catalog, []), catalog)).toBeNull();
});
