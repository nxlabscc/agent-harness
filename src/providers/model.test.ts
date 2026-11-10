import { expect, test } from "bun:test";
import { loadCatalog } from "./catalog";
import { fetchWithRetryNotice, modelFor } from "./model";

const catalog = loadCatalog({
  deepseek: { protocol: "deepseek", baseURL: "http://stub:5050/v1", models: {} },
  anthropic: { protocol: "anthropic", baseURL: "http://stub:5051", models: {} },
  zen: { protocol: "openai", baseURL: "http://stub:5052/v1", models: {} },
  nourl: { protocol: "openai", models: {} },
});

test("each protocol builds a model from its SDK, named as the catalog names it", async () => {
  const ds = await modelFor(catalog, { provider: "deepseek", model: "deepseek-v4-flash" }, { apiKey: "k" });
  expect(ds.modelId).toBe("deepseek-v4-flash");
  expect(ds.provider).toContain("deepseek");
  const an = await modelFor(catalog, { provider: "anthropic", model: "claude-sonnet" }, { apiKey: "k" });
  expect(an.modelId).toBe("claude-sonnet");
  const zen = await modelFor(catalog, { provider: "zen", model: "bunny" }, { apiKey: "k" });
  expect(zen.modelId).toBe("bunny");
  expect(zen.provider).toContain("zen");
});

test("a provider outside the catalog, or an openai one without a baseURL, is refused", async () => {
  await expect(modelFor(catalog, { provider: "openai", model: "gpt" }, { apiKey: "k" })).rejects.toThrow("not in the catalog");
  await expect(modelFor(catalog, { provider: "nourl", model: "m" }, { apiKey: "k" })).rejects.toThrow("needs a baseURL");
});

test("the model calls through the fetch it is given", async () => {
  const calls: string[] = [];
  const stub = (async (input: Parameters<typeof fetch>[0]) => {
    calls.push(String(input));
    return new Response(JSON.stringify({ error: "nope" }), { status: 400, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  const model = await modelFor(catalog, { provider: "zen", model: "bunny" }, { apiKey: "k", fetch: stub });
  await expect(model.doGenerate({ prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }] })).rejects.toThrow();
  expect(calls[0]).toStartWith("http://stub:5052/v1");
});

test("the retry notice counts consecutive failures and resets on a success", async () => {
  const notices: { attempt: number; reason: string }[] = [];
  let n = 0;
  const base = (async () => {
    n++;
    if (n <= 2) return new Response("", { status: 503 });
    if (n === 3) return new Response("ok", { status: 200 });
    throw new Error("socket hang up");
  }) as unknown as typeof fetch;
  const f = fetchWithRetryNotice((r) => notices.push(r), base);
  await f("http://x");
  await f("http://x");
  await f("http://x");
  await f("http://x").catch(() => undefined);
  await f("http://x").catch(() => undefined);
  expect(notices).toEqual([
    { attempt: 2, reason: "HTTP 503" },
    { attempt: 3, reason: "HTTP 503" },
    { attempt: 2, reason: "socket hang up" },
  ]);
});
