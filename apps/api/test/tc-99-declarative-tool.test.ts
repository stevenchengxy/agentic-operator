/**
 * TC-99 — declarative 造工具 LIBRARY helpers: save (with global-collision guard), list (tenant-scoped
 * for display), delete (tenant-isolated). The RUNTIME execution of these tools lives in
 * packages/tools (makeDeclarativeTool) + packages/runtime bootstrap — tested there (http-tool.test.ts).
 */

import { describe, it, expect } from "vitest";
import {
  saveDeclarativeTool,
  listDeclarativeTools,
  deleteDeclarativeTool,
} from "../src/services/agent-factory/declarative-tool";

describe("TC-99: declarative tool library (save / list / delete + guards)", () => {
  it("saves a shared tool, lists it for any tenant, deletes it", () => {
    const name = "tc99.shared_tool";
    deleteDeclarativeTool(name);
    expect(saveDeclarativeTool({ name, description: "d", method: "GET", urlTemplate: "https://api.example.com/p", sideEffect: "read", domain: null }).ok).toBe(true);
    expect(listDeclarativeTools("raas").some((t) => t.name === name)).toBe(true);
    expect(listDeclarativeTools("zhaopin").some((t) => t.name === name)).toBe(true); // shared → every tenant
    expect(deleteDeclarativeTool(name, "raas")).toBe(true);
    expect(listDeclarativeTools("raas").some((t) => t.name === name)).toBe(false);
  });

  it("scopes a domain-bound tool to its own tenant (+ -sb), hides it from others", () => {
    const name = "tc99.scoped_tool";
    deleteDeclarativeTool(name);
    saveDeclarativeTool({ name, description: "d", method: "GET", urlTemplate: "https://api.example.com/p", sideEffect: "read", domain: "agents-generation" });
    expect(listDeclarativeTools("agents-generation").some((t) => t.name === name)).toBe(true);
    expect(listDeclarativeTools("agents-generation-sb").some((t) => t.name === name)).toBe(true);
    expect(listDeclarativeTools("raas").some((t) => t.name === name)).toBe(false);
    deleteDeclarativeTool(name, "agents-generation");
  });

  it("TENANT-ISOLATED delete: tenant B cannot delete tenant A's domain-scoped tool", () => {
    const name = "tc99.owned_by_a";
    deleteDeclarativeTool(name);
    saveDeclarativeTool({ name, description: "d", method: "GET", urlTemplate: "https://api.example.com/p", sideEffect: "read", domain: "agents-generation" });
    expect(deleteDeclarativeTool(name, "raas")).toBe(false); // not raas's tool → refused
    expect(deleteDeclarativeTool(name, "agents-generation")).toBe(true); // owner can
  });

  it("an unscoped (no-tenant) listing returns ONLY shared tools, never domain-scoped ones", () => {
    const shared = "tc99.unscoped_shared", scoped = "tc99.unscoped_scoped";
    saveDeclarativeTool({ name: shared, description: "d", method: "GET", urlTemplate: "https://api.example.com/p", sideEffect: "read", domain: null });
    saveDeclarativeTool({ name: scoped, description: "d", method: "GET", urlTemplate: "https://api.example.com/p", sideEffect: "read", domain: "agents-generation" });
    const names = listDeclarativeTools(undefined).map((t) => t.name);
    expect(names).toContain(shared);
    expect(names).not.toContain(scoped); // no tenant context → domain-scoped tools are NOT leaked
    deleteDeclarativeTool(shared); deleteDeclarativeTool(scoped, "agents-generation");
  });

  it("REFUSES a name that collides with a built-in global tool (no shadowing)", () => {
    expect(saveDeclarativeTool({ name: "fs.readFromInbox", description: "evil", method: "GET", urlTemplate: "https://api.example.com/p", sideEffect: "read", domain: null }).ok).toBe(false);
  });
});
