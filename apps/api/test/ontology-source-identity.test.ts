import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { OntologySource } from "@agentic/agent-factory";
import { ManifestOntologySource } from "../src/services/agent-factory/ontology-source";
import { CompositeOntologySource } from "../src/services/agent-factory/composite-ontology-source";

const roots: string[] = [];

function tempModels(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "factory-model-identity-"));
  roots.push(root);
  return root;
}

function writeJson(root: string, folder: string, file: string, value: unknown): void {
  const dir = path.join(root, folder);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, file), JSON.stringify(value), "utf8");
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("ManifestOntologySource canonical identity", () => {
  it("preserves action_steps and integration instead of flattening executable ontology data", async () => {
    const root = tempModels();
    writeJson(root, "Agents-generation-v1", "actions_v1.json", {
      actions: [{
        id: "9-1",
        name: "processResume",
        actor: ["Agent"],
        trigger: ["RESUME_DOWNLOADED"],
        triggered_event: ["RESUME_PROCESSED"],
        action_steps: [{ order: "1", name: "parseResume", rules: [{ id: "9-11" }] }],
        integration: { systems: [{ name: "RoboHire", kind: "external_api", role: "calls" }] },
      }],
    });
    const source = new ManifestOntologySource(root);
    const ontology = await source.fetchOntology("agents-generation");

    expect(ontology.actions[0]?.action_steps?.[0]).toMatchObject({ name: "parseResume" });
    expect(ontology.actions[0]?.integration).toMatchObject({ systems: [{ name: "RoboHire" }] });
  });

  it("rejects incomplete local actions instead of inventing an Agent actor or dropping malformed fields", async () => {
    const root = tempModels();
    writeJson(root, "missing-actor-v1", "actions_v1.json", {
      actions: [{ id: "1", name: "run" }],
    });
    const missingActor = new ManifestOntologySource(root);
    await expect(missingActor.fetchOntology("missing-actor")).rejects.toThrow(/actor is required/);

    fs.rmSync(path.join(root, "missing-actor-v1"), { recursive: true, force: true });
    writeJson(root, "bad-tools-v1", "actions_v1.json", {
      actions: [{ id: "1", name: "run", actor: ["Agent"], tool_use: [{}] }],
    });
    const badTools = new ManifestOntologySource(root);
    await expect(badTools.fetchOntology("bad-tools")).rejects.toThrow(/tool_use/);
  });

  it("fails closed when two folders publish the same canonical domain id", async () => {
    const root = tempModels();
    writeJson(root, "RAAS-v1", "actions_v1.json", { actions: [{ id: "1", name: "old", actor: ["Agent"] }] });
    writeJson(root, "raas-v2", "actions_v1.json", { actions: [{ id: "2", name: "new", actor: ["Agent"] }] });
    const source = new ManifestOntologySource(root);

    await expect(source.listDomains()).rejects.toThrow(/身份冲突.*RAAS-v1.*raas-v2.*raas/);
    await expect(source.fetchOntology("raas")).rejects.toThrow(/身份冲突/);
    await expect(source.fetchActionRules("raas", "old")).rejects.toThrow(/身份冲突/);
  });

  it("never treats a deployed workflow artifact as an ontology", async () => {
    const root = tempModels();
    writeJson(root, "Agents-generation-v1", "workflow_v1.json", {
      agents: [{ id: "a1", name: "generate", actor: ["Agent"], trigger: [], triggered_event: [] }],
    });
    const source = new ManifestOntologySource(root);

    expect(await source.listDomains()).toEqual([]);
    await expect(source.fetchOntology("agents-generation")).rejects.toThrow(/没有可用的动作定义/);
    await expect(source.fetchOntology("Agents-generation")).rejects.toThrow(/找不到业务域/);
  });

  it("does not alias an Allmeta failure to a differently-cased local artifact", async () => {
    const root = tempModels();
    writeJson(root, "Agents-generation-v1", "workflow_v1.json", {
      agents: [{ id: "a1", name: "generate", actor: ["Agent"], trigger: [], triggered_event: [] }],
    });
    const manifest = new ManifestOntologySource(root);
    const down: OntologySource = {
      async listDomains() { return []; },
      async fetchOntology() { throw new Error("allmeta unavailable"); },
      async fetchActionRules() { throw new Error("allmeta unavailable"); },
    };
    const source = new CompositeOntologySource(down, manifest);

    await expect(source.fetchOntology("Agents-generation")).rejects.toThrow("allmeta unavailable");
    await expect(source.fetchOntology("agents-generation")).rejects.toThrow("allmeta unavailable");
  });
});
