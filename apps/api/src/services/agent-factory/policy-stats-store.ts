// FsPolicyStatsStore（#POLICY-LEARN）— 前置路由的 arm 统计持久化：每域一个 JSON，
// <dataRoot>/factory-policy/<domain>.json，形如 {"full|complex":{"n":4,"ok":3,"fidelityBad":2}}。
// conductor 选路前 load 做证据偏置、run 收束后 save。文件缺失/损坏 → null（零行为影响）；
// 写入走 tmp→rename（进程被杀不会留半个 JSON）。

import { promises as fs } from "node:fs";
import path from "node:path";

type Stats = Record<string, { n: number; ok: number; fidelityBad: number }>;

function dataRoot(): string {
  const r = process.env.AGENTIC_DATA_ROOT?.trim() || "./data";
  return path.isAbsolute(r) ? r : path.resolve(process.cwd(), r);
}
const safe = (s: string) => (s || "_").replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, 80);
const fileOf = (domain: string) => path.join(dataRoot(), "factory-policy", `${safe(domain)}.json`);

export class FsPolicyStatsStore {
  async load(domain: string): Promise<Stats | null> {
    try {
      const raw = await fs.readFile(fileOf(domain), "utf8");
      const v = JSON.parse(raw) as unknown;
      if (!v || typeof v !== "object" || Array.isArray(v)) return null;
      const out: Stats = {};
      for (const [k, s] of Object.entries(v as Record<string, unknown>)) {
        const o = s as Record<string, unknown>;
        const n = Number(o?.n), ok = Number(o?.ok), bad = Number(o?.fidelityBad);
        if (Number.isFinite(n) && Number.isFinite(ok) && Number.isFinite(bad)) out[k] = { n, ok, fidelityBad: bad };
      }
      return Object.keys(out).length ? out : null;
    } catch {
      return null;
    }
  }

  async save(domain: string, stats: Stats): Promise<void> {
    const file = fileOf(domain);
    await fs.mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp-${process.pid}`;
    await fs.writeFile(tmp, JSON.stringify(stats, null, 1), "utf8");
    await fs.rename(tmp, file);
  }
}
