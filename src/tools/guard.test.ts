import { expect, test } from "bun:test";
import type { AgentDefinition } from "../agents/types";
import { guardResultSize, type SpillRequest } from "./guard";
import type { ToolContext } from "./types";

const agent: AgentDefinition = {
  id: "a", name: "a", description: null, model: null, tier: null,
  tools: [], skills: [], shellAllowlist: [], systemPrompt: "", home: null, frontmatter: {},
};
const ctx: ToolContext = { scope: { tenantId: "t" }, sessionId: "sess", agent };

const fakeTool = (output: unknown) => ({ execute: async () => output }) as unknown as Parameters<ReturnType<typeof guardResultSize>>[1];
const run = (t: ReturnType<ReturnType<typeof guardResultSize>>) => (t as { execute: (i: unknown, o: unknown) => Promise<unknown> }).execute({}, {});

test("a small result passes through untouched", async () => {
  const guard = guardResultSize({ maxChars: 20 });
  const out = await run(guard("read", fakeTool("hi"), ctx));
  expect(out).toBe("hi");
});

test("an oversized result without a spill returns a preview and a notice", async () => {
  const guard = guardResultSize({ maxChars: 20, previewChars: 10 });
  const out = (await run(guard("web_fetch", fakeTool("x".repeat(500)), ctx))) as Record<string, unknown>;
  expect(out.truncated).toBe(true);
  expect(out.reason).toContain("500 chars");
  expect(out.preview).toBe("x".repeat(10));
  expect(out.saved_to).toBeUndefined();
});

test("with a spill the whole result is persisted and the pointer says where", async () => {
  const spilled: SpillRequest[] = [];
  const guard = guardResultSize({
    maxChars: 20,
    spill: (req) => { spilled.push(req); return { savedTo: `cache/${req.sessionId}/${req.toolName}-1.txt` }; },
  });
  const out = (await run(guard("http_get", fakeTool({ body: "y".repeat(300) }), ctx))) as Record<string, unknown>;
  expect(out.saved_to).toBe("cache/sess/http_get-1.txt");
  expect(out.hint).toContain("Read a slice");
  expect(spilled[0]!.serialized).toBe(JSON.stringify({ body: "y".repeat(300) }));
});

test("a skipped tool passes whole however large", async () => {
  const guard = guardResultSize({ maxChars: 20, skip: (name) => name === "load_skill" });
  const big = { name: "alpha", body: "x".repeat(500) };
  expect(await run(guard("load_skill", fakeTool(big), ctx))).toEqual(big);
});

test("a tool with no execute is returned unchanged", () => {
  const guard = guardResultSize({ maxChars: 20 });
  const noExec = {} as Parameters<typeof guard>[1];
  expect(guard("x", noExec, ctx)).toBe(noExec);
});
