/**
 * SSE log tail for a single run.
 *
 * Fastify-friendly version: writes SSE frames directly to reply.raw so we
 * don't buffer through Fastify's serializer. Headers per Plan agent risk #3
 * (Cache-Control: no-cache, no-transform; X-Accel-Buffering: no).
 */

import type { FastifyInstance } from "fastify";
import { open, stat, watch } from "node:fs/promises";
import path from "node:path";
import { requireAuth } from "../../plugins/auth";
import { getRun } from "../../queries/runs";

function dateDir(at: Date): string {
  const y = at.getUTCFullYear();
  const m = String(at.getUTCMonth() + 1).padStart(2, "0");
  const d = String(at.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function sseFrame(event: string, data: string): string {
  const lines = [`event: ${event}`];
  for (const ln of data.split("\n")) lines.push(`data: ${ln}`);
  lines.push("", "");
  return lines.join("\n");
}

export async function runsLogsRoute(app: FastifyInstance) {
  app.get<{ Params: { id: string }; Querystring: { follow?: string } }>(
    "/runs/:id/logs",
    async (req, reply) => {
      const auth = requireAuth(req);
      // Strictly tenant-scoped. The previous __system fallback (matched the
      // behavior in /v1/runs/:id) leaked log streams of platform/code-agent
      // runs to any authed caller. P0-AUTH-02.
      const run = await getRun(auth.tenantSlug, req.params.id);
      if (!run) return reply.fail("not_found", "run not found", 404);
      const runTenantSlug = auth.tenantSlug;

      const follow = req.query.follow === "1";
      const at = run.startedAt ?? new Date();
      const logRoot = process.env.AGENTIC_LOGS_DIR ?? "./logs";
      const filePath =
        run.logPath ??
        path.join(logRoot, runTenantSlug, "runs", dateDir(at), `${run.id}.log`);

      reply.raw.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });

      let pos = 0;
      try {
        const fh = await open(filePath, "r");
        try {
          const buf = Buffer.alloc(64 * 1024);
          while (true) {
            const { bytesRead } = await fh.read(buf, 0, buf.length, pos);
            if (bytesRead === 0) break;
            const chunk = buf.toString("utf8", 0, bytesRead);
            for (const line of chunk.split("\n")) {
              if (line.trim()) reply.raw.write(sseFrame("log", line));
            }
            pos += bytesRead;
          }
        } finally {
          await fh.close();
        }
      } catch {
        reply.raw.write(
          sseFrame("info", `(log file not yet present: ${filePath})`),
        );
      }

      if (!follow) {
        reply.raw.write(sseFrame("end", "ok"));
        reply.raw.end();
        return reply;
      }

      const ac = new AbortController();
      req.raw.on("close", () => ac.abort());

      try {
        const watcher = watch(filePath, { signal: ac.signal });
        for await (const _ of watcher) {
          try {
            const st = await stat(filePath);
            if (st.size > pos) {
              const fh = await open(filePath, "r");
              try {
                const buf = Buffer.alloc(st.size - pos);
                await fh.read(buf, 0, buf.length, pos);
                for (const line of buf.toString("utf8").split("\n")) {
                  if (line.trim()) reply.raw.write(sseFrame("log", line));
                }
                pos = st.size;
              } finally {
                await fh.close();
              }
            }
          } catch {
            break;
          }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        reply.raw.write(sseFrame("error", msg));
      } finally {
        reply.raw.end();
      }
      return reply;
    },
  );
}
