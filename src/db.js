import Database from "better-sqlite3";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");

export function openDatabase(path) {
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  migrate(db);
  return db;
}

function currentVersion(db) {
  try {
    return db.prepare("select max(version) as v from schema_version").get().v ?? 0;
  } catch {
    return 0;
  }
}

export function migrate(db) {
  const version = currentVersion(db);
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => /^\d+.*\.sql$/.test(f))
    .sort();
  for (const file of files) {
    const fileVersion = parseInt(file, 10);
    if (fileVersion <= version) continue;
    const sql = readFileSync(join(MIGRATIONS_DIR, file), "utf8");
    db.exec(sql);
  }
}
