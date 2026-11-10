import { expect, test } from "bun:test";
import { createTurnRegistry } from "./turns";

test("a close with no turn running has nothing to stop", async () => {
  const turns = createTurnRegistry();
  expect(await turns.abort("idle")).toBe("not-running");
  expect(turns.isRunning("idle")).toBe(false);
});

test("a close aborts the turn's signal and waits for it to unwind", async () => {
  const turns = createTurnRegistry();
  const handle = turns.begin("live");
  expect(turns.isRunning("live")).toBe(true);

  let sawAbort = false;
  const running = (async () => {
    try {
      await new Promise<void>((_, reject) => handle.signal.addEventListener("abort", () => reject(new Error("aborted"))));
    } catch {
      sawAbort = true;
      expect(turns.abortedByClose("live")).toBe(true);
      handle.settle();
    }
  })();

  expect(await turns.abort("live")).toBe("stopped");
  await running;
  expect(sawAbort).toBe(true);
  expect(turns.isRunning("live")).toBe(false);
});

test("a turn that will not stop is reported, not waited on forever", async () => {
  const turns = createTurnRegistry();
  const handle = turns.begin("stuck");
  expect(await turns.abort("stuck", 20)).toBe("still-running");
  expect(handle.signal.aborted).toBe(true);
  handle.settle();
});

test("two registries do not collide", async () => {
  const a = createTurnRegistry();
  const b = createTurnRegistry();
  a.begin("s");
  expect(a.isRunning("s")).toBe(true);
  expect(b.isRunning("s")).toBe(false);
});
