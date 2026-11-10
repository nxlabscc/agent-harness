import type { ModelMessage } from "ai";

// A run the harness drives alone ends on text, its summary. Two things can stop
// it short of that, and both are handed back rather than recorded as the end:
// a reply that holds only reasoning (no text, no tool call) was cut, and a run
// that spends its whole step budget stopped mid-work. The prompts for both are
// the project's; the harness carries none of its own.

export class CutReplyError extends Error {
  constructor(readonly times: number) {
    super(`the model's reply was cut off ${times} times in a row, before it acted`);
    this.name = "CutReplyError";
  }
}

/** A reply that holds only reasoning — no text, no tool call — was cut, not finished. */
export function isCutReply(messages: readonly { role: string; content: unknown }[]): boolean {
  const last = messages[messages.length - 1];
  if (!last || last.role !== "assistant") return false;
  if (typeof last.content === "string") return last.content.trim() === "";
  if (!Array.isArray(last.content)) return true;
  return !last.content.some((part) => {
    const p = part as { type?: string; text?: unknown };
    return (p?.type === "text" && String(p.text ?? "").trim() !== "") || p?.type === "tool-call";
  });
}

export type RunResult = { response: { messages: ModelMessage[] }; steps: unknown[]; finishReason?: string };
export type RunStep<R extends RunResult> = (messages: ModelMessage[], maxSteps: number) => Promise<R>;

export type ContinueOptions = {
  /** What a cut reply is handed back, and how many times before the run errors. */
  continueOnCut?: { prompt: string; times: number };
  /** What a run that spent its budget is told, and the extra steps it gets to close. */
  wrapUp?: { prompt: string; steps: number };
};

/**
 * Run the turn to its end.
 *
 * While the reply comes back cut, hand the model its own turn back with the
 * continue prompt; past the allowed times the run throws, so it is recorded as
 * the failure it is. When it spends all `maxSteps`, hand it the wrap-up prompt
 * once, with the extra steps to close. `persist` records each message the
 * harness adds.
 */
export async function runToEnd<R extends RunResult>(
  initial: ModelMessage[],
  maxSteps: number,
  run: RunStep<R>,
  persist: (message: ModelMessage) => void | Promise<void>,
  opts: ContinueOptions = {},
): Promise<R> {
  let history = initial;
  let budget = maxSteps;
  let cuts = 0;
  let wrapped = false;
  for (;;) {
    const result = await run(history, budget);
    let next: string | null = null;
    if (opts.continueOnCut && isCutReply(result.response.messages)) {
      cuts++;
      if (cuts > opts.continueOnCut.times) throw new CutReplyError(cuts);
      next = opts.continueOnCut.prompt;
    } else if (opts.wrapUp && !wrapped && result.steps.length >= budget) {
      wrapped = true;
      budget = opts.wrapUp.steps;
      next = opts.wrapUp.prompt;
    }
    if (next === null) return result;
    const message: ModelMessage = { role: "user", content: next };
    await persist(message);
    history = [...history, ...result.response.messages, message];
  }
}
