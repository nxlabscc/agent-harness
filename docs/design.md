# @nxlabscc/agent-harness — design

The requirements, the ideas, and their implementation.

The library is one of the `agent-*` family, alongside `@nxlabscc/agent-message-queue`,
`@nxlabscc/agent-memory` and `@nxlabscc/agent-context`, and follows their shape: Bun, TypeScript source
with no build step, `exports` pointing at `src/*.ts`, Apache-2.0, consumed as a git dependency pinned
by tag, `bun test`, a backend that ships plus a contract any other backend must pass. English for
code, comments and docs.

## 1. What the library is

**The turn and its persistence.** The harness knows how to open a session, run one turn of an LLM
agent against its tools, persist the transcript and the cost, and stop. It knows how to build the
tool set a session gets from the agent's allowlist, and how to describe that tool set to the model.
It knows how to keep a long turn inside the model's context window.

**Everything else is plugged in by the project that uses it.** Who the agents are (`AgentSource`),
what starts a session (the project's HTTP routes, or a worker over its own message queue), which
tools exist (`ToolFactory`s the project registers), what goes into the context beyond the persona
(`ContextBuilder`), what model answers (`Catalog` + `Router`), and what the world does with a
finished turn (hooks). The harness integrates no library: memory and messaging are wired by the app
from these generic slots (section 4f), not bundled or imported.

Two consequences that are decisions, not defaults:

- **The harness implements no tool that touches the world.** File system, shell, HTTP, web search,
  MCP servers are tools a project registers. The harness owns the registry, the per-agent access
  control, the middleware every tool passes through, and how tools reach the system prompt. A
  deployment that must stay unable to write files is guaranteed that by the harness having no file
  tool.
- **Context assembly is its own package.** One deployment builds context linearly (base files,
  persona, skills, a state file, a clock); another builds it proactively (memory recall before every
  call, pruning and trimming between turns). The strategy has to be swappable without touching the
  loop, so it lives in `@nxlabscc/agent-context` and the harness only calls it.

## 2. Decisions

| # | decision | consequence |
|---|---|---|
| D1 | The harness integrates no library. It exposes generic slots; whoever instantiates it connects the parts. Memory and messaging are wired by the app, not bundled. | No `./memory` or `./queue` adapters, and the harness imports neither sibling. Memory is a reactor plus tools over the store's `marks`; messaging is a send tool plus a worker the app writes that claims a session and runs a turn (`claimSession`). Section 4f. |
| D2 | Context assembly is its own package in two layers: the base `@nxlabscc/agent-context` is the `ContextBuilder` interface and the mechanism (`compose`, `reactor`, the token utilities); the concrete strategies are style subpackages, `./linear` (fixed context + compaction) and `./windowed` (pruning + trimming). The harness depends on the base and calls it at five moments. | The harness defines no context type of its own; section 4 shows the calls. An app imports the style it wants, or the individual reactions to mix its own. |
| D3 | The library creates its own tables and nothing else. A project that adopts it adapts its existing data on its side. | No import API. Section 6 says what the schema promises so a project can write to it. |
| D4 | v0.1 is the whole core: store, agents, providers, tools, runtime, MCP. There are no adapters to build. | Section 7 is the order inside v0.1, not a release plan. |
| D5 | Tenant is always a string. A single-tenant deployment passes a fixed one. | One branch in SQL and in isolation tests. |
| D6 | Agents are an interface. One deployment reads a table, another a roster plus files. | The library ships `AgentSource`, the frontmatter parser and the prompt composer; the sources stay in the apps. |
| D7 | Tools are interfaces; each app registers its own. Access control, middleware and how tools reach the system prompt are the harness's. | No `fs`, `shell`, `http`, `web` tools in the library. They stay in the app. |
| D8 | Package, repo and folder: `agent-harness`. | `@nxlabscc/agent-harness`, `github:nxlabscc/agent-harness`. |
| D9 | Step limits and the texts around them (continue, wrap-up) come from the app, in code or in a harness config file. The library carries no text of its own. | `RuntimeConfig`, loadable from JSON; the prompts are required fields, and a runtime without them refuses to start. |
| D10 | The MCP client is part of the library. It is a client of a protocol and knows nothing about the server it connects to. | `./mcp` entry: list tools once per session, expose them as dynamic tools, read `readOnlyHint` as the tool's effect. |
| D11 | The harness offers the registry for tools and for skills. Where a skill's body comes from (a file, a blob in a database) is a loader the app provides. | `SkillSource` interface; the registry merges a skill's grants into the agent's allowlist and renders the `<skills>` block; `load_skill` is a harness tool over `SkillSource`. |

## 3. Modules and entry points

```
@nxlabscc/agent-harness            runtime, SessionStore (interface), agents, providers, tools and skills registry
@nxlabscc/agent-harness/sqlite     SessionStore on bun:sqlite — the backend that ships
@nxlabscc/agent-harness/contract   contract tests for another SessionStore
@nxlabscc/agent-harness/mcp        MCP client: tools of the configured servers, listed once per session, exposed as dynamic tools
@nxlabscc/agent-harness/testing    a stub LanguageModel (echo, TOOLCALL, ERROR, REASON) and static sources
```

There is no `./memory` or `./queue` entry: the harness integrates neither sibling. What a memory or
a messaging deployment needs is wired by the app from the generic slots the harness already exposes
(section 4f).

`@nxlabscc/agent-context` is a dependency. `ai` and `zod` are peer dependencies. `@ai-sdk/deepseek`,
`@ai-sdk/anthropic`, `@ai-sdk/openai-compatible` are optional peers: the catalog names a protocol,
the app installs the SDK for the protocols it uses.

Nothing is installed on the host. Typecheck and tests run inside the shared toolchain image,
`ghcr.io/nxlabscc/bun-builder`, as the README says.

## 4. Interfaces

### 4a. Scope and agents

```ts
type Scope = { tenantId: string };                       // D5

type AgentDefinition = {
  id: string; name: string; description: string | null;
  model: string | null;        // "provider/model", or null: the tier decides
  tier: string | null;
  tools: string[];             // the allowlist, by tool name
  skills: string[];
  systemPrompt: string;        // composed: base + --- + body (+ what the ContextBuilder adds at open)
  home: string | null;         // the agent's directory, when it has one
  frontmatter: Record<string, unknown>;   // everything else it declared, for the app
};

interface AgentSource { load(id: string, scope: Scope): Promise<AgentDefinition | null> }

parseFrontmatter(raw: string): { frontmatter: Record<string, unknown>; body: string }   // inline and block lists
composePrompt(parts: { base: string[]; body: string }): string
```

The library ships one frontmatter parser and the prompt composer. A roster reader or an agents table
becomes an app's `AgentSource`.

### 4b. Session store

```ts
type Session = {
  id: string; tenantId: string; agent: string; conversationId: string | null;
  trigger: string;                          // "interactive" | "automated" | project-defined
  status: "running" | "finished" | "errored";
  lifecycle: "open" | "closed" | "sleeping";
  startedAt: number; endedAt: number | null;
  finishReason: string | null; summary: string | null; title: string | null;
  provider: string | null; model: string | null;
  usage: { tokensIn; tokensOut; cacheHit; cacheMiss; costUsd; steps };
  meta: Record<string, unknown>;            // the app's own fields (a commit sha, a purpose, a schedule id, …)
};

interface SessionStore {
  createSession(input): Session;  getSession(id, scope): Session | null;  listSessions(filter, scope): Session[];
  setStatus(id, status); setLifecycle(id, lifecycle); finish(id, { status, finishReason, summary, provider?, model? });
  setTitle(id, title); setMeta(id, patch);
  appendMessage(sessionId, idx, message: ModelMessage); listMessages(sessionId): StoredMessage[]; nextIdx(sessionId): number;
  addUsage(sessionId, delta); recordTurnUsage(row); recordToolCall(row);
  busyAgent(agent, scope): Session | null;            // running, not interactive, not closed
  claimAgent(input): Session | null;                  // createSession only if busyAgent is null, atomically
  marks: { get(scope, key): unknown; set(scope, key, value): void };   // extraction marks, shown facts, crawl state
}
```

Every method is async in the interface, so a backend over a wire fits; the SQLite one answers at once.
`claimAgent` is the atomic claim an app's queue worker needs: one running automated session per
agent, the check and the insert in one step. The runtime pairs it with persisting the system prompt
as `claimSession` (section 4e). `createSession` stays open for every other way a session starts (a
person, a socket); an app that wants the invariant for those too claims there as well.

`conversationId` is a grouping key on the session; the library has no `conversations` table. An app
whose UI groups sessions into a thread keeps that thread's title and close time in its own table,
keyed by the same id.

The SQLite backend owns its migrations (forward-only SQL files applied at open, as the sibling
libraries do). `contract` exercises the interface, including tenant isolation, against any backend.

### 4c. Providers

```ts
type Catalog = Record<string, { protocol: "deepseek" | "anthropic" | "openai"; baseURL?: string; models: Record<string, Model> }>;
type Model = { cacheHitInput: number; cacheMissInput: number; output: number;   // USD per million tokens
               context?: number; tiers?: string[]; vision?: boolean };

loadCatalog(json: unknown): Catalog
modelFor(catalog, declared: { provider; model }, opts: { apiKey: string; fetch?: typeof fetch; middleware?: LanguageModelMiddleware[] }): LanguageModel
computeUsage(catalog, declared, usage): Usage
contextWindow(catalog, declared): number            // 32k when the catalog is silent
classifyFailure(err: unknown): "provider-down" | "run"   // 401/402/429/5xx or unreachable after the SDK's retries
createOutageGate({ backoffMs: number[]; onOpen?; onClose? }): { down(err); up(); pausedForMs(): number }

interface Router { readonly name: string; choose(request: RouteRequest, available: Available): Decision | null }
byTier: Router                                       // explicit model wins; else cheapest at or above the tier
```

Hardcoded prices and windows become a catalog entry. A heuristic router is another `Router`; a paid
fallback is `fetch` middleware plus the `onModelChanged` callback the runtime exposes for billing.
Both stay in the app that needs them.

### 4d. Tools

```ts
type ToolContext<Extra = {}> = { scope: Scope; sessionId: string; agent: AgentDefinition } & Extra;
type ToolFactory<Extra> = (ctx: ToolContext<Extra>) => Tool;        // Tool is the `ai` SDK's
type ToolMiddleware = (name: string, tool: Tool, ctx: ToolContext) => Tool;

createToolRegistry<Extra>({
  tools: Record<string, Tool | ToolFactory<Extra>>,
  alwaysOn?: string[],                 // granted to every agent whatever its allowlist
  effects?: Record<string, "ro" | "rw">,
  middleware?: ToolMiddleware[],       // guardResultSize({ maxChars, spill }), traceTool(tracer) ship with the library
  unguarded?: string[],                // tools whose result is instruction and passes whole
}).build(allowlist: string[], ctx: ToolContext<Extra>): ToolSet
```

The registry drops unknown names with a log line, applies the allowlist, adds the always-on set, wraps
everything. `guardResultSize` is the overflow spill: a result past the cap goes to a file the app
names and the model gets a pointer with a preview. How the app reads that file back is its own tool.

Skills (D11) go through the same registry. A skill is `{ name, description, tools: string[],
shellPatterns: string[] }` plus a body the model loads on demand:

```ts
interface SkillSource { spec(name: string): Promise<SkillSpec | null>; body(name: string): Promise<string | null> }
registry.grantsFor(agent: AgentDefinition): Promise<{ tools: string[]; shellPatterns: string[] }>   // agent's + each declared skill's
skillsBlock(specs: SkillSpec[]): string              // the <skills> index that rides in the system prompt
loadSkillTool(source: SkillSource): ToolFactory      // returns the body whole; it is instruction, so it is unguarded
```

A file-backed `SkillSource` reads `skills/<name>/SKILL.md`; a deployment that keeps skills in a
database writes another.

`./mcp` (D10) is a tool source rather than a tool: `listMcpTools(servers, auth)` asks each server
once, at session open, and the list is frozen in the session's `meta`; `mcpTools(defs, auth)` wraps
each as a dynamic tool with the server's own name, description and input schema, and reads
`readOnlyHint` as its effect. Which servers, and what header authenticates a call, come from the app
per session. MCP tools join the set before the allowlist is applied; whether they bypass the
allowlist is a registry option.

### 4e. Runtime

```ts
createRuntime<Extra>({
  store: SessionStore; agents: AgentSource; tools: ToolRegistry<Extra>; context: ContextBuilder;
  provider: { catalog: Catalog; modelFor; computeUsage; contextWindow; classifyFailure };
  config?: RuntimeConfig;                         // D9; from code or loadRuntimeConfig(path)
  hooks?: { onSessionOpen?; onSessionClose?; onStepFinish?; onToolCall?; afterTurn?; onError?; onModelChanged? };
  log?; tracer?;
})

runtime.openSession({ agent: string; scope; trigger; conversationId?; meta?; extra }): Promise<Session>
    // loads the agent, composes the prompt + context.atOpen, persists idx 0, fires onSessionOpen
runtime.claimSession(input): Promise<Session | null>
    // openSession, but only if the agent is free; null when it is busy — the queue-driven path
runtime.closeSession(session, scope, extra?): Promise<Session>
    // lifecycle -> closed, fires onSessionClose; idempotent, so a second close tears nothing down twice

runtime.streamTurn(session, { content | messages; model; ref; extra; onText?; maxSteps? })
    : { response: Promise<Response>; done: Promise<TurnResult> }
    // streamText; UI message stream response with x-session-id; consumeStream server-side; persists in onFinish

runtime.runTurn(session, { content | messages; model; ref; extra; maxSteps? })
    : Promise<TurnResult>
    // generateText; persists every step as it lands; re-prompts on a cut reply, wrap-up budget at the limit

runtime.turns: { abort(sessionId, reason: string): Promise<void>; isRunning(sessionId): boolean }
    // one registry of running turns, so a close cuts the stream and the loop settles as "closed", not "errored"

type RuntimeConfig = {
  maxSteps: { run: number; stream: number };         // an automated run gets more; an interactive stream fewer
  continueOnCut: { prompt: string; times: number };  // the prompt is the app's (D9)
  wrapUp: { prompt: string; steps: number };         // idem
};
```

Every field is required. `loadRuntimeConfig(path)` validates the file and names the field that is
missing or out of range; the library ships no prompt text, so an app cannot run on words it did not
choose.

The caller resolves the model (its keys, its routing) and passes the built `model` plus the `ref`
(`provider/model`) that prices and sizes it. Error handling is one path for both modes: `turns`
knows whether the abort was a close; `classifyFailure` says whether the provider or the run failed;
`finish` records `finishReason` accordingly; `hooks.onError` gets the rest (a failure journal, an
incident, a span). The store raises nothing: incidents and notifications are the app's, in the hook.

The session has its own bracket: `onSessionOpen` fires once the row exists and idx 0 is frozen,
`onSessionClose` fires when `closeSession` moves the lifecycle to `closed`. A per-session resource an
app sets up and tears down — a git worktree the turn runs inside, a scratch directory — hangs off
these two. `onSessionOpen` is awaited, so the resource is ready before the first turn; `onSessionClose`
fires only on the transition, so a retried worker closing twice tears down once. The turn itself runs
wherever the app put it: the runtime passes `extra` through to the tool context, so a tool reads the
session's working tree from there rather than a process-wide ambient.

### 4f. Wiring memory and messaging (the app's job)

The harness integrates neither sibling library. It exposes generic slots, and whoever instantiates
the harness connects `@nxlabscc/agent-memory` and `@nxlabscc/agent-message-queue` into them. Nothing
memory- or messaging-specific lives in the harness. `src/runtime/wiring.test.ts` is the worked proof
of both.

**Memory** is a reactor plus tools, over the store's generic `marks`:

- Recall before a turn is a `reactor({ beforeTurn })` the app writes, closing over its opened
  `@nxlabscc/agent-memory`. It calls `memory.recall(tenantId, agent, query)`, dedups against what the
  session has shown (`store.marks`), and returns the block. The app composes it into its context.
- Extraction after a turn is a `reactor({ afterTurn })`, or the app's own scheduler; the "how far
  extracted" watermark is a `store.marks` key, which is also the floor `trimWindow` reads.
- `remember`, `search_memory`, `get_sources` are tools the app registers in the tool registry,
  closing over its memory and reading `tenantId`/`agent` from the `ToolContext`.

An agent with no memory registers none of this; the harness neither knows nor cares.

**Messaging** is a send tool plus a worker the app writes:

- Sending is a tool: `send_message(to, text)` the app registers, whose execute enqueues onto its
  `@nxlabscc/agent-message-queue`. The harness ships no such tool.
- Receiving is the app's wiring: a worker claims the oldest message, calls
  `runtime.claimSession({ agent, scope, trigger })` (one running automated session per agent, atomic,
  null when busy — then it waits and asks again), runs `runtime.runTurn(session, { content, model,
  ref })`, and acks. A scheduler, wakes and a shutdown drain are the same shape: the app drives the
  queue and the runtime; the harness provides `claimSession`, `runTurn`, the `sleeping` lifecycle and
  the session store.

## 5. Configuration

`RuntimeConfig` comes from code or from a JSON file the app points at (`loadRuntimeConfig(path)`),
validated on load with a clear error per field. The provider catalog is a second JSON file. The
library reads no environment variables: whatever it needs is passed when it is created, so an app
can open two runtimes with different settings in one process and tests need no preload.

## 6. The schema and what it promises (D3)

The library owns its tables and applies its own forward-only migrations when the SQLite store opens,
the way the sibling libraries create their own. It creates nothing else and reads nothing else: an
app's existing tables are invisible to it.

What the library promises, so an app can adapt its data on its side: the tables are documented in the
README with their columns; `meta` is a JSON object the library stores and returns without reading, so
anything an app's old schema had as a column has a place; `tenant_id` is a plain string; session and
message ids are the caller's strings, so an app that keeps its old ids keeps its links. How an app
moves its history into those tables, or leaves it where it is, is its own cutover.

## 7. Order of work inside v0.1 (D4)

0. [done] `@nxlabscc/agent-context` v0.1: base (`ContextBuilder`, `compose`, `reactor`, `tokensOfTools`) + the `./linear` and `./windowed` style subpackages.
1. [done] `store` interface, SQLite backend, contract tests; `agents` (parser, composer, `AgentSource`).
2. [done] `providers`: catalog, `modelFor`, `computeUsage`, `contextWindow`, `classifyFailure`, outage gate, `Router` + `byTier`.
3. [done] `tools`: registry, allowlist, `guardResultSize`, `traceTool`, skills (`SkillSource`, grants, block, `load_skill`); `mcp` client.
4. [done] `runtime`: `openSession`, `claimSession`, `streamTurn`, `runTurn`, `turns`, config loading, the context calls; `testing` with the stub model.
5. [done] Wiring proof: `wiring.test.ts` shows memory (recall reactor + tools over `marks`) and messaging (send tool + `claimSession`/`runTurn` worker) wired from the generic slots, with nothing memory- or queue-specific in the harness. The core is complete; there are no adapters to build.
6. An app integrates it in its own repo against a tag.

Each step lands with unit tests next to the code; the stub model in `testing` (echo, `TOOLCALL <tool>
<json>`, `ERROR <status>`, `REASON`) drives a whole turn with no network.

## 8. Open points

- **The reusable memory wiring's home.** Each app writes its own recall reactor and memory tools
  today (section 4f). If two apps end up writing the same glue over `@nxlabscc/agent-memory`, it could
  become a small separate package they both import — never part of the harness, which stays agnostic.
  Left open until a second consumer needs it.
