# @nxlabscc/agent-harness

The turn and its persistence for LLM agents, for Bun, in TypeScript source.

The harness opens a session, runs one turn of an agent against its tools over the `ai` SDK, persists
the transcript and the cost, and keeps a long turn inside the model's context window. It owns which
tools an agent may use and how they are described to the model. Everything that depends on the
product plugs in: who the agents are, what starts a session, which tools exist, what the context
holds beyond the persona, which model answers, and what happens to a finished turn.

The harness integrates no library. Memory ([`@nxlabscc/agent-memory`](https://github.com/nxlabscc/agent-memory))
and messaging ([`@nxlabscc/agent-message-queue`](https://github.com/nxlabscc/agent-message-queue)) are
wired in by the app from the harness's generic slots: memory is a recall reactor plus tools over the
store's `marks`, and messaging is a send tool plus a worker that claims a session and runs a turn.
The harness imports neither, and an app that needs neither uses neither.

**Status: the core is complete.** The interfaces, the module map, the decisions taken and the order
of work are in [`docs/design.md`](docs/design.md). Landed, with tests: the session store, the agent
definition, the providers, the tools and skills registry, the MCP client, the runtime, the test
stub, and a wiring proof that memory and messaging connect from the generic slots with nothing
library-specific in the harness. Next is each app adopting the library in its own repo.

## The session store

`SessionStore` is the interface; `createSqliteSessionStore(db)` from `@nxlabscc/agent-harness/sqlite`
is the backend that ships, and `sessionStoreContract` from `@nxlabscc/agent-harness/contract` is what
another backend runs to prove itself. Every method is async, and every method that addresses a
session takes the scope (`{ tenantId }`) too: a session of another tenant does not exist from where
the caller stands.

The SQLite backend creates its own tables when constructed and nothing else. A project that adopts
it moves its history in on its side; these are the tables, so it can:

| table | columns |
|---|---|
| `sessions` | `id`, `tenant_id`, `agent`, `conversation_id`, `trigger`, `status` (running, finished, errored), `lifecycle` (open, closed, sleeping), `started_at`, `ended_at`, `finish_reason`, `summary`, `title`, `provider`, `model`, `tokens_in`, `tokens_out`, `tokens_cache_hit`, `tokens_cache_miss`, `cost_usd`, `step_count`, `meta` (JSON the store never reads) |
| `messages` | `session_id`, `tenant_id`, `idx`, `role`, `message` (the SDK's `ModelMessage` as JSON), `created_at`; idx 0 is the system message |
| `turn_usage` | `session_id`, `tenant_id`, `turn` (idx of the message that opened it), `provider`, `model`, the five token and cost columns, `steps`, `created_at` |
| `tool_calls` | `session_id`, `tenant_id`, `message_idx`, `tool_name`, `input`, `output`, `error`, `duration_ms`, `created_at` |
| `marks` | `tenant_id`, `key`, `value` (JSON), `updated_at`: values an adapter keeps, an extraction mark or the facts a session has seen |

Timestamps are epoch milliseconds. Ids are the caller's strings, a ULID when the caller gives none.
`claimAgent` creates a session only if the agent has no automated session running in that scope, in
one atomic step; `createSession` always does.

## Agents

An agent is an `AgentSource` the project provides: `load(id, scope)` answers a definition or null.
The harness ships what a source needs to build one from an `AGENT.md`: `parseFrontmatter(raw)`
(scalars, inline and block lists, nested maps), `defineAgent({ id, raw, base, home })`, and
`composePrompt({ base, body, blocks })`, which joins the parts every agent shares, a rule, and the
agent's own body.

## Install

```json
"dependencies": {
  "@nxlabscc/agent-harness": "github:nxlabscc/agent-harness#v0.1.0"
}
```

Bun runs the `.ts` files as they are; there is no build step. `ai` and `zod` are peer dependencies;
the `@ai-sdk/*` package for each provider protocol the catalog names is installed by the project.

## Develop

Nothing is installed on the host: Bun runs inside the shared NxLabs toolchain image, the same one
the projects that consume this library build and test with.

```sh
docker run --rm -v "$PWD":/workspace -w /workspace ghcr.io/nxlabscc/bun-builder:1.4 \
  bash -c "bun install --frozen-lockfile && bun run typecheck"

docker run --rm -v "$PWD":/workspace -w /workspace ghcr.io/nxlabscc/bun-builder:1.4 \
  bash -c "bun install --frozen-lockfile && bun run test"
```

`bun install` without `--frozen-lockfile` is how `bun.lock` gets created or updated, locally.

## License

Apache-2.0

## Providers

The catalog is a JSON file the project reads and hands to `loadCatalog(json)`: providers by name,
each with a `protocol` (`deepseek`, `anthropic` or `openai`), a `baseURL`, and `models` with their
three prices in USD per million tokens (`cacheHitInput`, `cacheMissInput`, `output`), optional
`tiers` (`fast`, `balanced`, `quality`, `reasoning`), `vision`, `effort` and `context`. Keys starting
with `_` are comments; entries without a protocol are skipped. What would break a turn is refused
at load with the entry named.

- `modelFor(catalog, ref, { apiKey, fetch?, middleware? })` builds the model over the SDK for its
  protocol, loaded when first needed, so a project installs only the SDKs its catalog names.
  `retryUnparseable()` is a middleware that repeats a model call whose 2xx body did not parse;
  `fetchWithRetryNotice(notify)` is a `fetch` that reports the provider's consecutive retries.
- `computeUsage(prices, usage, steps)` splits input into cache hit and cache miss and prices it; a
  model without prices costs zero. `classifyFailure(err)` says whose a failure is: the provider's
  (`provider-down`: 401, 402, 429, 5xx or unreachable), an `unparseable` body, or the `run`'s.
- `createOutageGate({ backoffMs, onOpen, onBackoff, onClose, openSince })` holds whoever starts
  sessions while the provider cannot serve: a first failure pauses, each failed try after the pause
  backs off (1, 5, 15, then 30 minutes), a success closes it. `pausedForMs()` is what a queue's
  `gate` reads.
- `available(catalog, credentials)` is what a person can run: their own models when they have a
  key, the free ones on the system's key when they do not. `Router` is the policy that picks one
  for a request; `byTier()` ships: a named model wins, else the cheapest at or above the tier, never
  below. `sideModel(available, catalog)` is `fast` of the same tree, for background work.

## Tools and skills

Tools are the project's; the harness owns the registry, the per-agent access control, the middleware
every tool passes through, and how tools reach the system prompt. It implements no tool itself, so a
deployment that must not touch the file system registers no file tool.

- `createToolRegistry({ tools, alwaysOn?, effects?, middleware?, onUnknown? })`. `tools` maps a name
  to a tool or a factory `(ctx) => tool`. `build(allowlist, ctx, { extra?, extraBypassesAllowlist? })`
  returns the session's tool set: the extra tools (an MCP server's) first, the allowlisted catalog
  tools over them, the always-on set, everything wrapped by the middleware. `effectOf(name)` says
  whether a tool is `ro` or `rw`, for a memory that records action facts.
- `guardResultSize({ maxChars, spill?, skip? })` is a middleware: a result past the cap is replaced
  by a pointer with a head preview, and with a `spill` the whole result is persisted first and the
  pointer says where to read it back. `traceTool(tracer)` runs each tool's execute inside a span.
- Skills go through the same registry. `skillSpecFrom(name, raw)` reads a skill's frontmatter into
  `{ name, description, tools, shellPatterns }`; `grantsFor(agent, source)` folds each declared
  skill's tools and shell patterns into the agent's; `skillsBlock(specs)` renders the `<skills>`
  index for the prompt; `loadSkillTool(source)` is the tool that loads a body whole. A `SkillSource`
  (file, database) is the project's.

## MCP

`@nxlabscc/agent-harness/mcp` is a client of the protocol that knows nothing about any server.
`listMcpTools(servers, auth)` asks each server once, at session open, and the list is frozen with the
session; `mcpTools(defs, auth)` wraps each as a dynamic tool with the server's own name, description
and input schema; `mcpWriters(defs)` reads `readOnlyHint` as each tool's effect. The servers and the
`auth` that returns a call's headers are the project's.

## The runtime

`createRuntime({ store, agents, tools, context, provider, config, hooks? })` ties the pieces into a
turn. `provider` is `{ catalog }`; `config` is the `RuntimeConfig` (step limits and the continue and
wrap-up prompts), from code or `loadRuntimeConfig(json)`.

- `openSession({ agent, scope, trigger, conversationId?, meta?, extra? })` loads the agent through
  the `AgentSource`, appends the context's open blocks to the persona, and persists that as the
  frozen system message at idx 0. `claimSession(input)` is the same but opens the session only if the
  agent has no automated session running (atomic, null when busy) — the entry point an app's queue
  worker takes for one running session per agent.
- `runTurn(session, { content | messages, model, ref, extra, extraTools?, maxSteps? })` drives a turn
  to its end with `generateText`: the automated path. A cut reply is handed back with the continue
  prompt up to the configured times, and a run that spends its steps gets the wrap-up prompt once.
- `streamTurn(session, input)` returns `{ response, done }`: `response` resolves to a UI message
  stream carrying `x-session-id`, driven server-side so the turn finishes even if the client leaves;
  `done` resolves to the turn's result once persisted.
- The caller resolves the model (its keys, its routing) and passes the built `model` plus the `ref`
  (`provider/model`) that prices and sizes it. Each turn persists the transcript, splits and prices
  the usage onto the session and a per-turn row, records the tool calls, and finishes. A close
  through `runtime.turns.abort(sessionId)` cuts the stream and settles the turn as `closed`, not
  `errored`. `hooks` carry `onStepFinish`, `afterTurn` and `onError`, where a project writes a
  failure journal, an incident or a span.

## Wiring memory and messaging

The harness integrates neither sibling library; the app connects them from the slots above.
`src/runtime/wiring.test.ts` is the worked proof.

- **Memory** is a reactor plus tools. Recall before a turn is a `reactor({ beforeTurn })` the app
  writes, closing over its opened `@nxlabscc/agent-memory`, deduping against what the session has shown
  with `store.marks`, and returning a block it composes into its context. `remember`, `search_memory`
  and `get_sources` are tools the app registers, reading `tenantId`/`agent` from the `ToolContext`.
  An agent with no memory registers none of this.
- **Messaging** is a send tool plus a worker. Sending is a tool the app registers whose execute
  enqueues onto its `@nxlabscc/agent-message-queue`. Receiving is the app's loop: claim the oldest
  message, `claimSession({ agent, scope, trigger })` (null when the agent is busy, so wait and retry),
  `runTurn(session, { content, model, ref })`, ack. The scheduler, wakes and shutdown drain are the
  same shape over the queue, the `sleeping` lifecycle and the store.

## Testing

`@nxlabscc/agent-harness/testing` ships a stub `LanguageModel` that needs no network: it reads the last
user message for a directive (`TOOLCALL <tool> <json>`, `ERROR <status>`, `REASON`, else an echo), so
a test drives a whole turn. It also ships `staticAgentSource`, `testAgent` and `staticSkillSource`.
