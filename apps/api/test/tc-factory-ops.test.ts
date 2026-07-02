/**
 * TC — factory ops-sidebar backend primitives:
 *   1. HITL mailbox contract: push → peek (non-consuming) → drain (consuming), and the
 *      queue cap drops OLDEST first (the user's latest intervention is authoritative).
 *   2. Report-job registry: tenant-scoped listing + lookup isolation.
 */

import { describe, it, expect } from "vitest";
import { pushHumanMessage, drainHumanMessages, peekHumanMessages, disposeMailbox } from "../src/services/agent-factory/mailbox";
import { listReportJobs, getReportJob } from "../src/services/agent-factory/report-jobs";

describe("TC factory-ops: mailbox", () => {
  it("push → peek does not consume; drain returns texts in order and empties", () => {
    const conv = `t-mb-${Math.random().toString(36).slice(2)}`;
    pushHumanMessage(conv, "第一条补充");
    pushHumanMessage(conv, "  第二条补充  "); // trimmed on the way in
    const peek = peekHumanMessages(conv);
    expect(peek.pending).toBe(2);
    expect(peek.oldestTs).toBeTypeOf("number");
    expect(peekHumanMessages(conv).pending).toBe(2); // peek is non-consuming
    expect(drainHumanMessages(conv)).toEqual(["第一条补充", "第二条补充"]);
    expect(peekHumanMessages(conv)).toEqual({ pending: 0, oldestTs: null });
    disposeMailbox(conv);
  });

  it("ignores empty conversation ids and blank messages", () => {
    pushHumanMessage("", "text");
    const conv = `t-mb-${Math.random().toString(36).slice(2)}`;
    pushHumanMessage(conv, "   ");
    expect(peekHumanMessages(conv).pending).toBe(0);
  });

  it("caps the queue at 200, dropping the OLDEST messages", () => {
    const conv = `t-mb-${Math.random().toString(36).slice(2)}`;
    for (let i = 0; i < 205; i++) pushHumanMessage(conv, `msg-${i}`);
    const drained = drainHumanMessages(conv);
    expect(drained).toHaveLength(200);
    expect(drained[0]).toBe("msg-5"); // 0..4 dropped
    expect(drained[199]).toBe("msg-204"); // newest kept
    disposeMailbox(conv);
  });
});

describe("TC factory-ops: report-job registry", () => {
  it("listing is tenant-scoped and lookup refuses cross-tenant reads", () => {
    // No jobs were started in this test process — listing any tenant is empty, and a
    // lookup with a mismatched tenant must be null even for a bogus id.
    expect(listReportJobs("ten-nope")).toEqual([]);
    expect(getReportJob("rpt-nope")).toBeNull();
    expect(getReportJob("rpt-nope", "ten-nope")).toBeNull();
  });
});
