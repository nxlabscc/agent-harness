import { generateText, stepCountIs, streamText, type LanguageModel, type ModelMessage, type ToolSet } from "ai";
import { tokensOfTools, type ContextBuilder, type StoredMessage, type TurnRequest } from "@nxlabscc/agent-context";
import { contextWindowOf, modelOf, type Catalog, type ModelRef } from "../providers/catalog";
import { classifyFailure } from "../providers/failure";
import { computeUsage } from "../providers/usage";
import type { AgentDefinition, AgentSource } from "../agents/types";
import type { ToolRegistry } from "../tools/registry";
import type { ToolEffect } from "../tools/types";
import { ZERO_USAGE, type Scope, type Session, type SessionStore, type Usage } from "../store/types";
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

  /**
   * Tool-call instrumentation: a timing wrap for the tool set, and a per-message
   * sink for the tool_calls table that share one call-id map.
   *
   * `wrap` times each tool's `execute` by its call id. `record`, fed each message
   * as it is persisted, writes a tool call once its result lands — pairing the
   * result with its call's input, the idx of the message that made the call, the
   * message a failed tool returned, and the time the tool took. Driven per
   * message so the tool_calls table fills through the turn, the same as the
   * transcript, rather than all at once at its close.
   */
  function toolInstrumentation(session: Session, scope: Scope) {
    const calls = new Map<string, { input: unknown; idx: number; toolName: string }>();
    const durations = new Map<string, number>();

    const wrap = (toolSet: ToolSet): ToolSet => {
      const out: ToolSet = {};
      for (const [name, entry] of Object.entries(toolSet)) {
        const t = entry as { execute?: (args: unknown, opts: { toolCallId: string }) => unknown };
        if (typeof t.execute !== "function") { out[name] = entry; continue; }
        const execute = t.execute.bind(t);
        const timed = {
          ...entry,
          execute: async (args: unknown, opts: { toolCallId: string }) => {
            const start = Date.now();
            try {
              return await execute(args, opts);
            } finally {
              if (opts?.toolCallId) durations.set(opts.toolCallId, Date.now() - start);
            }
          },
        };
        out[name] = timed as unknown as typeof entry;
      }
      return out;
    };

    const record = async (idx: number, message: ModelMessage): Promise<void> => {
      if (Array.isArray(message.content)) {
        for (const part of message.content) {
          const p = part as { type?: string; toolCallId?: string; toolName?: string; input?: unknown };
          if (p.type === "tool-call" && p.toolCallId) calls.set(p.toolCallId, { input: p.input, idx, toolName: p.toolName ?? "" });
        }
      }
      if (message.role !== "tool" || !Array.isArray(message.content)) return;
      for (const part of message.content) {
        const p = part as { type?: string; toolCallId?: string; toolName?: string; output?: unknown };
        if (p.type !== "tool-result") continue;
        const call = p.toolCallId ? calls.get(p.toolCallId) : undefined;
        await store.recordToolCall(scope, {
          sessionId: session.id,
          messageIdx: call?.idx ?? idx,
          toolName: p.toolName ?? call?.toolName ?? "",
          input: call?.input,
          output: p.output,
          error: toolError(p.output),
          durationMs: (p.toolCallId ? durations.get(p.toolCallId) : undefined) ?? 0,
        });
      }
    };

    return { wrap, record };
  }

  /**
   * Bill a turn's accumulated usage: add it to the session's running total and
   * write its one turn_usage row. The single path both a finished turn and a
   * failed or closed one bill through, so a step the provider answered counts
   * however the turn ends, and the two cannot drift apart. A turn that ran no
   * step bills nothing, so neither leaves an empty row.
   */
  async function recordUsage(session: Session, p: Prepared, input: TurnInput<Extra>, usage: Usage): Promise<void> {
    if (usage.steps === 0) return;
    await store.addUsage(session.id, p.scope, usage);
    await store.recordTurnUsage(p.scope, {
      sessionId: session.id, turn: p.firstAssistantIdx - 1, provider: input.ref.provider, model: input.ref.model, usage,
    });
  }

  /**
   * Bill, finish, and run the after-turn hooks. `bill` is the turn's one biller,
   * idempotent, so a failure later caught and billed by the turn's error path
   * does not bill a second time. Tool calls were recorded as their results
   * landed, so there is nothing to catch up here.
   *
   * Past `store.finish` the turn is finished and billed. The after-turn hooks are
   * side effects of a finished turn, not part of it: a throw from `context.afterTurn`
   * or `hooks.afterTurn` is reported to `onError` and leaves the turn finished,
   * rather than re-billing it or turning it errored.
   */
  async function finalize(
    session: Session, p: Prepared, input: TurnInput<Extra>,
    persisted: StoredMessage[], bill: () => Promise<void>, finishReason: string | null,
  ): Promise<TurnResult> {
    const { scope, firstAssistantIdx, request, turnContext } = p;
    const messages = persisted.filter((m) => m.idx >= firstAssistantIdx).map((m) => m.message);
    const summary = summaryOf(messages);
    await bill();
    await store.finish(session.id, scope, { status: "finished", finishReason, summary, provider: input.ref.provider, model: input.ref.model });

    const result: TurnResult = { session, finishReason, summary, messages };
    try {
      await context.afterTurn?.(request, { messages, history: (await store.listMessages(session.id, scope)).filter((x) => x.idx > 0) });
      await hooks?.afterTurn?.(result, turnContext);
    } catch (err) {
      try {
        await hooks?.onError?.(err, turnContext);
      } catch (e) {
        log?.("after-turn hook and its onError both threw", { session: session.id, error: String(e) });
      }
    }
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
    const tooling = toolInstrumentation(session, p.scope);
    const toolSet = tooling.wrap(p.toolSet);
    const recordTool = tooling.record;
    const appendPersisted = async (message: ModelMessage) => {
      const at = nextIdx++;
      await store.appendMessage(session.id, p.scope, at, message);
      persisted.push({ idx: at, message });
      await recordTool(at, message);
    };
    // Usage and steps summed across every run of the turn. A cut-reply continue
    // or a wrap-up calls generateText again, and each run reports only its own
    // usage; runToEnd hands back the last run alone, so the totals are kept here
    // — otherwise a wrapped-up turn would bill only its wrap-up steps.
    let usage: Usage = ZERO_USAGE;
    // The turn's one biller: idempotent, so the error path can bill what ran
    // without billing again what finalize already did.
    let billed = false;
    const bill = async () => {
      if (billed) return;
      billed = true;
      await recordUsage(session, p, input, usage);
    };
    try {
      const run = async (messages: ModelMessage[], steps: number) => {
        // Persist each step's new messages as the step lands, so a turn in flight
        // shows its transcript instead of only its opening message, and a run cut
        // short keeps what it already produced. `response.messages` is cumulative,
        // so only the tail past what is stored is appended. The writes are chained
        // to stay ordered even if the SDK does not await the step hook, and the
        // chain is settled before the run returns.
        let persistedInRun = 0;
        let chain: Promise<void> = Promise.resolve();
        const flush = (cumulative: readonly ModelMessage[]): Promise<void> => {
          chain = chain.then(async () => {
            for (; persistedInRun < cumulative.length; persistedInRun++) await appendPersisted(cumulative[persistedInRun]!);
          });
          return chain;
        };
        const result = await generateText({
          model: input.model,
          system: p.system,
          messages,
          tools: toolSet,
          abortSignal: handle.signal,
          stopWhen: stepCountIs(steps),
          prepareStep: ({ steps: done, messages: msgs }) => context.prepareStep?.({ steps: done, messages: msgs }, p.request),
          onStepFinish: async (step) => {
            await flush(step.response.messages);
            // Bill per step, not per run: a run that throws never returns its
            // totalUsage, so the only place the steps it finished are counted is
            // here. Summing step.usage over a run equals its totalUsage, so a
            // run that completes bills the same as before.
            usage = addUsage(usage, computeUsage(p.prices, step.usage as TotalUsage ?? {}, 1));
            hooks?.onStepFinish?.(session, step.response.messages, p.turnContext);
          },
        });
        // Catch any tail the step hooks did not reach, then settle the chain.
        await flush(result.response.messages);
        return result;
      };

      const result = await runToEnd(
        [...p.sendMessages],
        maxSteps,
        run as (messages: ModelMessage[], steps: number) => Promise<RunResult>,
        appendPersisted,
        { continueOnCut: config.continueOnCut, wrapUp: config.wrapUp },
      );
      const r = result as unknown as { finishReason?: string };
      return await finalize(session, p, input, persisted, bill, r.finishReason ?? null);
    } catch (err) {
      // Bill the steps that ran before the failure, whichever way the turn ends.
      // Idempotent: a failure after finalize already billed does not bill twice.
      await bill();
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
      // Persist each step as it lands, the same as the automated path, so a
      // streamed turn's transcript fills in the store as it goes rather than only
      // at close. `response.messages` is cumulative; the chain keeps writes ordered.
      const persisted: StoredMessage[] = [];
      let streamIdx = p.firstAssistantIdx;
      let persistedInRun = 0;
      let chain: Promise<void> = Promise.resolve();
      const tooling = toolInstrumentation(session, p.scope);
      const toolSet = tooling.wrap(p.toolSet);
      const recordTool = tooling.record;
      // Summed per step so a stream that fails still bills the steps it ran; the
      // per-step sum equals the run's totalUsage, so a finished turn bills the same.
      let usage: Usage = ZERO_USAGE;
      let billed = false;
      const bill = async () => {
        if (billed) return;
        billed = true;
        await recordUsage(session, p, input, usage);
      };
      const flush = (cumulative: readonly ModelMessage[]): Promise<void> => {
        chain = chain.then(async () => {
          for (; persistedInRun < cumulative.length; persistedInRun++) {
            const message = cumulative[persistedInRun]!;
            const at = streamIdx++;
            await store.appendMessage(session.id, p.scope, at, message);
            persisted.push({ idx: at, message });
            await recordTool(at, message);
          }
        });
        return chain;
      };
      const result = streamText({
        model: input.model,
        system: p.system,
        messages: p.sendMessages,
        tools: toolSet,
        abortSignal: handle.signal,
        stopWhen: stepCountIs(input.maxSteps ?? config.maxSteps.stream),
        prepareStep: ({ steps, messages }) => context.prepareStep?.({ steps, messages }, p.request),
        onStepFinish: async (step) => {
          await flush(step.response.messages);
          usage = addUsage(usage, computeUsage(p.prices, step.usage as TotalUsage ?? {}, 1));
          hooks?.onStepFinish?.(session, step.response.messages, p.turnContext);
        },
        onError: ({ error }) => {
          // Bill the steps that ran before the failure, then finish — closed if a
          // close aborted the turn, errored otherwise.
          void (async () => {
            await bill();
            if (turns.abortedByClose(session.id)) {
              await store.finish(session.id, p.scope, { status: "finished", finishReason: "closed", summary: "Turn stopped: the session was closed." });
              settleDone({ session, finishReason: "closed", summary: null, messages: [] });
              return;
            }
            await handleError(session, p, error);
            rejectDone(error);
          })();
        },
        onFinish: ({ response, finishReason }) => {
          void (async () => {
            // Catch any tail the step hooks did not reach, then finalize on the
            // transcript the chain already persisted, billing the usage summed
            // per step above.
            await flush(response.messages);
            return finalize(session, p, input, persisted, bill, finishReason ?? null);
          })().then(settleDone, rejectDone);
        },
      });
      // Drive the turn server-side so it finishes even if the client disconnects.
      // A failure is delivered through `onError` above, which finishes the turn;
      // the drive promise itself is caught so its rejection is not left unhandled.
      // `consumeStream` returns a PromiseLike, so the rejection is taken on `then`.
      result.consumeStream().then(undefined, () => {});
      // The caller decides what a failed turn tells the client. The default
      // surfaces the error's own message; a deployment that must not leak it
      // passes `config.streamOnError` to replace it with a fixed string or an id.
      const formatStreamError = config.streamOnError ?? ((e: unknown) => (e instanceof Error ? e.message : String(e)));
      return result.toUIMessageStreamResponse({ headers: { "x-session-id": session.id }, onError: formatStreamError });
    })();

    responsePromise.catch(rejectDone);
    // Settle the turn handle when `done` settles, either way. The rejection is
    // handled here (the onRejected arm), so the caller still sees `done` reject
    // and handles its own copy, while this internal chain leaves none unhandled.
    void done.then(() => handle.settle(), () => handle.settle());

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

/** Sum two usage tallies field by field, so a multi-run turn bills the whole of it. */
function addUsage(a: Usage, b: Usage): Usage {
  return {
    tokensIn: a.tokensIn + b.tokensIn,
    tokensOut: a.tokensOut + b.tokensOut,
    cacheHit: a.cacheHit + b.cacheHit,
    cacheMiss: a.cacheMiss + b.cacheMiss,
    costUsd: a.costUsd + b.costUsd,
    steps: a.steps + b.steps,
  };
}

/**
 * The message a failed tool returned, or null for one that succeeded. AI SDK 6
 * turns a tool that throws into a `tool-result` whose output is an error part;
 * its value carries the message.
 */
function toolError(output: unknown): string | null {
  const o = output as { type?: string; value?: unknown } | undefined;
  if (!o || (o.type !== "error-text" && o.type !== "error-json")) return null;
  return typeof o.value === "string" ? o.value : JSON.stringify(o.value);
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
