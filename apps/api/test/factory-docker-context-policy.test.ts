import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(process.cwd(), "../..");

describe("Factory production Docker context policy", () => {
  it("excludes every runtime-secret path before the context reaches Docker", () => {
    const patterns = readFileSync(path.join(repoRoot, ".dockerignore"), "utf8")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#"));

    expect(patterns).toContain(".secrets");
    expect(patterns).toContain(".secrets/**");
    expect(patterns).toContain(".env");
    expect(patterns).toContain(".env.*");
    expect(patterns).toContain("**/.env.local");
  });
});
