import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { tool } from "ai";
import { z } from "zod";
import { compose, reactor } from "@nxlabscc/agent-context";
import { loadCatalog } from "../providers/catalog";
import { createSqliteSessionStore } from "../store/sqlite";
import { createToolRegistry } from "../tools/registry";
import { staticAgentSource, stubModel, testAgent } from "../testing";
import { createRuntime, type RuntimeOptions } from "./runtime";

const scope = { tenantId: "t" };
const ref = { provider: "stub", model: "stub" };

const catalog = loadCatalog({
  stub: { protocol: "openai", baseURL: "http://stub", models: { stub: { context: 100_000, cacheHitInput: 0, cacheMissInput: 1, output: 2 } } },
});

const config = {
  maxSteps: { run: 100, stream: 8 },
  continueOnCut: { prompt: "Continue from where you stopped.", times: 2 },
  wrapUp: { prompt: "Wrap up and write your pending tasks.", steps: 15 },
};

function setup(over: Partial<RuntimeOptions<unknown>> = {}) {
  const store = createSqliteSessionStore(new Database(":memory:"));
  const registry = createToolRegistry<unknown>({
    tools: {
      greet: () => tool({ description: "greet", inputSchema: z.object({ name: z.string() }), execute: async ({ name }) => `hi ${name}` }),
    },
  });
  const runtime = createRuntime({
    store,
    agents: staticAgentSource({
      assistant: testAgent({ id: "assistant" }),
      helper: testAgent({ id: "helper", tools: ["greet"] }),
    }),
    tools: registry,
    context: compose(reactor({ atOpen: () => ["<clock>12:00</clock>"] })),
    provider: { catalog },
    config,
    ...over,
  });
  return { store, runtime };
}

test("openSession freezes the system prompt with the context's open blocks at idx 0", async () => {
  const { store, runtime } = setup();
  const session = await runtime.openSession({ agent: "assistant", scope, trigger: "interactive" });
  const messages = await store.listMessages(session.id, scope);
  expect(messages[0]!.message).toEqual({ role: "system", content: "You are assistant.\n\n<clock>12:00</clock>" });
});

test("onSessionOpen fires once a session is open, with the agent and the open extra, and is awaited", async () => {
  const seen: Array<{ id: string; agent: string; extra: unknown; primed: boolean }> = [];
  const { store, runtime } = setup({
    hooks: {
      onSessionOpen: async ({ session, agent, scope: s, extra }) => {
        // The row exists and the system prompt is frozen by the time the hook runs.
        const primed = (await store.listMessages(session.id, s)).some((m) => m.idx === 0);
        seen.push({ id: session.id, agent: agent.id, extra, primed });
      },
    },
  });
  const session = await runtime.openSession({ agent: "assistant", scope, trigger: "interactive", extra: { root: "wt/1" } });
  expect(seen).toEqual([{ id: session.id, agent: "assistant", extra: { root: "wt/1" }, primed: true }]);
});

test("claimSession fires onSessionOpen only when it actually claims", async () => {
  const opened: string[] = [];
  const { store, runtime } = setup({ hooks: { onSessionOpen: ({ session }) => { opened.push(session.id); } } });
  const first = await runtime.claimSession({ agent: "assistant", scope, trigger: "cron" });
  expect(await runtime.claimSession({ agent: "assistant", scope, trigger: "wake" })).toBeNull(); // busy: no second open
  expect(opened).toEqual([first!.id]);
});

test("closeSession moves the lifecycle to closed and fires onSessionClose once", async () => {
  const closed: Array<{ id: string; extra: unknown }> = [];
  const { store, runtime } = setup({ hooks: { onSessionClose: ({ session, extra }) => { closed.push({ id: session.id, extra }); } } });
  const session = await runtime.openSession({ agent: "assistant", scope, trigger: "interactive" });

  const after = await runtime.closeSession(session, scope, { root: "wt/1" });
  expect(after.lifecycle).toBe("closed");
  expect((await store.getSession(session.id, scope))!.lifecycle).toBe("closed");
  expect(closed).toEqual([{ id: session.id, extra: { root: "wt/1" } }]);

  // A second close is a no-op: the lifecycle did not change, so no second teardown.
  await runtime.closeSession(after, scope);
  expect(closed).toHaveLength(1);
});

test("runTurn answers, persists the transcript and the usage, and finishes", async () => {
  const { store, runtime } = setup();
  const session = await runtime.openSession({ agent: "assistant", scope, trigger: "cron" });
  const result = await runtime.runTurn(session, { content: "hola", model: stubModel(), ref, extra: {} });

  expect(result.summary).toBe("echo: hola");
  expect(result.finishReason).toBe("stop");
  const messages = await store.listMessages(session.id, scope);
  expect(messages.map((m) => m.message.role)).toEqual(["system", "user", "assistant"]);

  const after = (await store.getSession(session.id, scope))!;
  expect(after.status).toBe("finished");
  expect(after.summary).toBe("echo: hola");
  expect(after.usage.tokensOut).toBe(4);
  expect(after.model).toBe("stub");
  const turns = await store.listTurnUsage(session.id, scope);
  expect(turns.map((t) => [t.turn, t.provider])).toEqual([[1, "stub"]]);
});

test("runTurn runs a tool call across two steps and records it", async () => {
  const { store, runtime } = setup();
  const session = await runtime.openSession({ agent: "helper", scope, trigger: "cron" });
  const result = await runtime.runTurn(session, { content: 'TOOLCALL greet {"name":"ada"}', model: stubModel(), ref, extra: {} });

  expect(result.summary).toBe("done");
  const calls = await store.listToolCalls(session.id, scope);
  expect(calls).toHaveLength(1);
  expect(calls[0]).toMatchObject({ toolName: "greet", input: { name: "ada" }, output: { type: "text", value: "hi ada" } });
  // The user message at idx 1, then the assistant tool-call, its result, and the final text.
  const roles = (await store.listMessages(session.id, scope)).map((m) => m.message.role);
  expect(roles).toEqual(["system", "user", "assistant", "tool", "assistant"]);
});

test("a cut reply is handed back, and the model recovers on the next prompt", async () => {
  const { store, runtime } = setup();
  const session = await runtime.openSession({ agent: "assistant", scope, trigger: "cron" });
  // The first reply is reasoning only (cut); the continue prompt is handed
  // back, and the stub answers it, so the turn finishes.
  const result = await runtime.runTurn(session, { content: "REASON", model: stubModel(), ref, extra: {} });
  expect(result.summary).toBe("echo: Continue from where you stopped.");
  const roles = (await store.listMessages(session.id, scope)).map((m) => m.message.role);
  expect(roles).toEqual(["system", "user", "assistant", "user", "assistant"]);
  expect((await store.getSession(session.id, scope))!.status).toBe("finished");
});

test("a multi-run turn bills every run, not just the last", async () => {
  const { store, runtime } = setup();
  const session = await runtime.openSession({ agent: "assistant", scope, trigger: "cron" });
  // The first reply is cut (reasoning only), so the turn runs generateText twice:
  // the cut run and the continue run. Each stub run outputs 4 tokens over one step.
  // The turn must bill BOTH — 8 out over 2 steps — not only the last run, which a
  // lost-usage slip (runToEnd handing back just its final result) reports as 4/1.
  await runtime.runTurn(session, { content: "REASON", model: stubModel(), ref, extra: {} });

  const after = (await store.getSession(session.id, scope))!;
  expect(after.usage.tokensOut).toBe(8);
  expect(after.usage.steps).toBe(2);
  const turns = await store.listTurnUsage(session.id, scope);
  expect(turns).toHaveLength(1);
  expect(turns[0]!.usage.tokensOut).toBe(8);
  expect(turns[0]!.usage.steps).toBe(2);
});

test("runTurn persists each step as it lands, not only at close", async () => {
  // listMessages reads the store at call time, so a snapshot taken when a step's
  // hook fires shows exactly what was persisted by that step.
  const snaps: Promise<number>[] = [];
  const { store, runtime } = setup({
    hooks: { onStepFinish: (session) => { snaps.push(store.listMessages(session.id, scope).then((m) => m.length)); } },
  });
  const session = await runtime.openSession({ agent: "helper", scope, trigger: "cron" });
  await runtime.runTurn(session, { content: 'TOOLCALL greet {"name":"ada"}', model: stubModel(), ref, extra: {} });

  // Two steps: step 1 (user's reply: assistant tool-call + tool result), step 2 (final text).
  // By the time step 1's hook fires, its messages are already stored — [system, user,
  // assistant, tool] is four. Persist-at-close would hold the store at [system, user]
  // until the whole turn ended, so the first snapshot would be two.
  const counts = await Promise.all(snaps);
  expect(counts[0]).toBeGreaterThanOrEqual(4);
});

test("runTurn records a tool call as its result lands, not only at close", async () => {
  const snaps: Promise<number>[] = [];
  const { store, runtime } = setup({
    hooks: { onStepFinish: (session) => { snaps.push(store.listToolCalls(session.id, scope).then((c) => c.length)); } },
  });
  const session = await runtime.openSession({ agent: "helper", scope, trigger: "cron" });
  await runtime.runTurn(session, { content: 'TOOLCALL greet {"name":"ada"}', model: stubModel(), ref, extra: {} });

  // The tool result lands in step 1, so its row is in the store by step 1's hook.
  // Recording only at finalize would leave the first snapshot at zero.
  const counts = await Promise.all(snaps);
  expect(counts[0]).toBe(1);
});

test("a provider failure ends the turn errored, classified, and calls the error hook", async () => {
  const errors: string[] = [];
  const { store, runtime } = setup({ hooks: { onError: (err) => { errors.push((err as Error).message); } } });
  const session = await runtime.openSession({ agent: "assistant", scope, trigger: "cron" });
  // 401 is not retried by the SDK (unlike 5xx/429), so the turn fails at once.
  await expect(runtime.runTurn(session, { content: "ERROR 401", model: stubModel(), ref, extra: {} })).rejects.toThrow();
  const after = (await store.getSession(session.id, scope))!;
  expect(after.status).toBe("errored");
  expect(after.finishReason).toBe("provider-down");
  expect(errors).toHaveLength(1);
});

test("streamTurn streams, persists, and resolves its done with the result", async () => {
  const { store, runtime } = setup();
  const session = await runtime.openSession({ agent: "assistant", scope, trigger: "interactive" });
  const { response, done } = runtime.streamTurn(session, { content: "hey", model: stubModel(), ref, extra: {} });
  const res = await response;
  expect(res.headers.get("x-session-id")).toBe(session.id);
  const result = await done;
  expect(result.summary).toBe("echo: hey");
  expect((await store.getSession(session.id, scope))!.status).toBe("finished");
  expect((await store.listMessages(session.id, scope)).map((m) => m.message.role)).toEqual(["system", "user", "assistant"]);
});

test("claimSession opens a session only while the agent is free", async () => {
  const { store, runtime } = setup();
  const first = await runtime.claimSession({ agent: "assistant", scope, trigger: "cron" });
  expect(first).not.toBeNull();
  // The agent is now running (idx 0 persisted, status running): a second claim is refused.
  expect(await runtime.claimSession({ agent: "assistant", scope, trigger: "wake" })).toBeNull();
  await store.finish(first!.id, scope, { status: "finished" });
  expect(await runtime.claimSession({ agent: "assistant", scope, trigger: "wake" })).not.toBeNull();
});

test("a second turn continues the conversation, history and all", async () => {
  const { store, runtime } = setup();
  const session = await runtime.openSession({ agent: "assistant", scope, trigger: "interactive" });
  await runtime.runTurn(session, { content: "first", model: stubModel(), ref, extra: {} });
  await runtime.runTurn(session, { content: "second", model: stubModel(), ref, extra: {} });
  const roles = (await store.listMessages(session.id, scope)).map((m) => m.message.role);
  expect(roles).toEqual(["system", "user", "assistant", "user", "assistant"]);
  const after = (await store.getSession(session.id, scope))!;
  expect(after.usage.steps).toBe(2);
  expect(await store.listTurnUsage(session.id, scope)).toHaveLength(2);
});
