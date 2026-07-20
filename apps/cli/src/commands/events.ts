/**
 * `agentic events tail` (P1-CLI-04).
 *
 * Subscribes to `/v1/stream` (SSE) and pretty-prints the
 * `RunStreamEvent` lifecycle to stdout. Mirrors the portal's event ticker so
 * you can babysit runs from a terminal.
 *
 * Examples:
 *   agentic events tail
 *   agentic events tail --json          # raw JSON one per line
 *   agentic events tail --no-color
 *
 * Schema for parsed events lives in @agentic/contracts:RunStreamEvent.
 */
import { RunStreamEvent } from "@agentic/contracts";
import type { RunContext } from "../cli.js";

const ANSI = {
  reset: "\x1b[0m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  grey: "\x1b[90m",
  bold: "\x1b[1m",
};

function shouldColor(ctx: RunContext): boolean {
  if (ctx.args.flags["no-color"] === true) return false;
  if (process.env.NO_COLOR) return false;
  return (ctx.stdout as NodeJS.WriteStream).isTTY === true;
}

type StreamEvent = import("@agentic/contracts").RunStreamEvent;

function ts(unixMs: number): string {
  const d = new Date(unixMs);
  return d.toISOString().replace("T", " ").slice(0, 23);
}

function colorize(s: string, code: keyof typeof ANSI, useColor: boolean): string {
  return useColor ? `${ANSI[code]}${s}${ANSI.reset}` : s;
}

export function formatEvent(ev: StreamEvent, useColor: boolean): string {
  const t = colorize(ts(ev.at), "grey", useColor);
  switch (ev.type) {
    case "run.started":
      return `${t} ${colorize("run.start", "cyan", useColor)} ${ev.runId} agent=${ev.agentName} subject=${ev.subject ?? "—"} trigger=${ev.triggerEvent ?? "—"}`;
    case "run.step.started":
      return `${t} ${colorize("step.start", "blue", useColor)} ${ev.runId} #${ev.ord} ${ev.name} (${ev.stepType})`;
    case "run.step.completed": {
      const status =
        ev.status === "ok"
          ? colorize(ev.status, "green", useColor)
          : ev.status === "failed"
            ? colorize(ev.status, "red", useColor)
            : colorize(ev.status, "yellow", useColor);
      const tokens =
        ev.tokensIn != null || ev.tokensOut != null
          ? ` tokens=${ev.tokensIn ?? 0}/${ev.tokensOut ?? 0}`
          : "";
      const model = ev.model ? ` model=${ev.model}` : "";
      const dur = ev.durationMs != null ? ` ${ev.durationMs}ms` : "";
      return `${t} ${colorize("step.end", "blue", useColor)} ${ev.runId} #${ev.ord} ${ev.name} ${status}${dur}${model}${tokens}`;
    }
    case "run.completed":
      return `${t} ${colorize("run.ok", "green", useColor)} ${ev.runId} ${ev.durationMs ?? 0}ms tokens=${ev.tokensIn ?? 0}/${ev.tokensOut ?? 0}`;
    case "run.failed":
      return `${t} ${colorize("run.fail", "red", useColor)} ${ev.runId} ${ev.errorMessage}`;
    case "run.cancelled":
      return `${t} ${colorize("run.cancel", "yellow", useColor)} ${ev.runId} ${ev.reason}`;
    case "event.emitted":
      return `${t} ${colorize("emit", "magenta", useColor)} ${ev.name} ${ev.eventId} subject=${ev.subject ?? "—"}`;
    case "task.created":
      return `${t} ${colorize("task.new", "yellow", useColor)} ${ev.taskId} ${ev.taskType} "${ev.title}"`;
    case "task.resolved":
      return `${t} ${colorize("task.done", "green", useColor)} ${ev.taskId} → ${ev.decision}`;
    case "deployment.created": {
      const slug = ev.workflowSlug ?? "—";
      return `${t} ${colorize("deploy", "magenta", useColor)} ${ev.deploymentId} kind=${ev.kind} version=${ev.version} workflow=${slug}`;
    }
    case "log.line":
      return `${t} ${colorize(ev.level, ev.level === "ERROR" ? "red" : ev.level === "WARN" ? "yellow" : "grey", useColor)} ${ev.runId} ${ev.event} ${ev.message}`;
    case "audit.recorded":
      return `${t} ${colorize("audit", "cyan", useColor)} ${ev.action} target=${ev.targetType ?? "—"}:${ev.targetId ?? "—"} decision=${ev.decision ?? "—"}`;
    case "llm.call.completed": {
      const outcome = ev.ok ? colorize("ok", "green", useColor) : colorize("failed", "red", useColor);
      return `${t} ${colorize("llm.call", "magenta", useColor)} ${outcome} provider=${ev.provider ?? "—"} model=${ev.servedModel ?? ev.requestedModel ?? "—"} tokens=${ev.tokensIn ?? 0}/${ev.tokensOut ?? 0}`;
    }
    case "tool.call.completed": {
      const outcome = ev.ok ? colorize("ok", "green", useColor) : colorize("failed", "red", useColor);
      return `${t} ${colorize("tool.call", "blue", useColor)} ${outcome} ${ev.runId} tool=${ev.toolName} agent=${ev.agentName ?? "—"}`;
    }
  }
}

function buildAuthHeaders(ctx: RunContext): Record<string, string> {
  const h: Record<string, string> = { Accept: "text/event-stream" };
  if (ctx.apiToken) h["Authorization"] = `Bearer ${ctx.apiToken}`;
  return h;
}

export async function runEventsTail(ctx: RunContext): Promise<number> {
  const useColor = shouldColor(ctx);
  const asJson = ctx.args.flags["json"] === true;
  const url = `${ctx.apiUrl}/v1/stream`;

  const res = await fetch(url, { headers: buildAuthHeaders(ctx) });
  if (!res.ok) {
    ctx.stderr.write(`events: GET ${url} → ${res.status}\n`);
    return 1;
  }
  const body = res.body;
  if (!body) {
    ctx.stderr.write("events: server returned no streaming body\n");
    return 1;
  }
  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";

  process.on("SIGINT", () => {
    void reader.cancel("user interrupted");
    process.exit(130);
  });

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buffer.indexOf("\n\n")) !== -1) {
      const frame = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const dataParts: string[] = [];
      for (const ln of frame.split("\n")) {
        if (ln.startsWith("data:")) dataParts.push(ln.slice(5).trim());
      }
      if (dataParts.length === 0) continue;
      const data = dataParts.join("\n");
      let parsed: unknown;
      try {
        parsed = JSON.parse(data);
      } catch {
        continue;
      }
      const result = RunStreamEvent.safeParse(parsed);
      if (!result.success) {
        ctx.stderr.write(
          colorize(`[skip] malformed stream event: ${result.error.message}`, "yellow", useColor) +
            "\n",
        );
        continue;
      }
      if (asJson) {
        ctx.stdout.write(JSON.stringify(result.data) + "\n");
      } else {
        ctx.stdout.write(formatEvent(result.data, useColor) + "\n");
      }
    }
  }
  return 0;
}
