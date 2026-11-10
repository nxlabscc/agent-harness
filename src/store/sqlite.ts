import type { Database } from "bun:sqlite";
import type { ModelMessage } from "ai";
import { ulid } from "../ulid";
import { applyMigrations } from "./migrations";
import {
  INTERACTIVE,
  type FinishInput,
  type Lifecycle,
  type Marks,
  type NewSession,
  type Scope,
  type Session,
  type SessionFilter,
  type SessionStatus,
  type SessionStore,
  type StoredMessage,
  type ToolCall,
  type TurnUsage,
  type Usage,
} from "./types";

// The SQLite backend. It owns its tables and creates them when constructed, so
// the same code runs against a project's database file and against `:memory:`
// in tests. The connection is the caller's: the harness opens none of its own.

type Row = {
  id: string;
  tenant_id: string;
  agent: string;
  conversation_id: string | null;
  trigger: string;
  status: SessionStatus;
  lifecycle: Lifecycle;
  started_at: number;
  ended_at: number | null;
  finish_reason: string | null;
  summary: string | null;
  title: string | null;
  provider: string | null;
  model: string | null;
  tokens_in: number;
  tokens_out: number;
  tokens_cache_hit: number;
  tokens_cache_miss: number;
  cost_usd: number;
  step_count: number;
  meta: string;
};

export type SqliteSessionStoreOptions = {
  /** The clock. Tests pass their own. */
  now?: () => number;
};

export function createSqliteSessionStore(db: Database, opts: SqliteSessionStoreOptions = {}): SessionStore {
  const now = opts.now ?? Date.now;
  applyMigrations(db);

  const toSession = (r: Row): Session => ({
    id: r.id,
    tenantId: r.tenant_id,
    agent: r.agent,
    conversationId: r.conversation_id,
    trigger: r.trigger,
    status: r.status,
    lifecycle: r.lifecycle,
    startedAt: r.started_at,
    endedAt: r.ended_at,
    finishReason: r.finish_reason,
    summary: r.summary,
    title: r.title,
    provider: r.provider,
    model: r.model,
    usage: {
      tokensIn: r.tokens_in,
      tokensOut: r.tokens_out,
      cacheHit: r.tokens_cache_hit,
      cacheMiss: r.tokens_cache_miss,
      costUsd: r.cost_usd,
      steps: r.step_count,
    },
    meta: JSON.parse(r.meta) as Record<string, unknown>,
  });

  const insert = db.prepare(
    `INSERT INTO sessions (id, tenant_id, agent, conversation_id, trigger, status, lifecycle, started_at, provider, model, meta)
     VALUES (?, ?, ?, ?, ?, 'running', 'open', ?, ?, ?, ?) RETURNING *`,
  );
  const byId = db.prepare("SELECT * FROM sessions WHERE id = ? AND tenant_id = ?");
  const busy = db.prepare(
    `SELECT * FROM sessions
      WHERE tenant_id = ? AND agent = ? AND trigger != ? AND lifecycle != 'closed' AND status = 'running'
      ORDER BY started_at DESC LIMIT 1`,
  );

  const insertSession = (input: NewSession): Session => {
    const row = insert.get(
      input.id ?? ulid(now()),
      input.scope.tenantId,
      input.agent,
      input.conversationId ?? null,
      input.trigger,
      input.startedAt ?? now(),
      input.provider ?? null,
      input.model ?? null,
      JSON.stringify(input.meta ?? {}),
    ) as Row;
    return toSession(row);
  };

  const busyAgent = (agent: string, scope: Scope): Session | null => {
    const row = busy.get(scope.tenantId, agent, INTERACTIVE) as Row | undefined;
    return row ? toSession(row) : null;
  };

  // BEGIN IMMEDIATE takes the write lock before the check, so a second
  // connection cannot pass its own check between this check and this insert.
  const claim = db.transaction((input: NewSession): Session | null => {
    if (busyAgent(input.agent, input.scope) !== null) return null;
    return insertSession(input);
  });

  const mergeMeta = db.transaction((id: string, scope: Scope, patch: Record<string, unknown>): void => {
    const row = db.prepare("SELECT meta FROM sessions WHERE id = ? AND tenant_id = ?").get(id, scope.tenantId) as
      | { meta: string }
      | null;
    if (row == null) return;
    const merged = { ...(JSON.parse(row.meta) as Record<string, unknown>), ...patch };
    db.prepare("UPDATE sessions SET meta = ? WHERE id = ? AND tenant_id = ?").run(JSON.stringify(merged), id, scope.tenantId);
  });

  const marks: Marks = {
    async get(scope, key) {
      const row = db.prepare("SELECT value FROM marks WHERE tenant_id = ? AND key = ?").get(scope.tenantId, key) as
        | { value: string }
        | undefined;
      return row == null ? undefined : (JSON.parse(row.value) as unknown);
    },
    async set(scope, key, value) {
      db.prepare(
        `INSERT INTO marks (tenant_id, key, value, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(tenant_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      ).run(scope.tenantId, key, JSON.stringify(value ?? null), now());
    },
    async delete(scope, key) {
      db.prepare("DELETE FROM marks WHERE tenant_id = ? AND key = ?").run(scope.tenantId, key);
    },
  };

  return {
    async createSession(input) {
      return insertSession(input);
    },

    async claimAgent(input) {
      return claim.immediate(input);
    },

    async busyAgent(agent, scope) {
      return busyAgent(agent, scope);
    },

    async getSession(id, scope) {
      const row = byId.get(id, scope.tenantId) as Row | undefined;
      return row ? toSession(row) : null;
    },

    async listSessions(scope, filter: SessionFilter = {}) {
      const where: string[] = ["tenant_id = ?"];
      const args: (string | number)[] = [scope.tenantId];
      const eq = (column: string, value: string | number | undefined) => {
        if (value === undefined) return;
        where.push(`${column} = ?`);
        args.push(value);
      };
      eq("agent", filter.agent);
      eq("conversation_id", filter.conversationId);
      eq("trigger", filter.trigger);
      eq("status", filter.status);
      eq("lifecycle", filter.lifecycle);
      if (filter.since !== undefined) {
        where.push("started_at >= ?");
        args.push(filter.since);
      }
      args.push(filter.limit ?? 50);
      const rows = db
        .prepare(`SELECT * FROM sessions WHERE ${where.join(" AND ")} ORDER BY started_at DESC, id DESC LIMIT ?`)
        .all(...args) as Row[];
      return rows.map(toSession);
    },

    async setStatus(id, scope, status) {
      db.prepare("UPDATE sessions SET status = ? WHERE id = ? AND tenant_id = ?").run(status, id, scope.tenantId);
    },

    async setLifecycle(id, scope, lifecycle) {
      const res = db
        .prepare("UPDATE sessions SET lifecycle = ? WHERE id = ? AND tenant_id = ? AND lifecycle != ?")
        .run(lifecycle, id, scope.tenantId, lifecycle);
      return res.changes > 0;
    },

    async finish(id, scope, input: FinishInput) {
      db.prepare(
        `UPDATE sessions SET status = ?, ended_at = ?, finish_reason = ?,
                summary = COALESCE(?, summary), provider = COALESCE(?, provider), model = COALESCE(?, model)
          WHERE id = ? AND tenant_id = ?`,
      ).run(
        input.status,
        input.endedAt ?? now(),
        input.finishReason ?? null,
        input.summary ?? null,
        input.provider ?? null,
        input.model ?? null,
        id,
        scope.tenantId,
      );
    },

    async setTitle(id, scope, title) {
      const res = db
        .prepare("UPDATE sessions SET title = ? WHERE id = ? AND tenant_id = ? AND title IS NULL")
        .run(title, id, scope.tenantId);
      return res.changes > 0;
    },

    async setMeta(id, scope, patch) {
      // Read and write in one transaction, so two patches do not lose each other.
      mergeMeta.immediate(id, scope, patch);
    },

    async appendMessage(sessionId, scope, idx, message: ModelMessage) {
      const res = db
        .prepare(
          `INSERT INTO messages (session_id, tenant_id, idx, role, message, created_at)
           SELECT id, tenant_id, ?, ?, ?, ? FROM sessions WHERE id = ? AND tenant_id = ?`,
        )
        .run(idx, message.role, JSON.stringify(message), now(), sessionId, scope.tenantId);
      if (res.changes === 0) throw new Error(`session ${sessionId} not found`);
    },

    async listMessages(sessionId, scope) {
      const rows = db
        .prepare("SELECT idx, message FROM messages WHERE session_id = ? AND tenant_id = ? ORDER BY idx ASC")
        .all(sessionId, scope.tenantId) as { idx: number; message: string }[];
      return rows.map((r): StoredMessage => ({ idx: r.idx, message: JSON.parse(r.message) as ModelMessage }));
    },

    async nextIdx(sessionId, scope) {
      const row = db
        .prepare("SELECT MAX(idx) AS max_idx FROM messages WHERE session_id = ? AND tenant_id = ?")
        .get(sessionId, scope.tenantId) as { max_idx: number | null };
      return (row.max_idx ?? -1) + 1;
    },

    async addUsage(sessionId, scope, d: Usage) {
      db.prepare(
        `UPDATE sessions SET
           tokens_in = tokens_in + ?, tokens_out = tokens_out + ?,
           tokens_cache_hit = tokens_cache_hit + ?, tokens_cache_miss = tokens_cache_miss + ?,
           cost_usd = cost_usd + ?, step_count = step_count + ?
         WHERE id = ? AND tenant_id = ?`,
      ).run(d.tokensIn, d.tokensOut, d.cacheHit, d.cacheMiss, d.costUsd, d.steps, sessionId, scope.tenantId);
    },

    async recordTurnUsage(scope, row: TurnUsage) {
      const u = row.usage;
      const res = db
        .prepare(
          `INSERT INTO turn_usage (session_id, tenant_id, turn, provider, model,
                                   tokens_in, tokens_out, tokens_cache_hit, tokens_cache_miss, cost_usd, steps, created_at)
           SELECT id, tenant_id, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? FROM sessions WHERE id = ? AND tenant_id = ?
           ON CONFLICT(session_id, turn) DO UPDATE SET
             provider = excluded.provider, model = excluded.model,
             tokens_in = excluded.tokens_in, tokens_out = excluded.tokens_out,
             tokens_cache_hit = excluded.tokens_cache_hit, tokens_cache_miss = excluded.tokens_cache_miss,
             cost_usd = excluded.cost_usd, steps = excluded.steps`,
        )
        .run(
          row.turn, row.provider, row.model,
          u.tokensIn, u.tokensOut, u.cacheHit, u.cacheMiss, u.costUsd, u.steps,
          row.createdAt ?? now(),
          row.sessionId, scope.tenantId,
        );
      if (res.changes === 0) throw new Error(`session ${row.sessionId} not found`);
    },

    async listTurnUsage(sessionId, scope) {
      const rows = db
        .prepare("SELECT * FROM turn_usage WHERE session_id = ? AND tenant_id = ? ORDER BY turn ASC")
        .all(sessionId, scope.tenantId) as {
        session_id: string; turn: number; provider: string; model: string;
        tokens_in: number; tokens_out: number; tokens_cache_hit: number; tokens_cache_miss: number;
        cost_usd: number; steps: number; created_at: number;
      }[];
      return rows.map((r): TurnUsage => ({
        sessionId: r.session_id,
        turn: r.turn,
        provider: r.provider,
        model: r.model,
        usage: {
          tokensIn: r.tokens_in, tokensOut: r.tokens_out, cacheHit: r.tokens_cache_hit,
          cacheMiss: r.tokens_cache_miss, costUsd: r.cost_usd, steps: r.steps,
        },
        createdAt: r.created_at,
      }));
    },

    async recordToolCall(scope, row: ToolCall) {
      const res = db
        .prepare(
          `INSERT INTO tool_calls (session_id, tenant_id, message_idx, tool_name, input, output, error, duration_ms, created_at)
           SELECT id, tenant_id, ?, ?, ?, ?, ?, ?, ? FROM sessions WHERE id = ? AND tenant_id = ?`,
        )
        .run(
          row.messageIdx,
          row.toolName,
          JSON.stringify(row.input ?? null),
          row.output === undefined ? null : JSON.stringify(row.output),
          row.error ?? null,
          row.durationMs,
          row.createdAt ?? now(),
          row.sessionId,
          scope.tenantId,
        );
      if (res.changes === 0) throw new Error(`session ${row.sessionId} not found`);
    },

    async listToolCalls(sessionId, scope) {
      const rows = db
        .prepare("SELECT * FROM tool_calls WHERE session_id = ? AND tenant_id = ? ORDER BY id ASC")
        .all(sessionId, scope.tenantId) as {
        session_id: string; message_idx: number; tool_name: string; input: string;
        output: string | null; error: string | null; duration_ms: number; created_at: number;
      }[];
      return rows.map((r): ToolCall => ({
        sessionId: r.session_id,
        messageIdx: r.message_idx,
        toolName: r.tool_name,
        input: JSON.parse(r.input) as unknown,
        output: r.output === null ? undefined : (JSON.parse(r.output) as unknown),
        error: r.error,
        durationMs: r.duration_ms,
        createdAt: r.created_at,
      }));
    },

    async failRunning(input) {
      const ids = (db.prepare("SELECT id FROM sessions WHERE status = 'running'").all() as { id: string }[]).map(
        (r) => r.id,
      );
      db.prepare(
        `UPDATE sessions SET status = 'errored', ended_at = ?, finish_reason = ?, summary = COALESCE(summary, ?)
          WHERE status = 'running'`,
      ).run(now(), input.finishReason, input.summary);
      return ids;
    },

    marks,
  };
}
