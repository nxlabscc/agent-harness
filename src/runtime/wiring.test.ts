import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { tool } from "ai";
import { z } from "zod";
import { compose, reactor } from "@nxlabscc/agent-context";
import { loadCatalog } from "../providers/catalog";
import { createSqliteSessionStore } from "../store/sqlite";
import { createToolRegistry } from "../tools/registry";
import { staticAgentSource, stubModel, testAgent } from "../testing";
import { createRuntime } from "./runtime";

// What the harness exposes is enough to wire memory and messaging without the
// harness knowing either library: memory is a reactor plus a tool, messaging is
// a tool, and the queue-driven start is claimSession + runTurn. The app, here
// the test, connects the parts. Nothing memory- or queue-specific is imported
// from the harness.

const scope = { tenantId: "t" };
const ref = { provider: "stub", model: "stub" };
const catalog = loadCatalog({ stub: { protocol: "openai", baseURL: "http://stub", models: { stub: { cacheHitInput: 0, cacheMissInput: 0, output: 0 } } } });
const config = {
  maxSteps: { run: 10, stream: 8 },
  continueOnCut: { prompt: "continue.", times: 2 },
  wrapUp: { prompt: "wrap up.", steps: 5 },
};

test("memory is wired as a reactor plus a tool, over the store's generic marks — no harness memory code", async () => {
  const store = createSqliteSessionStore(new Database(":memory:"));

  // The app's own memory, behind whatever interface it likes. The harness never sees it.
  const facts: string[] = [];
  const myMemory = {
    recall: (tenantId: string, query: string) => facts.filter((f) => f.includes(query.slice(0, 3))),
    remember: (fact: string) => { facts.push(fact); },
  };

  // Recall before the turn: a reactor the app writes, closing over its memory.
  const memoryRecall = reactor({
    beforeTurn: async (req) => {
      const found = myMemory.recall(req.scope.tenantId, req.query);
      // The marks table (generic) tracks what this session has already shown.
      const shown = ((await store.marks.get(req.scope, `shown:${req.sessionId}`)) as string[] | undefined) ?? [];
      const fresh = found.filter((f) => !shown.includes(f));
      if (fresh.length === 0) return [];
      await store.marks.set(req.scope, `shown:${req.sessionId}`, [...shown, ...fresh]);
      return [{ content: `<FACTS>\n${fresh.join("\n")}\n</FACTS>`, persist: true }];
    },
  });

  // The remember tool: a tool the app registers, closing over its memory.
  const registry = createToolRegistry<unknown>({
    tools: {
      remember: (ctx) => tool({
        description: "store a fact", inputSchema: z.object({ fact: z.string() }),
        execute: async ({ fact }) => { myMemory.remember(`${ctx.scope.tenantId}: ${fact}`); return "stored"; },
      }),
    },
  });

  const runtime = createRuntime({
    store, agents: staticAgentSource({ assistant: testAgent({ id: "assistant", tools: ["remember"] }) }),
    tools: registry, context: compose(memoryRecall), provider: { catalog }, config,
  });

  myMemory.remember("t: Rosario is where they live");
  const session = await runtime.openSession({ agent: "assistant", scope, trigger: "interactive" });
  await runtime.runTurn(session, { content: "Rosario weather", model: stubModel(), ref, extra: {} });

  // The memory block was injected after the user message by the reactor.
  const messages = await store.listMessages(session.id, scope);
  const injected = messages.find((m) => m.message.role === "system" && String(m.message.content).includes("<FACTS>"));
  expect(injected).toBeDefined();
  expect(String(injected!.message.content)).toContain("Rosario");
});

test("messaging is wired by the app: send is a tool, and a received message claims a session and runs a turn", async () => {
  const store = createSqliteSessionStore(new Database(":memory:"));

  // The app's own queue. The harness never imports it.
  const queue: { to: string; text: string }[] = [];

  const registry = createToolRegistry<unknown>({
    tools: {
      send_message: () => tool({
        description: "send a message to another agent", inputSchema: z.object({ to: z.string(), text: z.string() }),
        execute: async ({ to, text }) => { queue.push({ to, text }); return "queued"; },
      }),
    },
  });

  const runtime = createRuntime({
    store,
    agents: staticAgentSource({ alice: testAgent({ id: "alice", tools: ["send_message"] }), bob: testAgent({ id: "bob" }) }),
    tools: registry, context: compose(), provider: { catalog }, config,
  });

  // Alice sends a message (the tool enqueues it).
  const sender = await runtime.openSession({ agent: "alice", scope, trigger: "cron" });
  await runtime.runTurn(sender, { content: 'TOOLCALL send_message {"to":"bob","text":"review this"}', model: stubModel(), ref, extra: {} });
  expect(queue).toEqual([{ to: "bob", text: "review this" }]);

  // The app's worker: take the message, claim a session for its agent, run a turn.
  const message = queue.shift()!;
  const session = await runtime.claimSession({ agent: message.to, scope, trigger: "message" });
  expect(session).not.toBeNull();
  const result = await runtime.runTurn(session!, { content: message.text, model: stubModel(), ref, extra: {} });
  expect(result.summary).toBe("echo: review this");
});
