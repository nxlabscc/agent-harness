import { expect, test } from "bun:test";
import type { ModelMessage } from "ai";
import { CutReplyError, isCutReply, runToEnd, type RunResult } from "./continue";

const text = (t: string): ModelMessage => ({ role: "assistant", content: t });
const reasoningOnly: ModelMessage = { role: "assistant", content: [] };

test("a reply with no text and no tool call is a cut reply", () => {
  expect(isCutReply([text("done")])).toBe(false);
  expect(isCutReply([{ role: "assistant", content: [{ type: "tool-call", toolCallId: "c", toolName: "t", input: {} }] }])).toBe(false);
  expect(isCutReply([text("  ")])).toBe(true);
  expect(isCutReply([reasoningOnly])).toBe(true);
  expect(isCutReply([{ role: "user", content: "x" }])).toBe(false);
});

const result = (messages: ModelMessage[], steps: number): RunResult => ({ response: { messages }, steps: new Array(steps).fill(0) });

test("a run that ends on text returns at once", async () => {
  const seen: number[][] = [];
  const nudges: string[] = [];
  const r = await runToEnd(
    [{ role: "user", content: "go" }],
    10,
    async (messages, budget) => { seen.push([messages.length, budget]); return result([text("answer")], 1); },
    (m) => { nudges.push(String(m.content)); },
    { continueOnCut: { prompt: "continue", times: 2 }, wrapUp: { prompt: "wrap", steps: 3 } },
  );
  expect((r.response.messages[0] as ModelMessage).content).toBe("answer");
  expect(seen).toEqual([[1, 10]]);
  expect(nudges).toEqual([]);
});

test("a cut reply is handed back up to the limit, then the run errors", async () => {
  const prompts: string[] = [];
  await expect(
    runToEnd(
      [{ role: "user", content: "go" }],
      10,
      async () => result([reasoningOnly], 1),
      (m) => { prompts.push(String(m.content)); },
      { continueOnCut: { prompt: "keep going", times: 2 } },
    ),
  ).rejects.toThrow(CutReplyError);
  expect(prompts).toEqual(["keep going", "keep going"]);
});

test("a run that spends its budget gets the wrap-up prompt once, then its result stands", async () => {
  const budgets: number[] = [];
  const prompts: string[] = [];
  let call = 0;
  const r = await runToEnd(
    [{ role: "user", content: "go" }],
    5,
    async (_messages, budget) => { budgets.push(budget); call++; return call === 1 ? result([text("partial")], 5) : result([text("wrapped up")], 1); },
    (m) => { prompts.push(String(m.content)); },
    { wrapUp: { prompt: "write your pending tasks", steps: 2 } },
  );
  expect(budgets).toEqual([5, 2]);
  expect(prompts).toEqual(["write your pending tasks"]);
  expect((r.response.messages[0] as ModelMessage).content).toBe("wrapped up");
});

test("without a cut or wrap-up policy, the first result is returned whatever it is", async () => {
  const r = await runToEnd([{ role: "user", content: "go" }], 2, async () => result([reasoningOnly], 2), () => {});
  expect(r.response.messages).toEqual([reasoningOnly]);
});
