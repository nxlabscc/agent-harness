// The turns executing right now, so a close can actually stop one.
//
// The turn loop is an await inside the SDK with a step cap: a close that only
// writes a row and tears down the session's workspace never reaches the model,
// which keeps asking for steps against a workspace pulled out from under it. A
// turn registers its AbortController here while it runs; a close aborts it,
// waits for it to unwind, and only then does the caller tear anything down.
//
// Per instance, not module-global: a process can run two runtimes without their
// turns colliding.

export type TurnHandle = {
  signal: AbortSignal;
  /** Call from the turn's `finally`, or a close waits out the grace for a turn that already ended. */
  settle: () => void;
};

export type AbortOutcome = "not-running" | "stopped" | "still-running";

export interface TurnRegistry {
  begin(sessionId: string): TurnHandle;
  isRunning(sessionId: string): boolean;
  /** True when this session's turn was cut short by a close, not by a failure. */
  abortedByClose(sessionId: string): boolean;
  /** Stop a session's turn and wait for it to unwind, up to `graceMs`. */
  abort(sessionId: string, graceMs?: number): Promise<AbortOutcome>;
}

export function createTurnRegistry(): TurnRegistry {
  const running = new Map<string, { controller: AbortController; done: Promise<void>; abortedByClose: boolean }>();

  return {
    begin(sessionId) {
      const controller = new AbortController();
      let settle!: () => void;
      const done = new Promise<void>((resolve) => { settle = resolve; });
      running.set(sessionId, { controller, done, abortedByClose: false });
      return {
        signal: controller.signal,
        settle: () => {
          running.delete(sessionId);
          settle();
        },
      };
    },
    isRunning: (sessionId) => running.has(sessionId),
    abortedByClose: (sessionId) => running.get(sessionId)?.abortedByClose ?? false,
    async abort(sessionId, graceMs = 30_000) {
      const turn = running.get(sessionId);
      if (!turn) return "not-running";
      turn.abortedByClose = true;
      turn.controller.abort(new Error(`session ${sessionId} closed`));
      const stopped = await Promise.race([
        turn.done.then(() => true),
        new Promise<boolean>((r) => setTimeout(() => r(false), graceMs)),
      ]);
      return stopped ? "stopped" : "still-running";
    },
  };
}
