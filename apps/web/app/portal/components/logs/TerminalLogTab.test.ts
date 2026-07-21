import { describe, expect, it } from "vitest";
import type { RunStreamEvent } from "@agentic/contracts";
import { translate } from "@/lib/i18n";
import { formatStreamEvent } from "./TerminalLogTab";

const zh = (key: string, vars?: Record<string, string | number>) =>
  translate("zh", key, vars);

describe("formatStreamEvent localization", () => {
  it("localizes client-authored lifecycle copy without changing identifiers", () => {
    const event: RunStreamEvent = {
      type: "run.started",
      tenantId: "tenant-1",
      at: 1,
      runId: "run-123456",
      agentName: "invoiceAgent",
      triggerEvent: "invoice.created",
      subject: "INV-2048",
      correlationId: "corr-1",
      testRun: true,
    };

    expect(formatStreamEvent(event, zh).text).toBe(
      "▶ invoiceAgent 已启动 · 测试 ← invoice.created · INV-2048",
    );
  });

  it("keeps runtime error details unchanged", () => {
    const event: RunStreamEvent = {
      type: "run.failed",
      tenantId: "tenant-1",
      at: 1,
      runId: "run-123456",
      errorMessage: "provider timeout: upstream-42",
    };

    expect(formatStreamEvent(event, zh).text).toBe(
      "✕ 运行 123456 失败 · provider timeout: upstream-42",
    );
  });

  it("renders persisted log lines byte-for-byte", () => {
    const message = "2026-07-20T10:00:00Z INFO event=task.created raw=true";
    const event: RunStreamEvent = {
      type: "log.line",
      tenantId: "tenant-1",
      at: 1,
      runId: "run-123456",
      correlationId: "corr-1",
      level: "INFO",
      event: "task.created",
      message,
      fields: {},
    };

    expect(formatStreamEvent(event, zh).text).toBe(message);
  });
});
