/**
 * Migration runner. Invoked via `pnpm db:migrate`.
 * Applies pending migrations in ./drizzle then closes the connection.
 */

import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { closeDb, getDb } from "./client";
import { assertInheritedSqliteWriterLease } from "./writer-lease";

const here = path.dirname(fileURLToPath(import.meta.url));
const migrationsFolder = path.resolve(here, "..", "drizzle");

assertInheritedSqliteWriterLease(
  process.env.DATABASE_URL?.trim()
    || `file:${path.resolve(here, "../../../data/agentic.db")}`,
);

const db = getDb();
console.log(`[db:migrate] applying migrations from ${migrationsFolder}`);
migrate(db, { migrationsFolder });
console.log("[db:migrate] done");
closeDb();
