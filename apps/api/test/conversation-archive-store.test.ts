// #CONV-ARCHIVE — FS NDJSON store roundtrip: append → search/count, torn-line tolerance,
// and tenant/domain isolation (one conversation's archive can never serve another scope).
import { mkdtempSync, rmSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FsConversationArchiveStore } from "../src/services/agent-factory/conversation-archive-store";

let root: string;
let prevDataRoot: string | undefined;

beforeAll(() => {
  root = mkdtempSync(path.join(tmpdir(), "conv-archive-"));
  prevDataRoot = process.env.AGENTIC_DATA_ROOT;
  process.env.AGENTIC_DATA_ROOT = root;
});

afterAll(() => {
  if (prevDataRoot === undefined) delete process.env.AGENTIC_DATA_ROOT;
  else process.env.AGENTIC_DATA_ROOT = prevDataRoot;
  rmSync(root, { recursive: true, force: true });
});

describe("FsConversationArchiveStore", () => {
  it("append → count/search roundtrip, most-recent-first", async () => {
    const store = new FsConversationArchiveStore("ten-a", "DomainA");
    await store.append("frn-1", [
      { at: 1, role: "user", content: "第一次讨论 人工边界", foldSeq: 1 },
      { at: 2, role: "assistant", content: "规则工具选 fetchActionRules", foldSeq: 1 },
    ]);
    await store.append("frn-1", [
      { at: 3, role: "user", content: "再次确认 人工边界 Internal_Recruitment", foldSeq: 2 },
    ]);
    expect(await store.count("frn-1")).toBe(3);
    const hits = await store.search("frn-1", "人工边界");
    expect(hits.map((h) => h.index)).toEqual([2, 0]); // newest first, stable indices
    expect(hits[0]!.content).toContain("Internal_Recruitment");
  });

  it("a torn final line (crash mid-append) is skipped, never fatal", async () => {
    const store = new FsConversationArchiveStore("ten-a", "DomainA");
    await store.append("frn-torn", [{ at: 1, role: "user", content: "完整行", foldSeq: 1 }]);
    appendFileSync(
      path.join(root, "factory-conversation-archive", "_tenants", "ten-a", "DomainA", "frn-torn.ndjson"),
      '{"at":2,"role":"user","content":"被撕裂的',
      "utf8",
    );
    expect(await store.count("frn-torn")).toBe(1);
  });

  it("scope isolation: same conversation id under another tenant/domain reads empty", async () => {
    const a = new FsConversationArchiveStore("ten-a", "DomainA");
    await a.append("frn-shared", [{ at: 1, role: "user", content: "属于 ten-a 的机密", foldSeq: 1 }]);
    expect(await new FsConversationArchiveStore("ten-b", "DomainA").count("frn-shared")).toBe(0);
    expect(await new FsConversationArchiveStore("ten-a", "DomainB").count("frn-shared")).toBe(0);
  });

  it("empty archive: count 0, search []", async () => {
    const store = new FsConversationArchiveStore("ten-a", "DomainA");
    expect(await store.count("frn-none")).toBe(0);
    expect(await store.search("frn-none", "任何词")).toEqual([]);
  });
});
