/**
 * Tests for the global CLI arg parser + help output.
 */
import { describe, expect, it } from "vitest";
import { parseArgs, run, VERSION } from "../src/cli.js";

function captureStream() {
  const chunks: string[] = [];
  const stream = {
    write(s: string): boolean {
      chunks.push(s);
      return true;
    },
    get text(): string {
      return chunks.join("");
    },
  };
  return stream;
}

describe("parseArgs", () => {
  it("recognises commands and positional args", () => {
    const a = parseArgs(["init", "demo"]);
    expect(a.command).toBe("init");
    expect(a.positional).toEqual(["demo"]);
  });

  it("captures the events subcommand", () => {
    const a = parseArgs(["events", "tail"]);
    expect(a.command).toBe("events");
    expect(a.subcommand).toBe("tail");
  });

  it("parses --api and --token into globals", () => {
    const a = parseArgs([
      "logs",
      "run-1",
      "--api",
      "http://other:3540",
      "--token",
      "abc",
    ]);
    expect(a.command).toBe("logs");
    expect(a.positional).toEqual(["run-1"]);
    expect(a.globals.api).toBe("http://other:3540");
    expect(a.globals.token).toBe("abc");
  });

  it("treats --tail as a bare flag", () => {
    const a = parseArgs(["logs", "run-1", "--tail"]);
    expect(a.flags["tail"]).toBe(true);
  });

  it("supports --key=value", () => {
    const a = parseArgs(["deploy", ".", "--note=test note"]);
    expect(a.flags["note"]).toBe("test note");
  });

  it("captures -h/--help/-v/--version", () => {
    expect(parseArgs(["--help"]).help).toBe(true);
    expect(parseArgs(["-h"]).help).toBe(true);
    expect(parseArgs(["-v"]).version).toBe(true);
    expect(parseArgs(["--version"]).version).toBe(true);
  });
});

describe("run() integration", () => {
  it("--help returns 0 and prints the catalog", async () => {
    const out = captureStream();
    const err = captureStream();
    const _saveOut = process.stdout.write.bind(process.stdout);
    const _saveErr = process.stderr.write.bind(process.stderr);
    // run() writes via process.stdout — but the HELP path goes through it
    // directly. Capture via a mock.
    const origOut = process.stdout.write;
    const origErr = process.stderr.write;
    // @ts-expect-error — test-only monkey-patch
    process.stdout.write = (s) => out.write(String(s));
    // @ts-expect-error — test-only monkey-patch
    process.stderr.write = (s) => err.write(String(s));
    try {
      const code = await run(["--help"]);
      expect(code).toBe(0);
      expect(out.text).toContain("init <slug>");
      expect(out.text).toContain("deploy");
      expect(out.text).toContain("logs <run-id>");
      expect(out.text).toContain("events tail");
    } finally {
      process.stdout.write = origOut;
      process.stderr.write = origErr;
    }
  });

  it("--version reports the package version", async () => {
    const origOut = process.stdout.write;
    let captured = "";
    // @ts-expect-error — monkey-patch
    process.stdout.write = (s) => {
      captured += String(s);
      return true;
    };
    try {
      const code = await run(["--version"]);
      expect(code).toBe(0);
      expect(captured.trim()).toBe(`agentic ${VERSION}`);
    } finally {
      process.stdout.write = origOut;
    }
  });

  it("unknown command returns 2", async () => {
    const origOut = process.stdout.write;
    const origErr = process.stderr.write;
    // @ts-expect-error — monkey-patch
    process.stdout.write = () => true;
    // @ts-expect-error — monkey-patch
    process.stderr.write = () => true;
    try {
      const code = await run(["wat"]);
      expect(code).toBe(2);
    } finally {
      process.stdout.write = origOut;
      process.stderr.write = origErr;
    }
  });

  it("'events <other>' returns 2 because subcommand must be 'tail'", async () => {
    const origOut = process.stdout.write;
    const origErr = process.stderr.write;
    // @ts-expect-error
    process.stdout.write = () => true;
    // @ts-expect-error
    process.stderr.write = () => true;
    try {
      const code = await run(["events", "list"]);
      expect(code).toBe(2);
    } finally {
      process.stdout.write = origOut;
      process.stderr.write = origErr;
    }
  });
});
