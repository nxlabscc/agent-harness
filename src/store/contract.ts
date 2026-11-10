import { describe, expect, test } from "bun:test";
import type { ModelMessage } from "ai";
import { INTERACTIVE, ZERO_USAGE, type Scope, type SessionStore } from "./types";

// What any session store must do. A backend's test file calls this with a
// factory; a Postgres backend added later runs these same cases. The factory
// receives the clock the store must stamp with, so time is moved, not waited for.

export type StoreFactory = (now: () => number) => SessionStore;

const A: Scope = { tenantId: "tenant-a" };
const B: Scope = { tenantId: "tenant-b" };

const usage = (n: number) => ({ tokensIn: n, tokensOut: n, cacheHit: 0, cacheMiss: n, costUsd: n / 1000, steps: 1 });

export function sessionStoreContract(name: string, make: StoreFactory): void {
  describe(`session store contract: ${name}`, () => {
    const setup = () => {
      const clock = { t: 1_000_000 };
      const store = make(() => clock.t);
      return { store, clock };
    };

    test("a session is created running and open, with what it was given", async () => {
      const { store, clock } = setup();
      const s = await store.createSession({
        scope: A, agent: "alice", trigger: "cron", conversationId: "c1",
        provider: "deepseek", model: "deepseek-v4-flash", meta: { purpose: "morning-run" },
      });
      expect(s.id).toHaveLength(26);
      expect(s).toMatchObject({
        tenantId: "tenant-a", agent: "alice", trigger: "cron", conversationId: "c1",
        status: "running", lifecycle: "open", startedAt: clock.t, endedAt: null,
        provider: "deepseek", model: "deepseek-v4-flash", usage: ZERO_USAGE, meta: { purpose: "morning-run" },
      });
      expect(await store.getSession(s.id, A)).toEqual(s);
    });

    test("the caller's id is kept when it gives one", async () => {
      const { store } = setup();
      const s = await store.createSession({ id: "my-own-id", scope: A, agent: "a", trigger: INTERACTIVE });
      expect(s.id).toBe("my-own-id");
    });

    test("a session of another tenant does not exist", async () => {
      const { store } = setup();
      const s = await store.createSession({ scope: A, agent: "a", trigger: INTERACTIVE });
      expect(await store.getSession(s.id, B)).toBeNull();
      expect(await store.listSessions(B)).toEqual([]);
      expect(await store.setLifecycle(s.id, B, "closed")).toBe(false);
      expect((await store.getSession(s.id, A))!.lifecycle).toBe("open");
      await expect(store.appendMessage(s.id, B, 0, { role: "system", content: "x" })).rejects.toThrow();
      expect(await store.listMessages(s.id, B)).toEqual([]);
      expect(await store.nextIdx(s.id, B)).toBe(0);
      await expect(store.recordToolCall(B, { sessionId: s.id, messageIdx: 1, toolName: "t", input: {}, durationMs: 1 })).rejects.toThrow();
      await expect(store.recordTurnUsage(B, { sessionId: s.id, turn: 1, provider: "p", model: "m", usage: usage(1) })).rejects.toThrow();
    });

    test("sessions list newest first, filtered, within the tenant", async () => {
      const { store, clock } = setup();
      const s1 = await store.createSession({ scope: A, agent: "a", trigger: "cron" });
      clock.t += 10;
      const s2 = await store.createSession({ scope: A, agent: "b", trigger: INTERACTIVE, conversationId: "c" });
      clock.t += 10;
      await store.createSession({ scope: B, agent: "a", trigger: "cron" });
      expect((await store.listSessions(A)).map((s) => s.id)).toEqual([s2.id, s1.id]);
      expect((await store.listSessions(A, { agent: "a" })).map((s) => s.id)).toEqual([s1.id]);
      expect((await store.listSessions(A, { trigger: INTERACTIVE })).map((s) => s.id)).toEqual([s2.id]);
      expect((await store.listSessions(A, { conversationId: "c" })).map((s) => s.id)).toEqual([s2.id]);
      expect((await store.listSessions(A, { since: s2.startedAt })).map((s) => s.id)).toEqual([s2.id]);
      expect((await store.listSessions(A, { limit: 1 })).map((s) => s.id)).toEqual([s2.id]);
      await store.finish(s1.id, A, { status: "errored", finishReason: "boom" });
      expect((await store.listSessions(A, { status: "errored" })).map((s) => s.id)).toEqual([s1.id]);
      await store.setLifecycle(s2.id, A, "closed");
      expect((await store.listSessions(A, { lifecycle: "closed" })).map((s) => s.id)).toEqual([s2.id]);
    });

    test("status, lifecycle and finish move the two axes apart", async () => {
      const { store, clock } = setup();
      const s = await store.createSession({ scope: A, agent: "a", trigger: INTERACTIVE });
      await store.setStatus(s.id, A, "finished");
      expect((await store.getSession(s.id, A))!.status).toBe("finished");
      expect((await store.getSession(s.id, A))!.lifecycle).toBe("open");

      expect(await store.setLifecycle(s.id, A, "sleeping")).toBe(true);
      expect(await store.setLifecycle(s.id, A, "sleeping")).toBe(false);

      clock.t += 500;
      await store.finish(s.id, A, { status: "errored", finishReason: "streamError", summary: "it broke" });
      const after = (await store.getSession(s.id, A))!;
      expect(after).toMatchObject({ status: "errored", finishReason: "streamError", summary: "it broke", endedAt: clock.t });
      expect(after.lifecycle).toBe("sleeping");
    });

    test("finish keeps the summary when none comes, and takes a provider and model when they do", async () => {
      const { store } = setup();
      const s = await store.createSession({ scope: A, agent: "a", trigger: INTERACTIVE, provider: "zen", model: "free" });
      await store.finish(s.id, A, { status: "finished", summary: "first" });
      await store.finish(s.id, A, { status: "finished", provider: "deepseek", model: "deepseek-v4-pro" });
      const after = (await store.getSession(s.id, A))!;
      expect(after.summary).toBe("first");
      expect(after.provider).toBe("deepseek");
      expect(after.model).toBe("deepseek-v4-pro");
    });

    test("the title is written once", async () => {
      const { store } = setup();
      const s = await store.createSession({ scope: A, agent: "a", trigger: INTERACTIVE });
      expect(await store.setTitle(s.id, A, "first")).toBe(true);
      expect(await store.setTitle(s.id, A, "second")).toBe(false);
      expect((await store.getSession(s.id, A))!.title).toBe("first");
    });

    test("meta merges one level deep and is returned as given", async () => {
      const { store } = setup();
      const s = await store.createSession({ scope: A, agent: "a", trigger: "cron", meta: { purpose: "p", nested: { a: 1 } } });
      await store.setMeta(s.id, A, { commitSha: "abc", nested: { b: 2 } });
      expect((await store.getSession(s.id, A))!.meta).toEqual({ purpose: "p", commitSha: "abc", nested: { b: 2 } });
    });

    test("messages keep their position and come back whole", async () => {
      const { store } = setup();
      const s = await store.createSession({ scope: A, agent: "a", trigger: INTERACTIVE });
      const system: ModelMessage = { role: "system", content: "you are a" };
      const user: ModelMessage = { role: "user", content: [{ type: "text", text: "héllo 'quoted' $5" }] };
      const tool: ModelMessage = {
        role: "tool",
        content: [{ type: "tool-result", toolCallId: "c1", toolName: "t", output: { type: "json", value: { ok: true } } }],
      };
      expect(await store.nextIdx(s.id, A)).toBe(0);
      await store.appendMessage(s.id, A, 0, system);
      await store.appendMessage(s.id, A, 1, user);
      await store.appendMessage(s.id, A, 2, tool);
      expect(await store.nextIdx(s.id, A)).toBe(3);
      expect(await store.listMessages(s.id, A)).toEqual([
        { idx: 0, message: system },
        { idx: 1, message: user },
        { idx: 2, message: tool },
      ]);
      await expect(store.appendMessage(s.id, A, 2, user)).rejects.toThrow();
    });

    test("usage adds up on the session, and each turn keeps its own row", async () => {
      const { store } = setup();
      const s = await store.createSession({ scope: A, agent: "a", trigger: INTERACTIVE });
      await store.addUsage(s.id, A, usage(100));
      await store.addUsage(s.id, A, usage(50));
      const total = (await store.getSession(s.id, A))!.usage;
      expect(total).toMatchObject({ tokensIn: 150, tokensOut: 150, cacheHit: 0, cacheMiss: 150, steps: 2 });
      expect(total.costUsd).toBeCloseTo(0.15, 10);

      await store.recordTurnUsage(A, { sessionId: s.id, turn: 1, provider: "zen", model: "free", usage: usage(100) });
      await store.recordTurnUsage(A, { sessionId: s.id, turn: 3, provider: "deepseek", model: "pro", usage: usage(50) });
      // The same turn again: the row is replaced, with the model that actually ran.
      await store.recordTurnUsage(A, { sessionId: s.id, turn: 1, provider: "deepseek", model: "flash", usage: usage(100) });
      const turns = await store.listTurnUsage(s.id, A);
      expect(turns.map((t) => [t.turn, t.provider, t.model])).toEqual([[1, "deepseek", "flash"], [3, "deepseek", "pro"]]);
      expect(turns[0]!.usage).toEqual(usage(100));
      expect(await store.listTurnUsage(s.id, B)).toEqual([]);
    });

    test("tool calls are recorded with their outcome", async () => {
      const { store } = setup();
      const s = await store.createSession({ scope: A, agent: "a", trigger: INTERACTIVE });
      await store.recordToolCall(A, { sessionId: s.id, messageIdx: 2, toolName: "read", input: { path: "x" }, output: "contents", durationMs: 12 });
      await store.recordToolCall(A, { sessionId: s.id, messageIdx: 2, toolName: "run", input: { cmd: "ls" }, error: "denied", durationMs: 3 });
      const calls = await store.listToolCalls(s.id, A);
      expect(calls).toHaveLength(2);
      expect(calls[0]).toMatchObject({ toolName: "read", input: { path: "x" }, output: "contents", error: null, durationMs: 12 });
      expect(calls[1]).toMatchObject({ toolName: "run", input: { cmd: "ls" }, output: undefined, error: "denied" });
      expect(await store.listToolCalls(s.id, B)).toEqual([]);
    });

    test("an agent is busy while an automated session of its runs, and only then", async () => {
      const { store } = setup();
      expect(await store.busyAgent("a", A)).toBeNull();

      const interactive = await store.createSession({ scope: A, agent: "a", trigger: INTERACTIVE });
      expect(await store.busyAgent("a", A)).toBeNull();                    // a person's session holds nothing

      const run = await store.createSession({ scope: A, agent: "a", trigger: "cron" });
      expect((await store.busyAgent("a", A))!.id).toBe(run.id);
      expect(await store.busyAgent("a", B)).toBeNull();                    // another tenant's agent of the same name
      expect(await store.busyAgent("b", A)).toBeNull();

      await store.setStatus(run.id, A, "finished");
      await store.setLifecycle(run.id, A, "sleeping");
      expect(await store.busyAgent("a", A)).toBeNull();                    // asleep between wakes holds nothing

      await store.setStatus(run.id, A, "running");
      expect((await store.busyAgent("a", A))!.id).toBe(run.id);
      await store.setLifecycle(run.id, A, "closed");
      expect(await store.busyAgent("a", A)).toBeNull();                    // closed holds nothing, whatever its status
      void interactive;
    });

    test("claimAgent starts the session only when the agent is free", async () => {
      const { store } = setup();
      const first = await store.claimAgent({ scope: A, agent: "a", trigger: "cron" });
      expect(first).not.toBeNull();
      expect(await store.claimAgent({ scope: A, agent: "a", trigger: "wake" })).toBeNull();
      expect(await store.claimAgent({ scope: B, agent: "a", trigger: "cron" })).not.toBeNull();   // other tenant
      await store.finish(first!.id, A, { status: "finished" });
      expect(await store.claimAgent({ scope: A, agent: "a", trigger: "wake" })).not.toBeNull();
    });

    test("sessions left running by a dead process end errored, across tenants", async () => {
      const { store, clock } = setup();
      const a = await store.createSession({ scope: A, agent: "a", trigger: "cron" });
      const b = await store.createSession({ scope: B, agent: "b", trigger: INTERACTIVE });
      const done = await store.createSession({ scope: A, agent: "c", trigger: "cron" });
      await store.finish(done.id, A, { status: "finished" });
      clock.t += 1;
      const failed = await store.failRunning({ finishReason: "interrupted", summary: "the process stopped mid-turn" });
      expect(failed.sort()).toEqual([a.id, b.id].sort());
      expect((await store.getSession(a.id, A))!).toMatchObject({ status: "errored", finishReason: "interrupted", summary: "the process stopped mid-turn", endedAt: clock.t });
      expect((await store.getSession(done.id, A))!.status).toBe("finished");
    });

    test("marks keep a value per tenant and key", async () => {
      const { store } = setup();
      expect(await store.marks.get(A, "extraction:c1")).toBeUndefined();
      await store.marks.set(A, "extraction:c1", { sessionId: "s", idx: 7 });
      await store.marks.set(A, "extraction:c1", { sessionId: "s", idx: 9 });
      expect(await store.marks.get(A, "extraction:c1")).toEqual({ sessionId: "s", idx: 9 });
      expect(await store.marks.get(B, "extraction:c1")).toBeUndefined();
      await store.marks.delete(A, "extraction:c1");
      expect(await store.marks.get(A, "extraction:c1")).toBeUndefined();
    });
  });
}
