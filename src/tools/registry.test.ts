import { expect, test } from "bun:test";
import { tool, type ToolSet } from "ai";
import { z } from "zod";
import type { AgentDefinition } from "../agents/types";
import { createToolRegistry } from "./registry";
import type { ToolContext } from "./types";

const agent: AgentDefinition = {
  id: "a", name: "a", description: null, model: null, tier: null,
  tools: [], skills: [], shellAllowlist: [], systemPrompt: "", home: null, frontmatter: {},
};
const ctx = <Extra,>(extra: Extra): ToolContext<Extra> => ({ scope: { tenantId: "t" }, sessionId: "s", agent, ...extra });

const echo = (label: string) => tool({ description: label, inputSchema: z.object({}), execute: async () => label });

test("the allowlist decides which tools a session gets; unknown names are reported", () => {
  const unknown: string[] = [];
  const reg = createToolRegistry<unknown>({
    tools: { read: echo("read"), write: echo("write") },
    onUnknown: (n) => unknown.push(n),
  });
  const set = reg.build(["read", "nope"], ctx({}));
  expect(Object.keys(set)).toEqual(["read"]);
  expect(unknown).toEqual(["nope"]);
});

test("a factory builds a fresh tool per session with its context", async () => {
  const reg = createToolRegistry<{ token: string }>({
    tools: { whoami: (c) => tool({ description: "x", inputSchema: z.object({}), execute: async () => `${c.agent.id}:${c.token}` }) },
  });
  const set = reg.build(["whoami"], ctx({ token: "abc" }));
  const out = await (set.whoami!.execute as (i: unknown, o: unknown) => Promise<unknown>)({}, {});
  expect(out).toBe("a:abc");
});

test("always-on tools are granted whatever the allowlist says", () => {
  const reg = createToolRegistry<unknown>({ tools: { ask: echo("ask"), read: echo("read") }, alwaysOn: ["ask"] });
  expect(Object.keys(reg.build([], ctx({}))).sort()).toEqual(["ask"]);
  expect(Object.keys(reg.build(["read"], ctx({}))).sort()).toEqual(["ask", "read"]);
});

test("extra tools join before the allowlist and a native of the same name overrides them", async () => {
  const reg = createToolRegistry<unknown>({ tools: { search: echo("native-search"), read: echo("read") } });
  const extra: ToolSet = { search: echo("mcp-search"), list: echo("mcp-list") };
  const set = reg.build(["read", "search"], ctx({}), { extra });
  expect(Object.keys(set).sort()).toEqual(["list", "read", "search"]);
  expect(await (set.search!.execute as (i: unknown, o: unknown) => Promise<unknown>)({}, {})).toBe("native-search");
});

test("extra tools can be made to obey the allowlist instead of bypassing it", () => {
  const reg = createToolRegistry<unknown>({ tools: { read: echo("read") } });
  const extra: ToolSet = { search: echo("mcp-search"), list: echo("mcp-list") };
  const set = reg.build(["read", "search"], ctx({}), { extra, extraBypassesAllowlist: false });
  expect(Object.keys(set).sort()).toEqual(["read", "search"]);
});

test("middleware wraps every tool in order", async () => {
  const marks: string[] = [];
  const mark = (tag: string) => (name: string, t: ToolSet[string]) => {
    const original = (t as { execute: (i: unknown, o: unknown) => Promise<unknown> }).execute;
    return { ...t, execute: async (i: unknown, o: unknown) => { marks.push(`${tag}:${name}`); return original(i, o); } } as ToolSet[string];
  };
  const reg = createToolRegistry<unknown>({ tools: { read: echo("read") }, middleware: [mark("outer"), mark("inner")] });
  const set = reg.build(["read"], ctx({}));
  await (set.read!.execute as (i: unknown, o: unknown) => Promise<unknown>)({}, {});
  // Applied in order, so the last wraps outermost and runs first.
  expect(marks).toEqual(["inner:read", "outer:read"]);
});

test("effects say what a tool does, unknown is read-only, and extra effects are covered", () => {
  const reg = createToolRegistry<unknown>({ tools: { read: echo("r"), write: echo("w") }, effects: { write: "rw" } });
  expect(reg.effectOf("write")).toBe("rw");
  expect(reg.effectOf("read")).toBe("ro");
  expect(reg.effectOf("unknown")).toBe("ro");
  expect(reg.isMutating("write")).toBe(true);
  expect(reg.isMutating("create_row", { create_row: "rw" })).toBe(true);
  expect(reg.names().sort()).toEqual(["read", "write"]);
});
