import { describe, expect, it } from "vitest";
import type { BrainEvent } from "@/lib/hooks/useBrainStream";
import {
  deriveBrainFlow,
  deriveStages,
  factoryRunDisplayStatus,
  sandboxEvidenceStatus,
} from "./model";

const event = (value: Record<string, unknown>): BrainEvent =>
  value as unknown as BrainEvent;

describe("Factory real execution evidence", () => {
  it("keeps a suspended human wait distinct from both success and failure", () => {
    expect(factoryRunDisplayStatus({
      status: "waiting_human",
      evidenceStatus: "none",
      realExecutionSucceeded: false,
      completionKind: "incomplete",
    })).toBe("waiting_human");
    const events = [event({ t: "done", status: "waiting_human", completionKind: "incomplete" })];
    expect(deriveStages(events).stages.find((stage) => stage.id === "deliver")).toMatchObject({
      label: "等待人工",
      status: "idle",
    });
    expect(deriveBrainFlow(events).at(-1)).toMatchObject({
      kind: "gate",
      status: "await",
    });
  });

  it("does not present terminal rows as complete without a successful final real execution", () => {
    expect(factoryRunDisplayStatus({
      status: "finished",
      evidenceStatus: "real",
      realExecutionSucceeded: false,
      completionKind: "delivery",
    })).toBe("failed_real_execution");
    expect(factoryRunDisplayStatus({
      status: "finished",
      evidenceStatus: "simulated_only",
      realExecutionSucceeded: false,
      completionKind: "delivery",
    })).toBe("invalid_evidence");
    expect(factoryRunDisplayStatus({
      status: "finished",
      evidenceStatus: "real",
      realExecutionSucceeded: true,
      completionKind: "delivery",
    })).toBe("finished");
  });

  it("classifies historical simulated-only transcripts as invalid evidence", () => {
    const events = [
      event({
        t: "sandbox",
        simulated: true,
        fullChainRan: true,
        reachedSuccessTerminal: true,
      }),
      event({ t: "done", status: "finished", completionKind: "delivery" }),
    ];

    expect(sandboxEvidenceStatus(events)).toBe("simulated_only");
    const stages = deriveStages(events).stages;
    expect(stages.find((stage) => stage.id === "sandbox")?.status).toBe(
      "error",
    );
    expect(stages.find((stage) => stage.id === "deliver")?.status).toBe(
      "error",
    );

    const flow = deriveBrainFlow(events);
    expect(flow.find((step) => step.kind === "sandbox")).toMatchObject({
      status: "fail",
      label: "历史模拟记录 · 无效执行证据",
    });
    expect(flow.find((step) => step.kind === "deliver")?.status).toBe(
      "fail",
    );
  });

  it("turns execution and delivery green only after a successful real sandbox", () => {
    const events = [
      event({
        t: "sandbox",
        simulated: false,
        fullChainRan: true,
        reachedSuccessTerminal: true,
      }),
      event({ t: "done", status: "finished", completionKind: "delivery" }),
    ];

    expect(sandboxEvidenceStatus(events)).toBe("real");
    expect(
      deriveBrainFlow(events).filter((step) =>
        ["sandbox", "deliver"].includes(step.kind),
      ),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "sandbox", status: "ok" }),
        expect.objectContaining({ kind: "deliver", status: "ok" }),
      ]),
    );
  });

  it("presents a Q&A answer as successful without manufacturing delivery or sandbox evidence", () => {
    const events = [
      event({ t: "message", text: "这是信息回答。" }),
      event({ t: "done", status: "incomplete", completionKind: "answer" }),
    ];

    expect(factoryRunDisplayStatus({
      status: "done",
      evidenceStatus: "none",
      realExecutionSucceeded: false,
      completionKind: "answer",
    })).toBe("answer_completed");

    const stages = deriveStages(events).stages;
    expect(stages.find((stage) => stage.id === "deliver")).toMatchObject({
      label: "回答",
      status: "ok",
    });
    expect(stages.find((stage) => stage.id === "sandbox")?.status).toBe("idle");
    expect(deriveBrainFlow(events).at(-1)).toMatchObject({
      kind: "answer",
      label: "回答完成",
      status: "ok",
    });
  });

  it("keeps old done frames without completionKind explicitly unknown", () => {
    const events = [event({ t: "done", status: "finished" })];
    expect(deriveStages(events).stages.at(-1)).toMatchObject({
      label: "结束（类型未知）",
      status: "error",
    });
    expect(deriveBrainFlow(events).at(-1)).toMatchObject({
      label: "结束 · 历史记录未标注完成类型",
      status: "warn",
    });
  });
});
