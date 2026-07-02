// FsAgentDraftStore — persists the agents a finished factory run produced as durable,
// reviewable DRAFTS on disk (the new arch's stand-in for the OLD syncDomainDrafts draft
// AgentVersion rows). Drafts land under <dataRoot>/factory-drafts/<domain>/<slug>.json so
// they survive restarts, stay inspectable, and can later be PROMOTED to real Fleet agents.
//
// Deliberately kept OFF the live agents/workflows/agentVersions tables: a generated draft
// must never silently become a running production agent. Promotion (draft → manifest +
// DB rows) is an explicit, separate step.

import { promises as fs } from "node:fs";
import path from "node:path";
import type { AgentDraft, AgentDraftStore, GeneratedAgentSpec } from "@agentic/agent-factory";

function dataRoot(): string {
  const r = process.env.AGENTIC_DATA_ROOT?.trim() || "./data";
  return path.isAbsolute(r) ? r : path.resolve(process.cwd(), r);
}
const safe = (s: string) => (s || "_").replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, 80);
const draftsDir = (domain: string) => path.join(dataRoot(), "factory-drafts", safe(domain));

export class FsAgentDraftStore implements AgentDraftStore {
  async save(domain: string, specs: GeneratedAgentSpec[]): Promise<number> {
    const dir = draftsDir(domain);
    await fs.mkdir(dir, { recursive: true });
    const now = new Date().toISOString();
    let n = 0;
    for (const spec of specs) {
      const slug = safe(spec.slug || spec.short || spec.actionName || `agent-${n}`);
      const draft: AgentDraft = { domain, slug, spec, createdAt: now };
      await fs.writeFile(path.join(dir, `${slug}.json`), JSON.stringify(draft, null, 2), "utf8");
      n++;
    }
    return n;
  }

  async list(domain: string): Promise<AgentDraft[]> {
    const dir = draftsDir(domain);
    let files: string[];
    try {
      files = (await fs.readdir(dir)).filter((f) => f.endsWith(".json"));
    } catch {
      return []; // no drafts dir yet
    }
    const out: AgentDraft[] = [];
    for (const f of files) {
      try {
        out.push(JSON.parse(await fs.readFile(path.join(dir, f), "utf8")) as AgentDraft);
      } catch {
        /* skip an unreadable draft */
      }
    }
    return out.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  }

  /** Delete one generated-function draft (user declined it before promotion). Slug is sanitized
   *  the same way it was written; returns false if it wasn't there. */
  async delete(domain: string, slug: string): Promise<boolean> {
    try {
      await fs.unlink(path.join(draftsDir(domain), `${safe(slug)}.json`));
      return true;
    } catch {
      return false;
    }
  }
}
