import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { DomainOntology, OntologySource } from "@agentic/agent-factory";
import {
  UploadedFirstOntologySource,
  UploadedOntologySource,
} from "../src/services/agent-factory/uploaded-ontology-source";
import { FsUploadedOntologyStore } from "../src/services/agent-factory/uploaded-ontology-store";

const oldDataRoot = process.env.AGENTIC_DATA_ROOT;
const roots: string[] = [];

function authoritative(source: DomainOntology["source"]): OntologySource {
  return {
    async listDomains() {
      return [{ id: "Agents-generation", name: "Agents generation" }];
    },
    async fetchOntology(domainId) {
      return {
        domainId,
        source,
        actions: [{ id: "remote", name: "remoteAction", actor: ["Agent"] }],
        events: [],
        objects: [],
        rules: [],
        workflow: [],
      };
    },
    async fetchActionRules() {
      return [{ id: "remote-rule" }];
    },
  };
}

afterEach(() => {
  if (oldDataRoot === undefined) delete process.env.AGENTIC_DATA_ROOT;
  else process.env.AGENTIC_DATA_ROOT = oldDataRoot;
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("ontology binding provenance", () => {
  it("keeps an explicit Allmeta binding authoritative over a later same-id upload", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "factory-binding-source-"));
    roots.push(root);
    process.env.AGENTIC_DATA_ROOT = root;
    const tenant = "tenant-source-test";
    const domain = "Agents-generation";
    const store = new FsUploadedOntologyStore();
    await store.save(
      tenant,
      "same id upload",
      { actions: [{ id: "uploaded", name: "uploadedAction", actor: ["Agent"] }] },
      domain,
    );

    const source = new UploadedFirstOntologySource(
      new UploadedOntologySource(tenant, store),
      authoritative("allmeta"),
      undefined,
      domain,
    );

    expect((await source.fetchOntology(domain)).source).toBe("allmeta");
    expect((await source.fetchOntology(domain)).actions[0]?.name).toBe("remoteAction");
    expect(await source.fetchActionRules(domain, "remoteAction")).toEqual([{ id: "remote-rule" }]);
  });

  it("never falls an upload binding through to a same-id authoritative domain", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "factory-binding-source-"));
    roots.push(root);
    process.env.AGENTIC_DATA_ROOT = root;
    const domain = "Agents-generation";
    const source = new UploadedFirstOntologySource(
      new UploadedOntologySource("tenant-with-missing-upload", new FsUploadedOntologyStore()),
      authoritative("allmeta"),
      domain,
    );

    await expect(source.fetchOntology(domain)).rejects.toThrow(/上传的本体里找不到/);
    await expect(source.fetchActionRules(domain, "remoteAction")).rejects.toThrow(/上传的本体里找不到/);
  });

  it("decorates the uploaded marker idempotently (no compounded （上传）（上传）)", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "factory-binding-source-"));
    roots.push(root);
    process.env.AGENTIC_DATA_ROOT = root;
    const tenant = "tenant-marker-test";
    const store = new FsUploadedOntologyStore();
    // A clean name gets exactly one marker; an already-decorated (or doubly
    // decorated) stored name is normalized back to exactly one — so a re-upload
    // that echoed the display name back can never keep compounding.
    await store.save(tenant, "Clean Domain", { actions: [{ name: "a", actor: ["Agent"] }] }, "clean");
    await store.save(tenant, "Once（上传）", { actions: [{ name: "b", actor: ["Agent"] }] }, "once");
    await store.save(tenant, "Twice（上传）（上传）", { actions: [{ name: "c", actor: ["Agent"] }] }, "twice");

    const names = new Map(
      (await new UploadedOntologySource(tenant, store).listDomains()).map((d) => [d.id, d.name]),
    );
    expect(names.get("clean")).toBe("Clean Domain（上传）");
    expect(names.get("once")).toBe("Once（上传）");
    expect(names.get("twice")).toBe("Twice（上传）");
    for (const name of names.values()) expect(name).not.toContain("（上传）（上传）");
  });
});
