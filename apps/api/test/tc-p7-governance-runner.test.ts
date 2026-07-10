import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { runGovernanceSweep, windowKeyForDate, fsGovernanceStore } from "../src/services/agent-factory/fleet-governance-runner";
import type { FunctionHealth } from "@agentic/agent-factory";

// #P7-infra — 治理巡检编排 + 幂等(DI 注入 healthSource,无需 seed DB)。

const health = (over: Partial<FunctionHealth> = {}): FunctionHealth => ({
  functionId: "resume-parser", domain: "raas", windowDays: 14, windowKey: "2026-07-10", total: 6, failed: 4, ...over,
});

let tmpRoot: string;
let prevRoot: string | undefined;
beforeAll(async () => {
  prevRoot = process.env.AGENTIC_DATA_ROOT;
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "p7-gov-"));
  process.env.AGENTIC_DATA_ROOT = tmpRoot;
});
afterAll(async () => {
  if (prevRoot === undefined) delete process.env.AGENTIC_DATA_ROOT;
  else process.env.AGENTIC_DATA_ROOT = prevRoot;
  await fs.rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
});

describe("TC-P7: runGovernanceSweep 编排 + 幂等", () => {
  it("聚合→判定→落盘待签核(高失败率的 function)", async () => {
    const r = await runGovernanceSweep("raas", {
      now: new Date("2026-07-10T00:00:00Z"),
      healthSource: async () => [health({ functionId: "resume-parser", total: 6, failed: 4 }), health({ functionId: "healthy-one", total: 10, failed: 1 })],
    });
    expect(r.scannedFunctions).toBe(2);
    expect(r.decisions).toHaveLength(1); // only the failing one
    expect(r.decisions[0]!.functionId).toBe("resume-parser");
    expect(r.decisions[0]!.shouldRework).toBe(true);
    // persisted for HITL
    const persisted = await fsGovernanceStore.list("raas");
    expect(persisted.some((d) => d.functionId === "resume-parser")).toBe(true);
  });

  it("同一 function×同窗口再巡检 → 幂等,不重复产出(防重复开返工)", async () => {
    // stub 像真 aggregateFleetHealth 一样,把 sweep 传入的 windowKey 盖到 health 上。
    const src = async (_slug: string, windowKey: string) => [health({ functionId: "flaky-fn", total: 8, failed: 6, windowKey })];
    const first = await runGovernanceSweep("dedupe-t", { now: new Date("2026-07-10T00:00:00Z"), healthSource: src });
    expect(first.decisions).toHaveLength(1);
    const second = await runGovernanceSweep("dedupe-t", { now: new Date("2026-07-10T09:00:00Z"), healthSource: src }); // same window key
    expect(second.decisions).toHaveLength(0); // already opened → deduped
  });

  it("换一个新窗口(新日期)→ 重新可产出(证据仍在)", async () => {
    const src = async (_slug: string, windowKey: string) => [health({ functionId: "persist-fn", total: 8, failed: 6, windowKey })];
    await runGovernanceSweep("win-t", { now: new Date("2026-07-10T00:00:00Z"), healthSource: src });
    const nextDay = await runGovernanceSweep("win-t", { now: new Date("2026-07-11T00:00:00Z"), healthSource: src });
    expect(nextDay.decisions).toHaveLength(1); // new window key → new decision
  });

  it("healthSource 抛错 → never throws,返回空 + 原因", async () => {
    const r = await runGovernanceSweep("err-t", { healthSource: async () => { throw new Error("db down"); } });
    expect(r.decisions).toHaveLength(0);
    expect(r.summary).toContain("失败");
  });

  it("windowKeyForDate 纯确定", () => {
    expect(windowKeyForDate(new Date("2026-07-10T23:59:00Z"))).toBe("2026-07-10");
    expect(windowKeyForDate(new Date("2026-07-10T00:00:00Z"))).toBe("2026-07-10");
  });
});
