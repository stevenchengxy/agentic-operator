// FsPolicyStatsStore（#POLICY-LEARN）— 前置路由的 arm 统计持久化：每域一个 JSON，
// <dataRoot>/factory-policy/<domain>.json，形如 {"full|complex":{"n":4,"ok":3,"fidelityBad":2}}。
// conductor 选路前 load 做证据偏置、run 收束后 save。文件缺失/损坏 → null（零行为影响）；
// 写入走 tmp→rename（进程被杀不会留半个 JSON）。

import { promises as fs } from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";

type Stats = Record<string, { n: number; ok: number; fidelityBad: number }>;

function dataRoot(): string {
  const r = process.env.AGENTIC_DATA_ROOT?.trim() || "./data";
  return path.isAbsolute(r) ? r : path.resolve(process.cwd(), r);
}
const safe = (s: string) => (s || "_").replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, 80);
const exactSeg = (s: string) => `${safe(s)}-${createHash("sha256").update(s, "utf8").digest("hex").slice(0, 16)}`;
const legacyFileOf = (domain: string) => path.join(dataRoot(), "factory-policy", `${safe(domain)}.json`);

export class FsPolicyStatsStore {
  constructor(private readonly scope?: { tenantId: string; tenantSlug: string; ontologyDomainId?: string }) {}

  private acceptsDomain(domain: string): boolean {
    return !this.scope?.ontologyDomainId || this.scope.ontologyDomainId === domain;
  }

  private file(domain: string): string {
    return this.scope
      ? path.join(dataRoot(), "factory-policy", "_tenants", safe(this.scope.tenantId), `${exactSeg(domain)}.json`)
      : legacyFileOf(domain);
  }

  private oldScopedFile(domain: string): string | null {
    if (!this.scope || safe(domain) !== domain) return null;
    return path.join(dataRoot(), "factory-policy", "_tenants", safe(this.scope.tenantId), `${safe(domain)}.json`);
  }

  async load(domain: string): Promise<Stats | null> {
    if (!this.acceptsDomain(domain)) return null;
    const readOptional = async (file: string | null): Promise<string | null> => {
      if (!file) return null;
      try {
        return await fs.readFile(file, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      }
    };
    let raw = await readOptional(this.file(domain));
    raw ??= await readOptional(this.oldScopedFile(domain));
    if (raw === null && this.scope?.tenantSlug === domain) raw = await readOptional(legacyFileOf(domain));
    if (raw === null) return null;
    const v = JSON.parse(raw) as unknown;
    if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error(`invalid policy stats for ${domain}: expected object`);
    const out: Stats = {};
    for (const [k, s] of Object.entries(v as Record<string, unknown>)) {
      const o = s as Record<string, unknown>;
      const n = Number(o?.n), ok = Number(o?.ok), bad = Number(o?.fidelityBad);
      if (!Number.isFinite(n) || !Number.isFinite(ok) || !Number.isFinite(bad)) {
        throw new Error(`invalid policy stats entry ${k} for ${domain}`);
      }
      out[k] = { n, ok, fidelityBad: bad };
    }
    return Object.keys(out).length ? out : null;
  }

  async save(domain: string, stats: Stats): Promise<void> {
    if (!this.acceptsDomain(domain)) throw new Error(`policy stats domain mismatch: expected ${this.scope?.ontologyDomainId}, got ${domain}`);
    const file = this.file(domain);
    await fs.mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp-${process.pid}-${randomUUID()}`;
    const handle = await fs.open(tmp, "wx", 0o600);
    try {
      await handle.writeFile(JSON.stringify(stats, null, 1), "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await fs.rename(tmp, file);
    } catch (error) {
      await fs.unlink(tmp).catch(() => undefined);
      throw error;
    }
  }
}
