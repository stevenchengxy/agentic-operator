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
    const forbidden = [
      /from\s+["']neo4j-driver["']/u,
      /require\(\s*["']neo4j-driver["']\s*\)/u,
      /(?:bolt|neo4j)(?:\+s|\+ssc)?:\/\//iu,
      /\bNEO4J_(?:URI|USER|PASSWORD|DATABASE)\b/u,
      /\b(?:getDriver|runWrite|runQuery)\s*\(/u,
    ];
    const violations: string[] = [];

    for (const root of productionRoots) {
      for (const file of productionTypeScriptFiles(root)) {
        const source = readFileSync(file, "utf8");
        for (const pattern of forbidden) {
          if (pattern.test(source)) {
            violations.push(`${file.slice(workspaceRoot.length + 1)} matched ${pattern}`);
          }
        }
      }
    }

    expect(
      violations,
      "Ontology graph access must go through the AllmetaOntology HTTP API; Neo4j is an internal Allmeta implementation detail.",
    ).toEqual([]);
  });
});
