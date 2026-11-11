// Regressions found running agent-harness 0.1.2 under Winterhold's agent-runtime.
// Each test states the expected behaviour; on 0.1.2 they fail.

import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { APICallError, tool } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { z } from "zod";
import { compose, reactor } from "@nxlabscc/agent-context";
import { loadCatalog } from "../providers/catalog";
import { createSqliteSessionStore } from "../store/sqlite";
import { createToolRegistry } from "../tools/registry";
import { staticAgentSource, stubModel, testAgent } from "../testing";
import { createRuntime, type Runtime } from "./runtime";

const scope = { tenantId: "t" };
const ref = { provider: "stub", model: "stub" };
const catalog = loadCatalog({
  stub: { protocol: "openai", baseURL: "http://stub", models: { stub: { context: 100_000, cacheHitInput: 0, cacheMissInput: 1, output: 2 } } },
});
const config = {
  maxSteps: { run: 100, stream: 8 },
  continueOnCut: { prompt: "Continue from where you stopped.", times: 2 },
  wrapUp: { prompt: "Wrap up.", steps: 15 },
};

// Raw V3 usage: 100 in, 4 out per model call.
const usage = {
  inputTokens: { total: 100, noCache: 100, cacheRead: 0, cacheWrite: undefined },
  outputTokens: { total: 4, text: 4, reasoning: undefined },
  raw: { totalTokens: 104 },
};
const finish = (r: string) => ({ unified: r, raw: r });

/** Step 1 calls `greet`; step 2 is whatever `second` does. */
function twoStepModel(second: (opts: { abortSignal?: AbortSignal }) => never | Promise<never>) {
  let call = 0;
  return new MockLanguageModelV3({
    doGenerate: async (opts: { abortSignal?: AbortSignal }) => {
      call++;
      if (call === 1) {
        return {
          content: [{ type: "tool-call", toolCallId: "c1", toolName: "greet", input: '{"name":"ada"}' }],
          finishReason: finish("tool-calls"), usage, warnings: [],
        };
      }
      return second(opts);
    },
  } as never);
}

function setup(onGreet?: () => Promise<void>) {
  const store = createSqliteSessionStore(new Database(":memory:"));
  const registry = createToolRegistry<unknown>({
    tools: {
      greet: () => tool({
        description: "greet", inputSchema: z.object({ name: z.string() }),
        execute: async ({ name }) => { await onGreet?.(); return `hi ${name}`; },
      }),
      boom: () => tool({
        description: "fails", inputSchema: z.object({}),
        execute: async (): Promise<string> => { await new Promise((r) => setTimeout(r, 30)); throw new Error("kaput"); },
      }),
    },
  });
  const runtime: Runtime<unknown> = createRuntime({
    store,
    agents: staticAgentSource({ helper: testAgent({ id: "helper", tools: ["greet", "boom"] }) }),
    tools: registry,
    context: compose(reactor({})),
    provider: { catalog },
    config,
  });
  return { store, runtime };
}

test("R1: a turn that errors after a completed step still bills that step", async () => {
  const { store, runtime } = setup();
  const session = await runtime.openSession({ agent: "helper", scope, trigger: "cron" });
  const model = twoStepModel(() => {
    throw new APICallError({ message: "stub error 401", url: "http://stub", requestBodyValues: {}, statusCode: 401 });
  });
  await expect(runtime.runTurn(session, { content: "go", model, ref, extra: {} })).rejects.toThrow();

  const after = (await store.getSession(session.id, scope))!;
  expect(after.status).toBe("errored");
  // Step 1 ran and the provider billed it: 100 in, 4 out.
  expect(after.usage.steps).toBeGreaterThanOrEqual(1);
  expect(after.usage.tokensOut).toBeGreaterThanOrEqual(4);
  expect(await store.listTurnUsage(session.id, scope)).toHaveLength(1);
});

test("R2: a turn aborted by closing its session still bills the steps it ran", async () => {
  let sessionId = "";
  let runtimeRef: Runtime<unknown> | null = null;
  const { store, runtime } = setup(async () => {
    // A human closes the session while the tool of step 1 runs.
    void runtimeRef!.turns.abort(sessionId, 0);
    await new Promise((r) => setTimeout(r, 10));
  });
  runtimeRef = runtime;
  const session = await runtime.openSession({ agent: "helper", scope, trigger: "cron" });
  sessionId = session.id;
  const model = twoStepModel(({ abortSignal }) => {
    const e = abortSignal?.reason ?? new Error("aborted");
    throw e;
  });
  const result = await runtime.runTurn(session, { content: "go", model, ref, extra: {} });
  expect(result.finishReason).toBe("closed");

  const after = (await store.getSession(session.id, scope))!;
  expect(after.usage.steps).toBeGreaterThanOrEqual(1);
  expect(after.usage.tokensOut).toBeGreaterThanOrEqual(4);
});

test("R3: a tool call row carries the tool's error and its duration", async () => {
  const { store, runtime } = setup();
  const session = await runtime.openSession({ agent: "helper", scope, trigger: "cron" });
  await runtime.runTurn(session, { content: "TOOLCALL boom {}", model: stubModel(), ref, extra: {} });

  const calls = await store.listToolCalls(session.id, scope);
  expect(calls).toHaveLength(1);
  expect(calls[0]!.error).toContain("kaput");
  expect(calls[0]!.durationMs).toBeGreaterThanOrEqual(25); // the tool slept 30 ms
});

test("R4: a streamed turn that fails sends the real error to the client", async () => {
  const { runtime } = setup();
  const session = await runtime.openSession({ agent: "helper", scope, trigger: "interactive" });
  const { response, done } = runtime.streamTurn(session, { content: "ERROR 401", model: stubModel(), ref, extra: {} });
  done.catch(() => {});
  const body = await (await response).text();
  expect(body).toContain("stub error 401");
  expect(body).not.toContain("An error occurred.");
});
