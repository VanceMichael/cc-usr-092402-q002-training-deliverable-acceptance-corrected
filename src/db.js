import Database from "better-sqlite3";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(here, "..", "migrations");

// 执行 migrations 目录下所有未应用的迁移；每个迁移整体事务化。
export function openDb(filename = "data/app.db") {
  const db = new Database(filename);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  db.exec(`CREATE TABLE IF NOT EXISTS schema_version (
    version INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`);
  const applied = new Set(
    db.prepare("SELECT version FROM schema_version").all().map((r) => r.version),
  );

  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => /^\d+_.+\.sql$/.test(f))
    .sort();
  for (const file of files) {
    const version = Number(file.split("_")[0]);
    if (applied.has(version)) continue;
    const sql = readFileSync(join(MIGRATIONS_DIR, file), "utf8");
    const tx = db.transaction(() => {
      db.exec(sql);
      if (!sql.includes("schema_version(version)")) {
        db.prepare("INSERT OR IGNORE INTO schema_version(version) VALUES (?)").run(version);
      }
    });
    tx();
  }
  return db;
}
