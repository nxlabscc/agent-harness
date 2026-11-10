import { generateText, stepCountIs, streamText, type LanguageModel, type ModelMessage, type ToolSet } from "ai";
import { tokensOfTools, type ContextBuilder, type StoredMessage, type TurnRequest } from "@nxlabscc/agent-context";
import { contextWindowOf, modelOf, type Catalog, type ModelRef } from "../providers/catalog";
import { classifyFailure } from "../providers/failure";
import { computeUsage } from "../providers/usage";
import type { AgentDefinition, AgentSource } from "../agents/types";
import type { ToolRegistry } from "../tools/registry";
import type { ToolEffect } from "../tools/types";
import type { Scope, Session, SessionStore } from "../store/types";
import { runToEnd, type RunResult } from "./continue";
import { createTurnRegistry, type TurnRegistry } from "./turns";
import type { RuntimeConfig } from "./config";

export type RuntimeProvider = {
  catalog: Catalog;
  /** Tokens a model without a declared window is assumed to accept. */
  windowFallback?: number;
};

export type RuntimeHooks<Extra> = {
  /**
   * A session opened: its row exists and its system prompt is frozen, before
   * its first turn. The place to set up a per-session resource — a git worktree,
   * a scratch directory — that `onSessionClose` tears down. Awaited, so the
   * resource is ready by the time `openSession`/`claimSession` resolves.
   */
  onSessionOpen?: (ctx: SessionContext<Extra>) => void | Promise<void>;
  /**
   * A session closed: `closeSession` moved its lifecycle to `closed`. The place
   * to tear down what `onSessionOpen` set up. Fires once: a session already
   * closed fires nothing.
   */
  onSessionClose?: (ctx: SessionContext<Extra>) => void | Promise<void>;
  /** Each step of a turn, with everything produced so far. */
  onStepFinish?: (session: Session, messages: ModelMessage[], ctx: TurnContext<Extra>) => void;
  /** The turn finished and was persisted. */
  afterTurn?: (result: TurnResult, ctx: TurnContext<Extra>) => void | Promise<void>;
  /** The turn errored. The place for a failure journal, an incident, a span. */
  onError?: (err: unknown, ctx: TurnContext<Extra>) => void | Promise<void>;
};

export type RuntimeOptions<Extra> = {
  store: SessionStore;
  agents: AgentSource;
  tools: ToolRegistry<Extra>;
  context: ContextBuilder;
  provider: RuntimeProvider;
  config: RuntimeConfig;
  hooks?: RuntimeHooks<Extra>;
  log?: (message: string, data?: Record<string, unknown>) => void;
};

export type OpenSessionInput<Extra> = {
  /** The agent's id, resolved through the `AgentSource`. */
  agent: string;
  scope: Scope;
  trigger: string;
  conversationId?: string | null;
  provider?: string | null;
  model?: string | null;
  meta?: Record<string, unknown>;
  /** Extra passed to `context.atOpen`. */
  extra?: Extra;
};

/** What a turn is run with. The model is already resolved by the project (keys, routing). */
export type TurnInput<Extra> = {
  /** This turn's user message(s). `content` is shorthand for one user message. */
  messages?: ModelMessage[];
  content?: string;
  /** The model, built with the caller's key, and the ref that prices and sizes it. */
  model: LanguageModel;
  ref: ModelRef;
  extra: Extra;
  /** Tools from outside the catalog for this session: an MCP server's. */
  extraTools?: ToolSet;
  extraEffects?: Record<string, ToolEffect>;
  maxSteps?: number;
};

/** What a session lifecycle hook is handed: the session, outside any one turn. */
export type SessionContext<Extra> = {
  session: Session;
  scope: Scope;
  agent: AgentDefinition;
  /** The `extra` from the call that opened or closed the session, when it gave one. */
  extra?: Extra;
};

export type TurnContext<Extra> = {
  session: Session;
  scope: Scope;
  agent: AgentDefinition;
  request: TurnRequest;
  extra: Extra;
};

export type TurnResult = {
  session: Session;
  finishReason: string | null;
  summary: string | null;
  messages: ModelMessage[];
};

export interface Runtime<Extra> {
  openSession(input: OpenSessionInput<Extra>): Promise<Session>;
  /** `openSession`, but only if the agent is free; null when it is busy. The queue-driven path. */
  claimSession(input: OpenSessionInput<Extra>): Promise<Session | null>;
  /**
   * Close a session: its lifecycle moves to `closed` and `onSessionClose` fires.
   * Returns the session as it now stands. Idempotent: a session already closed
   * changes nothing and fires nothing.
   */
  closeSession(session: Session, scope: Scope, extra?: Extra): Promise<Session>;
  /** A turn driven to its end with `generateText`: the automated path. */
  runTurn(session: Session, input: TurnInput<Extra>): Promise<TurnResult>;
  /** A streamed turn: the interactive path. `response` resolves to a UI message stream. */
  streamTurn(session: Session, input: TurnInput<Extra>): { response: Promise<Response>; done: Promise<TurnResult> };
  turns: TurnRegistry;
}

export function createRuntime<Extra>(opts: RuntimeOptions<Extra>): Runtime<Extra> {
  const { store, agents, tools, context, provider, config, hooks, log } = opts;
  const turns = createTurnRegistry();

  const loadAgent = async (id: string, scope: Scope): Promise<AgentDefinition> => {
    const agent = await agents.load(id, scope);
    if (agent === null) throw new Error(`agent '${id}' not found`);
    return agent;
  };

  /** The system prompt — the persona plus the context's open blocks — persisted frozen at idx 0. */
  async function persistSystemPrompt(session: Session, agent: AgentDefinition, scope: Scope): Promise<Session> {
    const blocks = (await context.atOpen?.({ scope, sessionId: session.id, agent: agent.id, systemPrompt: agent.systemPrompt })) ?? [];
    const system = [agent.systemPrompt, ...blocks].map((s) => s.trim()).filter((s) => s.length > 0).join("\n\n");
    await store.appendMessage(session.id, scope, 0, { role: "system", content: system });
    return session;
  }

  const newSession = (agent: AgentDefinition, input: OpenSessionInput<Extra>) => ({
    scope: input.scope,
    agent: agent.id,
    trigger: input.trigger,
    conversationId: input.conversationId ?? null,
    provider: input.provider ?? null,
    model: input.model ?? null,
    meta: input.meta,
  });

  async function openSession(input: OpenSessionInput<Extra>): Promise<Session> {
    const agent = await loadAgent(input.agent, input.scope);
    const session = await store.createSession(newSession(agent, input));
    const primed = await persistSystemPrompt(session, agent, input.scope);
    await hooks?.onSessionOpen?.({ session: primed, scope: input.scope, agent, extra: input.extra });
    return primed;
  }

  // Opens a session only if the agent has no automated session running in that
  // scope; null when it is busy. The one-session-per-agent path a queue-driven
  // worker takes: on null it waits and asks again. The claim is atomic, so two
  // workers cannot start the same agent at once.
  async function claimSession(input: OpenSessionInput<Extra>): Promise<Session | null> {
    const agent = await loadAgent(input.agent, input.scope);
    const session = await store.claimAgent(newSession(agent, input));
    if (session === null) return null;
    const primed = await persistSystemPrompt(session, agent, input.scope);
    await hooks?.onSessionOpen?.({ session: primed, scope: input.scope, agent, extra: input.extra });
    return primed;
  }

  // Close a session and fire the teardown hook, but only on the transition:
  // `setLifecycle` reports whether it changed, so a second close — a retried
  // worker, a double wire — tears nothing down twice.
  async function closeSession(session: Session, scope: Scope, extra?: Extra): Promise<Session> {
    const changed = await store.setLifecycle(session.id, scope, "closed");
    const updated = (await store.getSession(session.id, scope)) ?? session;
    if (changed) {
      const agent = await loadAgent(updated.agent, scope);
      await hooks?.onSessionClose?.({ session: updated, scope, agent, extra });
    }
    return updated;
  }

  /** The shared setup both turn paths run before they call the model. */
  async function prepare(session: Session, input: TurnInput<Extra>) {
    const scope: Scope = { tenantId: session.tenantId };
    const agent = await loadAgent(session.agent, scope);
    const stored = await store.listMessages(session.id, scope);
    const system = (stored.find((m) => m.idx === 0)?.message.content as string | undefined) ?? agent.systemPrompt;
    const history = stored.filter((m) => m.idx > 0);

    const ctx = { scope, sessionId: session.id, agent, ...(input.extra as Extra) };
    const toolSet = tools.build(agent.tools, ctx, { extra: input.extraTools, extraEffects: input.extraEffects });

    const freshUser = input.messages ?? (input.content !== undefined ? [{ role: "user", content: input.content } as ModelMessage] : []);
    let idx = await store.nextIdx(session.id, scope);
    for (const message of freshUser) await store.appendMessage(session.id, scope, idx++, message);

    const window = contextWindowOf(provider.catalog, input.ref, provider.windowFallback);
    const toolTokens = tokensOfTools(toolSet);
    const query = lastUserText(freshUser);

    const request: TurnRequest = {
      scope, sessionId: session.id, conversationId: session.conversationId, agent: agent.id,
      system, query, history, fresh: [...freshUser], window, toolTokens,
    };

    // Blocks for this turn go after the user message, so the cached prefix holds.
    const blocks = (await context.beforeTurn?.(request)) ?? [];
    const blockMessages: ModelMessage[] = [];
    for (const block of blocks) {
      const message: ModelMessage = { role: "system", content: block.content };
      if (block.persist) await store.appendMessage(session.id, scope, idx++, message);
      blockMessages.push(message);
      request.fresh.push(message);
    }

    const firstAssistantIdx = idx;
    const prepared = (await context.prepareMessages?.(request)) ?? { history, report: {} };
    const sendMessages = [...prepared.history.map((m) => m.message), ...freshUser, ...blockMessages];

    const prices = modelOf(provider.catalog, input.ref);
    const turnContext: TurnContext<Extra> = { session, scope, agent, request, extra: input.extra };
    return { scope, agent, system, toolSet, request, sendMessages, firstAssistantIdx, prices, ctx, turnContext };
  }

  type Prepared = Awaited<ReturnType<typeof prepare>>;
  type TotalUsage = { inputTokens?: number; outputTokens?: number; inputTokenDetails?: { cacheReadTokens?: number; noCacheTokens?: number } } | undefined;

  /** Record the tool calls of a turn from its persisted messages, pairing each result with its call's input and idx. */
  async function recordToolCalls(session: Session, scope: Scope, persisted: StoredMessage[]): Promise<void> {
    const calls = new Map<string, { input: unknown; idx: number; toolName: string }>();
    for (const { idx, message } of persisted) {
      if (!Array.isArray(message.content)) continue;
      for (const part of message.content) {
        const p = part as { type?: string; toolCallId?: string; toolName?: string; input?: unknown };
        if (p.type === "tool-call" && p.toolCallId) calls.set(p.toolCallId, { input: p.input, idx, toolName: p.toolName ?? "" });
      }
    }
    for (const { message } of persisted) {
      if (message.role !== "tool" || !Array.isArray(message.content)) continue;
      for (const part of message.content) {
        const p = part as { type?: string; toolCallId?: string; toolName?: string; output?: unknown };
        if (p.type !== "tool-result") continue;
        const call = p.toolCallId ? calls.get(p.toolCallId) : undefined;
        await store.recordToolCall(scope, {
          sessionId: session.id,
          messageIdx: call?.idx ?? persisted[0]?.idx ?? 0,
          toolName: p.toolName ?? call?.toolName ?? "",
          input: call?.input,
          output: p.output,
          durationMs: 0,
        });
      }
    }
  }

  /** Usage, cost, the finish, the tool calls, and the after-turn hooks. The messages are already persisted. */
  async function finalize(
    session: Session, p: Prepared, input: TurnInput<Extra>,
    persisted: StoredMessage[], totalUsage: TotalUsage, finishReason: string | null, steps: number,
  ): Promise<TurnResult> {
    const { scope, firstAssistantIdx, prices, request, turnContext } = p;
    const usage = computeUsage(prices, totalUsage ?? {}, steps);
    await store.addUsage(session.id, scope, usage);
    await store.recordTurnUsage(scope, {
      sessionId: session.id, turn: firstAssistantIdx - 1, provider: input.ref.provider, model: input.ref.model, usage,
    });
    await recordToolCalls(session, scope, persisted);

    const messages = persisted.filter((m) => m.idx >= firstAssistantIdx).map((m) => m.message);
    const summary = summaryOf(messages);
    await store.finish(session.id, scope, { status: "finished", finishReason, summary, provider: input.ref.provider, model: input.ref.model });

    const result: TurnResult = { session, finishReason, summary, messages };
    await context.afterTurn?.(request, { messages, history: (await store.listMessages(session.id, scope)).filter((x) => x.idx > 0) });
    await hooks?.afterTurn?.(result, turnContext);
    return result;
  }

  async function handleError(session: Session, p: Prepared, err: unknown): Promise<void> {
    const failure = classifyFailure(err);
    try {
      await store.finish(session.id, p.scope, { status: "errored", finishReason: failure.kind, summary: failure.message });
    } catch (e) {
      log?.("failed to mark session errored", { session: session.id, error: String(e) });
    }
    await hooks?.onError?.(err, p.turnContext);
  }

  async function runTurn(session: Session, input: TurnInput<Extra>): Promise<TurnResult> {
    const p = await prepare(session, input);
    const maxSteps = input.maxSteps ?? config.maxSteps.run;
    const handle = turns.begin(session.id);
    // Persist across runs: a cut-reply continue or a wrap-up runs generateText
    // again, and each run's response.messages starts over. The accumulator and
    // the growing idx keep every message, in order.
    const persisted: StoredMessage[] = [];
    let nextIdx = p.firstAssistantIdx;
    const appendPersisted = async (message: ModelMessage) => {
      await store.appendMessage(session.id, p.scope, nextIdx, message);
      persisted.push({ idx: nextIdx, message });
      nextIdx++;
    };
    try {
      const run = async (messages: ModelMessage[], steps: number) => {
        const result = await generateText({
          model: input.model,
          system: p.system,
          messages,
          tools: p.toolSet,
          abortSignal: handle.signal,
          stopWhen: stepCountIs(steps),
          prepareStep: ({ steps: done, messages: msgs }) => context.prepareStep?.({ steps: done, messages: msgs }, p.request),
          onStepFinish: (step) => hooks?.onStepFinish?.(session, step.response.messages, p.turnContext),
        });
        // Persist this run's messages once it has resolved, so persistence is
        // awaited and ordered rather than racing an un-awaited step hook.
        for (const message of result.response.messages) await appendPersisted(message);
        return result;
      };

      const result = await runToEnd(
        [...p.sendMessages],
        maxSteps,
        run as (messages: ModelMessage[], steps: number) => Promise<RunResult>,
        appendPersisted,
        { continueOnCut: config.continueOnCut, wrapUp: config.wrapUp },
      );
      const r = result as unknown as { totalUsage?: TotalUsage; finishReason?: string; steps: unknown[] };
      return await finalize(session, p, input, persisted, r.totalUsage, r.finishReason ?? null, r.steps.length);
    } catch (err) {
      if (turns.abortedByClose(session.id)) {
        await store.finish(session.id, p.scope, { status: "finished", finishReason: "closed", summary: "Turn stopped: the session was closed." });
        return { session, finishReason: "closed", summary: null, messages: [] };
      }
      await handleError(session, p, err);
      throw err;
    } finally {
      handle.settle();
    }
  }

  function streamTurn(session: Session, input: TurnInput<Extra>): { response: Promise<Response>; done: Promise<TurnResult> } {
    const handle = turns.begin(session.id);
    let settleDone!: (r: TurnResult) => void;
    let rejectDone!: (e: unknown) => void;
    const done = new Promise<TurnResult>((resolve, reject) => { settleDone = resolve; rejectDone = reject; });

    const responsePromise = (async (): Promise<Response> => {
      const p = await prepare(session, input);
      const result = streamText({
        model: input.model,
        system: p.system,
        messages: p.sendMessages,
        tools: p.toolSet,
        abortSignal: handle.signal,
        stopWhen: stepCountIs(input.maxSteps ?? config.maxSteps.stream),
        prepareStep: ({ steps, messages }) => context.prepareStep?.({ steps, messages }, p.request),
        onStepFinish: (step) => hooks?.onStepFinish?.(session, step.response.messages, p.turnContext),
        onError: ({ error }) => {
          if (turns.abortedByClose(session.id)) {
            void store.finish(session.id, p.scope, { status: "finished", finishReason: "closed", summary: "Turn stopped: the session was closed." });
            settleDone({ session, finishReason: "closed", summary: null, messages: [] });
            return;
          }
          void handleError(session, p, error).finally(() => rejectDone(error));
        },
        onFinish: ({ response, totalUsage, finishReason, steps }) => {
          void (async () => {
            const persisted: StoredMessage[] = [];
            let idx = p.firstAssistantIdx;
            for (const message of response.messages) {
              await store.appendMessage(session.id, p.scope, idx, message);
              persisted.push({ idx, message });
              idx++;
            }
            return finalize(session, p, input, persisted, totalUsage as TotalUsage, finishReason ?? null, steps.length);
          })().then(settleDone, rejectDone);
        },
      });
      // Drive the turn server-side so it finishes even if the client disconnects.
      void result.consumeStream();
      return result.toUIMessageStreamResponse({ headers: { "x-session-id": session.id } });
    })();

    responsePromise.catch(rejectDone);
    void done.finally(() => handle.settle());

    // `response` resolves to the UI message stream; a prepare failure rejects
    // it, and `done` carries the turn's own outcome. The caller awaits both.
    return { response: responsePromise, done };
  }

  return { openSession, claimSession, closeSession, runTurn, streamTurn, turns };
}

function lastUserText(messages: ModelMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]!.role === "user") return textOf(messages[i]!.content);
  }
  return "";
}

function summaryOf(messages: ModelMessage[]): string | null {
  const last = messages[messages.length - 1];
  if (!last || last.role !== "assistant") return null;
  const text = textOf(last.content).trim();
  return text.length > 0 ? text.slice(0, 2000) : null;
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  let out = "";
  for (const part of content) {
    const p = part as { type?: string; text?: unknown };
    if (p?.type === "text") out += String(p.text ?? "");
  }
  return out;
}

export type { StoredMessage };
