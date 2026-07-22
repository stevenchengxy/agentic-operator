import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const workspaceRoot = resolve(import.meta.dirname, "../../..");

const productionRoots = [
  "apps/api/src/services/agent-factory",
  "packages/agent-factory/src",
  "packages/runtime/src",
  "packages/tools/src",
] as const;

// The sanctioned, read-only, tenant-scoped `ontology.query` global tool (brought in
// per the Kenny merge playbook, docs/merge/2026-07-20-kenny-merge-playbook.md line 38)
// reaches Neo4j exclusively through the HTTP Query API v2 via `fetch` — it never opens
// a bolt driver. It does legitimately reference Neo4j env-var *names* in its config
// schema (query.ts) and the registry catalog doc-strings (registry.ts). An env-var name
// in a config schema is not a direct graph connection, so these two files are exempted
// from the env-NAME guard ONLY. Every bolt-driver / connection-URI guard below still
// applies to them in full.
const neo4jEnvNameAllowlist = new Set([
  "packages/tools/src/ontology/query.ts",
  "packages/tools/src/registry.ts",
]);

function productionTypeScriptFiles(root: string): string[] {
  const output: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory)) {
      const absolute = join(directory, entry);
      const stat = statSync(absolute);
      if (stat.isDirectory()) {
        visit(absolute);
      } else if (
        /\.tsx?$/u.test(entry) &&
        !/\.(?:test|spec)\.tsx?$/u.test(entry) &&
        !absolute.includes(`${join("src", "__smoke__")}`)
      ) {
        output.push(absolute);
      }
    }
  };
  visit(resolve(workspaceRoot, root));
  return output;
}

describe("Agent Factory AllmetaOntology boundary", () => {
  it("does not connect to Neo4j directly from factory, runtime, or generated-tool code", () => {
    // A direct bolt-driver connection is forbidden everywhere under the production
    // roots: importing `neo4j-driver`, a bolt:///neo4j:// connection URI, or the
    // getDriver/runWrite/runQuery access helpers. These are the real
    // tenant-isolation / long-lived-credential exposure risks and are never exempted.
    const forbidden = [
      /from\s+["']neo4j-driver["']/u,
      /require\(\s*["']neo4j-driver["']\s*\)/u,
      /(?:bolt|neo4j)(?:\+s|\+ssc)?:\/\//iu,
      /\b(?:getDriver|runWrite|runQuery)\s*\(/u,
    ];
    // Neo4j env-var NAMES in a config schema are not a direct graph connection, so
    // this guard is scoped: it fires everywhere EXCEPT the sanctioned ontology.query
    // tool and its registry catalog entry (see neo4jEnvNameAllowlist above).
    const forbiddenEnvName = /\bNEO4J_(?:URI|USER|PASSWORD|DATABASE)\b/u;
    const violations: string[] = [];

    for (const root of productionRoots) {
      for (const file of productionTypeScriptFiles(root)) {
        const relative = file.slice(workspaceRoot.length + 1);
        const source = readFileSync(file, "utf8");
        for (const pattern of forbidden) {
          if (pattern.test(source)) {
            violations.push(`${relative} matched ${pattern}`);
          }
        }
        if (!neo4jEnvNameAllowlist.has(relative) && forbiddenEnvName.test(source)) {
          violations.push(`${relative} matched ${forbiddenEnvName}`);
        }
      }
    }

    expect(
      violations,
      "The only sanctioned direct Neo4j path is the read-only, tenant-scoped ontology.query HTTP Query API tool; no bolt-driver access from factory, runtime, or tools.",
    ).toEqual([]);
  });
});
