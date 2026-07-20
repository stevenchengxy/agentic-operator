import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { readFromInbox } from "./read-from-inbox";

const originalDataRoot = process.env.AGENTIC_DATA_ROOT;
const roots: string[] = [];

function context(data: Record<string, unknown>) {
  return {
    agentName: "document-reader",
    actionName: "fs.readFromInbox",
    correlationId: "corr-read-inbox",
    tenantSlug: "acme",
    event: { name: "acme/DOCUMENT_READY", data },
  };
}

afterEach(() => {
  if (originalDataRoot === undefined) delete process.env.AGENTIC_DATA_ROOT;
  else process.env.AGENTIC_DATA_ROOT = originalDataRoot;
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("fs.readFromInbox canonical input", () => {
  it("reads the canonical filename field", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "agentic-inbox-"));
    roots.push(root);
    process.env.AGENTIC_DATA_ROOT = root;
    const inbox = path.join(root, "resumes", "acme", "inbox");
    mkdirSync(inbox, { recursive: true });
    writeFileSync(path.join(inbox, "candidate.txt"), "candidate");

    const result = await readFromInbox.handler(context({ filename: "candidate.txt" }));

    expect(result.data).toMatchObject({
      filename: "candidate.txt",
      mime: "text/plain",
      bytes: 9,
      base64: Buffer.from("candidate").toString("base64"),
    });
  });

  it("does not recognize tenant-specific RAAS filename aliases", async () => {
    await expect(
      readFromInbox.handler(context({ resume_filename: "legacy.pdf" })),
    ).rejects.toThrow(/missing 'filename' arg/);
    await expect(
      readFromInbox.handler(
        context({ resume_file_path: "legacy/inbox/candidate.pdf" }),
      ),
    ).rejects.toThrow(/missing 'filename' arg/);
  });
});
