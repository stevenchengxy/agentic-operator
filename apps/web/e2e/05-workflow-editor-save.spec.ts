/**
 * P4-TEST-05 — E2E: workflow editor save.
 *
 * Goes through `POST /v1/agents` (the manifest upload route — same one
 * the portal's workflow-editor save button calls and the same one
 * `agentic deploy` POSTs to). Asserts:
 *
 *   (a) A `workflow_versions` row was inserted (the response carries
 *       `workflow_version_id` + `version`).
 *   (b) A `deployments` row exists at `status='live'` after the call.
 *       The route auto-creates a deployment row pointing at the new
 *       version.
 *   (c) The next bootstrap / event-replay would use the new spec —
 *       inspected indirectly by listing `/v1/deployments` and checking
 *       that the latest live row matches the upload.
 *
 * We exercise the API directly rather than driving the Monaco editor
 * widget through Playwright clicks — the editor save handler is a thin
 * wrapper around the same POST, and the editor itself is covered by
 * the Phase 2 pixel-diff harness. The contract this spec exercises is
 * the wire surface (request shape + DB side effects), which is what
 * fails in production.
 */

import { test, expect } from "@playwright/test";
import { access } from "node:fs/promises";
import { apiFetch } from "./helpers";

interface ManifestAgent {
  id: string;
  name: string;
  description: string;
  actor: string[];
  trigger: string[];
  actions: Array<{
    order: string;
    name: string;
    description: string;
    type: "logic" | "tool" | "manual";
    condition?: string;
  }>;
  triggered_event: string[];
}

const TEST_MANIFEST: ManifestAgent[] = [
  {
    id: "e2e-test-agent",
    name: "e2eTestAgent",
    description: "P4-TEST-05 throwaway agent for workflow save round-trip.",
    actor: ["Agent"],
    trigger: ["E2E_TEST_KICKOFF"],
    actions: [],
    triggered_event: ["E2E_TEST_DONE"],
  },
];

test.describe("P4-TEST-05: workflow editor save E2E", () => {
  test("POST /v1/agents inserts workflow_version + live deployment", async () => {
    const upload = await apiFetch<{
      workflow_version_id: string;
      version: string;
      diff: {
        added: string[];
        modified: string[];
        removed: string[];
        prior_version: string | null;
      };
      note: string | null;
      deployment_id: string;
      file_written: string;
      inngest_fns_registered: number;
    }>("/v1/agents", {
      method: "POST",
      body: JSON.stringify({
        manifest: TEST_MANIFEST,
        note: "P4-TEST-05 e2e",
      }),
    });

    expect(upload.status).toBe(200);
    if (!upload.body.ok) {
      throw new Error(
        `manifest upload failed: ${upload.body.error.code} — ${upload.body.error.message}`,
      );
    }
    const {
      workflow_version_id,
      version,
      diff,
      deployment_id,
      file_written,
      inngest_fns_registered,
    } = upload.body.data;
    expect(workflow_version_id).toMatch(/^wfv-/);
    expect(deployment_id).toMatch(/^dpl-/);
    expect(version).toMatch(/^auto-[a-f0-9]{8}$/);
    expect(diff.added).toContain("e2e-test-agent");
    expect(inngest_fns_registered).toBeGreaterThan(0);
    await expect(access(file_written)).resolves.toBeUndefined();

    // Confirm a live deployment row exists pointing at the new version.
    const deps = await apiFetch<{
      list: Array<{
        id: string;
        versionId: string;
        versionString: string;
        status: string;
      }>;
      live: { id: string; versionString: string } | null;
    }>("/v1/deployments");
    expect(deps.status).toBe(200);
    if (!deps.body.ok) throw new Error("deployments fetch failed");
    const match = deps.body.data.list.find(
      (d) => d.versionId === workflow_version_id,
    );
    expect(match).toBeDefined();
    expect(match?.status).toBe("live");
  });

  test("re-upload of an identical manifest is idempotent (same version)", async () => {
    const first = await apiFetch<{ version: string }>("/v1/agents", {
      method: "POST",
      body: JSON.stringify({
        manifest: TEST_MANIFEST,
      }),
    });
    expect(first.status).toBe(200);
    if (!first.body.ok) throw new Error("first upload failed");
    const v1 = first.body.data.version;

    const second = await apiFetch<{ version: string }>("/v1/agents", {
      method: "POST",
      body: JSON.stringify({
        manifest: TEST_MANIFEST,
      }),
    });
    expect(second.status).toBe(200);
    if (!second.body.ok) throw new Error("second upload failed");
    expect(second.body.data.version).toBe(v1);
  });

  test("modifying a single agent surfaces in the diff modifications list", async () => {
    const initial = await apiFetch("/v1/agents", {
      method: "POST",
      body: JSON.stringify({ manifest: TEST_MANIFEST }),
    });
    expect(initial.status).toBe(200);

    const modified: ManifestAgent[] = [
      {
        ...TEST_MANIFEST[0]!,
        description: "P4-TEST-05 throwaway agent (modified description).",
      },
    ];
    const r = await apiFetch<{
      diff: { added: string[]; modified: string[]; removed: string[] };
    }>("/v1/agents", {
      method: "POST",
      body: JSON.stringify({ manifest: modified }),
    });
    expect(r.status).toBe(200);
    if (!r.body.ok) throw new Error("modify upload failed");
    expect(r.body.data.diff.modified).toContain("e2e-test-agent");
  });
});
