-- The session store. Timestamps are epoch milliseconds; JSON columns are text.
-- Every row carries tenant_id, and every query filters by it: a session of
-- another tenant does not exist from where the caller stands.

CREATE TABLE IF NOT EXISTS sessions (
  id                TEXT PRIMARY KEY,
  tenant_id         TEXT NOT NULL,
  agent             TEXT NOT NULL,
  conversation_id   TEXT,
  trigger           TEXT NOT NULL,
  status            TEXT NOT NULL,            -- running | finished | errored
  lifecycle         TEXT NOT NULL DEFAULT 'open', -- open | closed | sleeping
  started_at        INTEGER NOT NULL,
  ended_at          INTEGER,
  finish_reason     TEXT,
  summary           TEXT,
  title             TEXT,
  provider          TEXT,
  model             TEXT,
  tokens_in         INTEGER NOT NULL DEFAULT 0,
  tokens_out        INTEGER NOT NULL DEFAULT 0,
  tokens_cache_hit  INTEGER NOT NULL DEFAULT 0,
  tokens_cache_miss INTEGER NOT NULL DEFAULT 0,
  cost_usd          REAL    NOT NULL DEFAULT 0,
  step_count        INTEGER NOT NULL DEFAULT 0,
  meta              TEXT    NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS sessions_tenant_started ON sessions (tenant_id, started_at DESC);
CREATE INDEX IF NOT EXISTS sessions_tenant_agent_status ON sessions (tenant_id, agent, status);
CREATE INDEX IF NOT EXISTS sessions_tenant_conversation ON sessions (tenant_id, conversation_id);

-- The transcript: the SDK's ModelMessage as is, by position. idx 0 is the
-- system message, frozen when the session opened.
CREATE TABLE IF NOT EXISTS messages (
  session_id  TEXT NOT NULL REFERENCES sessions(id),
  tenant_id   TEXT NOT NULL,
  idx         INTEGER NOT NULL,
  role        TEXT NOT NULL,
  message     TEXT NOT NULL,                  -- JSON (ModelMessage)
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (session_id, idx)
);

-- What one turn cost, with the model that actually answered it. The session
-- row keeps the totals; this is the detail a per-model breakdown needs.
CREATE TABLE IF NOT EXISTS turn_usage (
  session_id        TEXT NOT NULL REFERENCES sessions(id),
  tenant_id         TEXT NOT NULL,
  turn              INTEGER NOT NULL,         -- idx of the message that opened the turn
  provider          TEXT NOT NULL,
  model             TEXT NOT NULL,
  tokens_in         INTEGER NOT NULL DEFAULT 0,
  tokens_out        INTEGER NOT NULL DEFAULT 0,
  tokens_cache_hit  INTEGER NOT NULL DEFAULT 0,
  tokens_cache_miss INTEGER NOT NULL DEFAULT 0,
  cost_usd          REAL    NOT NULL DEFAULT 0,
  steps             INTEGER NOT NULL DEFAULT 0,
  created_at        INTEGER NOT NULL,
  PRIMARY KEY (session_id, turn)
);

CREATE INDEX IF NOT EXISTS turn_usage_tenant_created ON turn_usage (tenant_id, created_at DESC);

CREATE TABLE IF NOT EXISTS tool_calls (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id   TEXT NOT NULL REFERENCES sessions(id),
  tenant_id    TEXT NOT NULL,
  message_idx  INTEGER NOT NULL,
  tool_name    TEXT NOT NULL,
  input        TEXT,                          -- JSON
  output       TEXT,                          -- JSON
  error        TEXT,
  duration_ms  INTEGER NOT NULL,
  created_at   INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS tool_calls_session ON tool_calls (session_id, message_idx);

-- Values a project or an adapter keeps per tenant and key: an extraction
-- mark, the facts a session has seen. The store keeps them; it reads none.
CREATE TABLE IF NOT EXISTS marks (
  tenant_id  TEXT NOT NULL,
  key        TEXT NOT NULL,
  value      TEXT NOT NULL,                   -- JSON
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, key)
);
