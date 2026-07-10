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
import { renderTsFunctionModule } from "@agentic/agent-factory";

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
      // #P1b — also persist the DEPLOYABLE ts_function_module (inngest.createFunction 形态,对标旧六
      // 文件)next to the draft, so a finished run leaves the actual【可下载的 function 代码】on disk,
      // not just a spec. Best-effort — a render hiccup must never break draft persistence (the finish
      // gate contract says save() must not throw). The manifest form remains the runtime deploy path;
      // this .ts is the human-readable deliverable the user asked for.
      try {
        await fs.writeFile(path.join(dir, `${slug}.ts`), renderTsFunctionModule(spec), "utf8");
      } catch {
        /* render failed → keep the .json draft; .ts is a bonus artifact */
      }
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

  /** #P1b — read back the persisted DEPLOYABLE .ts for a draft (the actual function code to hand the
   *  user). Falls back to rendering on the fly from the .json spec if the .ts wasn't written (older
   *  drafts). null if the draft doesn't exist. */
  async getCode(domain: string, slug: string): Promise<string | null> {
    const dir = draftsDir(domain);
    const s = safe(slug);
    try {
      return await fs.readFile(path.join(dir, `${s}.ts`), "utf8");
    } catch {
      /* no .ts yet — render from the spec on demand */
    }
    try {
      const draft = JSON.parse(await fs.readFile(path.join(dir, `${s}.json`), "utf8")) as AgentDraft;
      return renderTsFunctionModule(draft.spec);
    } catch {
      return null;
    }
  }

  /** Delete one generated-function draft (user declined it before promotion). Slug is sanitized
   *  the same way it was written; returns false if it wasn't there. Also removes the sibling .ts. */
  async delete(domain: string, slug: string): Promise<boolean> {
    const dir = draftsDir(domain);
    const s = safe(slug);
    await fs.unlink(path.join(dir, `${s}.ts`)).catch(() => {}); // best-effort sibling cleanup
    try {
      await fs.unlink(path.join(dir, `${s}.json`));
      return true;
    } catch {
      return false;
    }
  }
}
