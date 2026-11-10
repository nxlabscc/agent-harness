import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { sessionStoreContract } from "./contract";
import { applyMigrations } from "./migrations";
import { createSqliteSessionStore } from "./sqlite";

sessionStoreContract("sqlite :memory:", (now) => createSqliteSessionStore(new Database(":memory:"), { now }));

test("two stores on one database file see the same sessions", async () => {
  // What a second process sees: its own connection, the same rows.
  const path = `/tmp/harness-${crypto.randomUUID()}.db`;
  const a = createSqliteSessionStore(new Database(path, { create: true }));
  const b = createSqliteSessionStore(new Database(path));
  const s = await a.createSession({ scope: { tenantId: "t" }, agent: "x", trigger: "cron" });
  expect((await b.getSession(s.id, { tenantId: "t" }))!.id).toBe(s.id);
  expect(await b.claimAgent({ scope: { tenantId: "t" }, agent: "x", trigger: "cron" })).toBeNull();
});

test("migrations apply once and report what they applied", () => {
  const db = new Database(":memory:");
  expect(applyMigrations(db)).toEqual(["001_sessions.sql"]);
  expect(applyMigrations(db)).toEqual([]);
});

test("the store creates only its own tables", () => {
  const db = new Database(":memory:");
  createSqliteSessionStore(db);
  const tables = (db.query("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as { name: string }[])
    .map((r) => r.name)
    .filter((n) => !n.startsWith("sqlite_"));
  expect(tables).toEqual(["harness_schema_migrations", "marks", "messages", "sessions", "tool_calls", "turn_usage"]);
});
