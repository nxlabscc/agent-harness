// The session store: what the harness persists, and the interface any backend
// must offer. The SQLite backend ships (`@nxlabscc/agent-harness/sqlite`); another
// proves itself against `@nxlabscc/agent-harness/contract`.
//
// Every method is async so a backend over a wire fits. Every method that
// addresses a session takes the scope too: a session of another tenant does
// not exist from where the caller stands, and the backend enforces that in
// the query rather than trusting the id.

import type { ModelMessage } from "ai";
import type { Scope, StoredMessage } from "@nxlabscc/agent-context";

export type { Scope, StoredMessage };

/** How the current turn is going. */
export type SessionStatus = "running" | "finished" | "errored";

/** Whether the session takes more turns. A `sleeping` one re-enters on a wake. */
export type Lifecycle = "open" | "closed" | "sleeping";

/** The trigger a person's session carries. Sessions with any other trigger are automated. */
export const INTERACTIVE = "interactive";

export type Usage = {
  tokensIn: number;
  tokensOut: number;
  cacheHit: number;
  cacheMiss: number;
  costUsd: number;
  steps: number;
};

export const ZERO_USAGE: Usage = { tokensIn: 0, tokensOut: 0, cacheHit: 0, cacheMiss: 0, costUsd: 0, steps: 0 };

export type Session = {
  id: string;
  tenantId: string;
  agent: string;
  /** A grouping key the project gives: the thread a person sees, say. */
  conversationId: string | null;
  /** What started it: `interactive`, or whatever the project names its automated starts. */
  trigger: string;
  status: SessionStatus;
  lifecycle: Lifecycle;
  startedAt: number;
  endedAt: number | null;
  finishReason: string | null;
  summary: string | null;
  title: string | null;
  provider: string | null;
  model: string | null;
  usage: Usage;
  /** The project's own data about the session. Stored and returned without being read. */
  meta: Record<string, unknown>;
};

export type NewSession = {
  /** The caller's id, else a ULID. */
  id?: string;
  scope: Scope;
  agent: string;
  trigger: string;
  conversationId?: string | null;
  provider?: string | null;
  model?: string | null;
  meta?: Record<string, unknown>;
  startedAt?: number;
};

export type SessionFilter = {
  agent?: string;
  conversationId?: string;
  trigger?: string;
  status?: SessionStatus;
  lifecycle?: Lifecycle;
  /** Sessions started at or after this instant. */
  since?: number;
  /** Newest first. Default 50. */
  limit?: number;
};

export type FinishInput = {
  status: "finished" | "errored";
  finishReason?: string | null;
  /** Kept when null: an earlier summary stays. */
  summary?: string | null;
  /** The provider and model the turn ended on, when they changed mid-turn. */
  provider?: string | null;
  model?: string | null;
  endedAt?: number;
};

/** What one turn cost, with the model that actually answered it. */
export type TurnUsage = {
  sessionId: string;
  /** The idx of the message that opened the turn. Two turns of a session never share it. */
  turn: number;
  provider: string;
  model: string;
  usage: Usage;
  createdAt?: number;
};

export type ToolCall = {
  sessionId: string;
  messageIdx: number;
  toolName: string;
  input: unknown;
  output?: unknown;
  error?: string | null;
  durationMs: number;
  createdAt?: number;
};

export type Marks = {
  /** A value the project or an adapter keeps per tenant and key: an extraction mark, shown facts. */
  get(scope: Scope, key: string): Promise<unknown>;
  set(scope: Scope, key: string, value: unknown): Promise<void>;
  delete(scope: Scope, key: string): Promise<void>;
};

export interface SessionStore {
  createSession(input: NewSession): Promise<Session>;
  /**
   * `createSession`, only if the agent has no automated session running in that
   * scope; null otherwise. The check and the insert are one atomic step, so two
   * callers cannot both start the same agent.
   */
  claimAgent(input: NewSession): Promise<Session | null>;
  /** The automated session of this agent whose turn is running right now, if any. */
  busyAgent(agent: string, scope: Scope): Promise<Session | null>;

  getSession(id: string, scope: Scope): Promise<Session | null>;
  listSessions(scope: Scope, filter?: SessionFilter): Promise<Session[]>;

  setStatus(id: string, scope: Scope, status: SessionStatus): Promise<void>;
  /** True when the lifecycle changed. */
  setLifecycle(id: string, scope: Scope, lifecycle: Lifecycle): Promise<boolean>;
  finish(id: string, scope: Scope, input: FinishInput): Promise<void>;
  /** Set once: a title already there stays. True when it was written. */
  setTitle(id: string, scope: Scope, title: string): Promise<boolean>;
  /** Merges `patch` into the session's meta, one level deep. */
  setMeta(id: string, scope: Scope, patch: Record<string, unknown>): Promise<void>;

  appendMessage(sessionId: string, scope: Scope, idx: number, message: ModelMessage): Promise<void>;
  /** Every message of the session, oldest first, the system message at idx 0 included. */
  listMessages(sessionId: string, scope: Scope): Promise<StoredMessage[]>;
  nextIdx(sessionId: string, scope: Scope): Promise<number>;

  addUsage(sessionId: string, scope: Scope, delta: Usage): Promise<void>;
  recordTurnUsage(scope: Scope, row: TurnUsage): Promise<void>;
  listTurnUsage(sessionId: string, scope: Scope): Promise<TurnUsage[]>;
  recordToolCall(scope: Scope, row: ToolCall): Promise<void>;
  listToolCalls(sessionId: string, scope: Scope): Promise<ToolCall[]>;

  /**
   * Sessions left `running` by a process that died: nothing runs at boot, so
   * each belongs to a turn cut with its process. They end `errored` with the
   * reason given. Returns the ids. Across every tenant: it is the process's.
   */
  failRunning(input: { finishReason: string; summary: string }): Promise<string[]>;

  marks: Marks;
}
