import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { compose, reactor } from "@nxlabscc/agent-context";
import { loadCatalog } from "../providers/catalog";
import { createSqliteSessionStore } from "../store/sqlite";
import { createToolRegistry } from "../tools/registry";
import { staticAgentSource, stubModel, testAgent } from "../testing";
import { createRuntime } from "./runtime";

const scope = { tenantId: "t" };
const ref = { provider: "stub", model: "stub" };
const catalog = loadCatalog({
  stub: { protocol: "openai", baseURL: "http://stub", models: { stub: { context: 100_000, cacheHitInput: 0, cacheMissInput: 1, output: 2 } } },
});

test("R6: an afterTurn hook that throws does not bill the turn twice", async () => {
  const store = createSqliteSessionStore(new Database(":memory:"));
  const runtime = createRuntime({
    store,
    agents: staticAgentSource({ assistant: testAgent({ id: "assistant" }) }),
    tools: createToolRegistry<unknown>({ tools: {} }),
    context: compose(reactor({})),
    provider: { catalog },
    config: {
      maxSteps: { run: 100, stream: 8 },
      continueOnCut: { prompt: "Continue.", times: 2 },
      wrapUp: { prompt: "Wrap up.", steps: 15 },
    },
    hooks: { afterTurn: () => { throw new Error("hook failed"); } },
  });
  const session = await runtime.openSession({ agent: "assistant", scope, trigger: "cron" });
  await runtime.runTurn(session, { content: "hey", model: stubModel(), ref, extra: {} }).catch(() => {});

  const after = (await store.getSession(session.id, scope))!;
  const turns = await store.listTurnUsage(session.id, scope);
  // One step ran: the session total must equal the one turn row.
  expect(after.usage.steps).toBe(1);
  expect(after.usage.tokensOut).toBe(turns[0]!.usage.tokensOut);
});
