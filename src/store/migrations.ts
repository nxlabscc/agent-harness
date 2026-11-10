import type { Database } from "bun:sqlite";
import sessions from "./migrations/001_sessions.sql" with { type: "text" };

// The SQL travels inside the module, as text, rather than as files next to the
// executable: once the library is bundled into a project, a path relative to
// this file would point into the project's bundle. Forward-only: a published
// migration is never edited, a new one is added with its own import.
const all: { name: string; sql: string }[] = [{ name: "001_sessions.sql", sql: sessions }];

/**
 * Applies the migrations the database has not seen, in order, each in its own
 * transaction, and returns their names. Safe to call again: it reads the applied
 * set every time.
 */
export function applyMigrations(db: Database): string[] {
  db.exec(`
    CREATE TABLE IF NOT EXISTS harness_schema_migrations (
      name       TEXT PRIMARY KEY,
      applied_at INTEGER NOT NULL
    );
  `);
  const applied = new Set(
    (db.query("SELECT name FROM harness_schema_migrations").all() as { name: string }[]).map((r) => r.name),
  );
  const done: string[] = [];
  for (const { name, sql } of all) {
    if (applied.has(name)) continue;
    db.transaction(() => {
      db.exec(sql);
      db.prepare("INSERT INTO harness_schema_migrations (name, applied_at) VALUES (?, ?)").run(name, Date.now());
    })();
    done.push(name);
  }
  return done;
}
