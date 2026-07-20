/**
 * Log rotation — compresses run + event log files older than 7 days.
 *
 * Per PRD §5.2: "Log rotation (daily), compression for >7d files".
 *
 * Run manually or schedule via cron:
 *   pnpm --filter @agentic/runtime exec tsx src/log-rotate.ts
 *
 * Production: register a daily Inngest cron function that calls this.
 */

import { readdir, rename, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createGzip } from "node:zlib";
import { createReadStream, createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import { pathToFileURL } from "node:url";

// Rotation window (default 7 days per PRD §5.2). AGENTIC_LOG_ROTATE_DAYS overrides —
// parity with retention.ts's AGENTIC_RETENTION_DAYS knob.
const ROTATE_DAYS = Number(process.env.AGENTIC_LOG_ROTATE_DAYS) > 0 ? Number(process.env.AGENTIC_LOG_ROTATE_DAYS) : 7;
const ROTATE_AFTER_MS = ROTATE_DAYS * 24 * 60 * 60 * 1000;

async function gzipFile(src: string): Promise<void> {
  const dst = `${src}.gz`;
  const temp = `${dst}.${process.pid}.${randomUUID()}.tmp`;
  try {
    // Publish only a complete gzip member. A failed stream leaves the original source untouched and
    // never leaves a partial file at the final .gz path for readers to mistake as durable output.
    await pipeline(createReadStream(src), createGzip(), createWriteStream(temp, { flags: "wx" }));
    await rename(temp, dst);
    await unlink(src);
  } catch (error) {
    try {
      await unlink(temp);
    } catch (cleanupError) {
      if (!isEnoent(cleanupError)) {
        throw new AggregateError([error, cleanupError], `gzip failed for ${src} and temporary-file cleanup also failed`);
      }
    }
    throw error;
  }
}

function isEnoent(error: unknown): error is NodeJS.ErrnoException {
  return !!error && typeof error === "object" && (error as NodeJS.ErrnoException).code === "ENOENT";
}

/** A missing log tree is a valid empty input. Permission, corruption, descriptor exhaustion, and
 * every other I/O failure must reject so the cron/CLI cannot report a false successful sweep. */
async function readdirIfExists(p: string): Promise<string[]> {
  try {
    return await readdir(p);
  } catch (error) {
    if (isEnoent(error)) return [];
    throw error;
  }
}

async function statIfExists(p: string): Promise<Awaited<ReturnType<typeof stat>> | null> {
  try {
    return await stat(p);
  } catch (error) {
    if (isEnoent(error)) return null;
    throw error;
  }
}

export async function walkAndRotate(root: string): Promise<{ rotated: number; skipped: number }> {
  const cutoff = Date.now() - ROTATE_AFTER_MS;
  let rotated = 0;
  let skipped = 0;

  const tenants = await readdirIfExists(root);
  for (const tenant of tenants) {
    const runsRoot = path.join(root, tenant, "runs");
    const eventsRoot = path.join(root, tenant, "events");

    for (const subRoot of [runsRoot, eventsRoot]) {
      const dates = await readdirIfExists(subRoot);
      for (const d of dates) {
        const dPath = path.join(subRoot, d);
        const stDir = await statIfExists(dPath);
        if (!stDir) continue;
        if (!stDir.isDirectory()) {
          // .ndjson file at events root (per-day file)
          if (d.endsWith(".ndjson") && stDir.mtimeMs < cutoff) {
            try {
              await gzipFile(dPath);
              rotated++;
            } catch (error) {
              // A concurrent deleter may remove the source between stat and gzip.
              if (!isEnoent(error)) throw error;
            }
          } else skipped++;
          continue;
        }
        const files = await readdirIfExists(dPath);
        for (const f of files) {
          const full = path.join(dPath, f);
          const stFile = await statIfExists(full);
          if (!stFile) continue;
          if (stFile.mtimeMs >= cutoff) {
            skipped++;
            continue;
          }
          if (f.endsWith(".gz")) {
            skipped++;
            continue;
          }
          if (f.endsWith(".log") || f.endsWith(".ndjson")) {
            try {
              await gzipFile(full);
              rotated++;
            } catch (error) {
              if (!isEnoent(error)) throw error;
            }
          }
        }
      }
    }
  }
  return { rotated, skipped };
}

async function main(): Promise<void> {
  const logRoot = process.env.AGENTIC_LOGS_DIR ?? "./logs";
  try {
    const result = await walkAndRotate(logRoot);
    console.log(
      `[log-rotate] done — rotated ${result.rotated} file(s), skipped ${result.skipped}`,
    );
  } catch (error) {
    console.error("[log-rotate] failed", error);
    process.exitCode = 1;
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (invokedPath === import.meta.url) {
  void main();
}
