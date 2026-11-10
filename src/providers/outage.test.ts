import { expect, test } from "bun:test";
import { APICallError } from "ai";
import { createOutageGate } from "./outage";

const api = (statusCode: number, message = "x") =>
  new APICallError({ message, url: "https://api.example.com", requestBodyValues: {}, statusCode });

const MIN = 60_000;

function gate(openSince: number | null = null) {
  const clock = { t: 10_000_000 };
  const events: string[] = [];
  const g = createOutageGate({
    now: () => clock.t,
    openSince,
    onOpen: (i) => events.push(`open:${i.reason}:${i.retryInMs / MIN}`),
    onBackoff: (i) => events.push(`backoff:${i.retryInMs / MIN}`),
    onClose: (i) => events.push(`close:${i.since}`),
  });
  return { g, clock, events };
}

test("nothing is paused until the provider fails", () => {
  const { g } = gate();
  expect(g.pausedForMs()).toBe(0);
  expect(g.isOpen()).toBe(false);
});

test("the first failure opens the outage and pauses a minute, once", () => {
  const { g, clock, events } = gate();
  g.down(api(402, "Insufficient Balance"));
  expect(g.isOpen()).toBe(true);
  expect(g.since()).toBe(clock.t);
  expect(g.pausedForMs()).toBe(MIN);
  // Runs already in flight fail inside the same pause: no further step.
  g.down(api(402));
  g.down(api(402));
  expect(g.pausedForMs()).toBe(MIN);
  expect(events).toEqual(["open:Insufficient Balance:1"]);
});

test("each failed try after the pause lapses backs off: 1, 5, 15, 30, 30 minutes", () => {
  const { g, clock, events } = gate();
  const waits: number[] = [];
  for (let i = 0; i < 5; i++) {
    g.down(api(503, "down"));
    waits.push(g.pausedForMs() / MIN);
    clock.t += g.pausedForMs();
  }
  expect(waits).toEqual([1, 5, 15, 30, 30]);
  expect(events).toEqual(["open:down:1", "backoff:5", "backoff:15", "backoff:30", "backoff:30"]);
});

test("a success closes the outage and says when it opened; a second success says nothing", () => {
  const { g, clock, events } = gate();
  const opened = clock.t;
  g.down(api(429));
  clock.t += 30_000;
  g.up();
  g.up();
  expect(g.isOpen()).toBe(false);
  expect(g.pausedForMs()).toBe(0);
  expect(events).toEqual(["open:x:1", `close:${opened}`]);
});

test("retryNow lets the next try go at once; a failure then backs off from where it was", () => {
  const { g, clock } = gate();
  g.down(api(500));
  g.retryNow();
  expect(g.pausedForMs()).toBe(0);
  g.down(api(500));
  expect(g.pausedForMs()).toBe(5 * MIN);
  void clock;
});

test("an outage open when the process starts is picked up and tried again after the first wait", () => {
  const { g, clock, events } = gate(9_000_000);
  expect(g.isOpen()).toBe(true);
  expect(g.since()).toBe(9_000_000);
  expect(g.pausedForMs()).toBe(MIN);
  clock.t += MIN;
  g.up();
  expect(events).toEqual(["close:9000000"]);
});
