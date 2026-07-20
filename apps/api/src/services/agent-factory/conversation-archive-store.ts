// #CONV-ARCHIVE — FS NDJSON store for compaction-dropped conversation turns.
//
// One append-only NDJSON file per (tenant, domain, conversation). Append is atomic-enough for the
// single-writer conductor (one brain run per conversation at a time); a torn final line from a
// crash mid-append is skipped on read, never fatal. Search/count re-read the file — conversations
// are bounded (tens of folds × ≤40 msgs), so a full read stays cheap; the shared pure matcher in
// @agentic/agent-factory keeps store behavior identical to what the brain tool documents.

import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import {
  searchArchiveEntries,
  type ConversationArchiveEntry,
  type ConversationArchiveSearchHit,
  type FactoryConversationArchive,
} from "@agentic/agent-factory";

// Same resolution as the sibling FsAgentDraftStore — one data root for all factory FS stores.
function dataRoot(): string {
  return process.env.AGENTIC_DATA_ROOT?.trim() || "./data";
}

function safeSegment(value: string): string {
  const cleaned = value.replace(/[^a-zA-Z0-9._-]/g, "_");
  return cleaned.slice(0, 200) || "_";
}

export class FsConversationArchiveStore implements FactoryConversationArchive {
  constructor(
    private readonly tenantId: string,
    private readonly domain: string,
  ) {}

  private dir(): string {
    return path.join(
      dataRoot(),
      "factory-conversation-archive",
      "_tenants",
      safeSegment(this.tenantId),
      safeSegment(this.domain),
    );
  }

  private file(conversationId: string): string {
    return path.join(this.dir(), `${safeSegment(conversationId)}.ndjson`);
  }

  async append(conversationId: string, entries: ConversationArchiveEntry[]): Promise<void> {
    if (!entries.length) return;
    await mkdir(this.dir(), { recursive: true });
    const lines = entries.map((entry) => `${JSON.stringify(entry)}\n`).join("");
    await appendFile(this.file(conversationId), lines, "utf8");
  }

  private async readAll(conversationId: string): Promise<ConversationArchiveEntry[]> {
    let raw: string;
    try {
      raw = await readFile(this.file(conversationId), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const out: ConversationArchiveEntry[] = [];
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line) as ConversationArchiveEntry);
      } catch {
        /* torn final line from a crash mid-append — skip, never fatal */
      }
    }
    return out;
  }

  async search(
    conversationId: string,
    query: string,
    opts?: { limit?: number },
  ): Promise<ConversationArchiveSearchHit[]> {
    const entries = await this.readAll(conversationId);
    return searchArchiveEntries(entries, query, Math.max(1, Math.min(50, opts?.limit ?? 6)));
  }

  async count(conversationId: string): Promise<number> {
    return (await this.readAll(conversationId)).length;
  }
}
