import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { resolveAgentConcurrency, resolveAgentTriggerNames } from "./register";

describe("manifest registration config", () => {
  it("keeps the legacy subject limit when concurrency is omitted", () => {
    assert.deepEqual(resolveAgentConcurrency({}, "tenant-a"), {
      limit: 8,
      key: '"tenant-a:" + event.data.subject',
    });
  });

  it("honors disabled and restricted custom concurrency settings", () => {
    assert.equal(
      resolveAgentConcurrency({ concurrency: { enabled: false } }, "tenant-a"),
      undefined,
    );
    assert.deepEqual(
      resolveAgentConcurrency(
        {
          concurrency: {
            enabled: true,
            max_concurrent_executions: 3,
            key: "$.inputs.candidate.id",
          },
        },
        "tenant-a",
      ),
      {
        limit: 3,
        key: '"tenant-a:" + event.data.inputs.candidate.id',
      },
    );
  });

  it("rejects arbitrary concurrency expressions", () => {
    assert.throws(
      () =>
        resolveAgentConcurrency(
          {
            concurrency: {
              enabled: true,
              max_concurrent_executions: 2,
              key: "$.subject + env.SECRET",
            },
          },
          "tenant-a",
        ),
      /restricted event-data path/,
    );
    assert.throws(
      () =>
        resolveAgentConcurrency(
          {
            concurrency: {
              enabled: true,
              max_concurrent_executions: 0,
            },
          },
          "tenant-a",
        ),
      /integer from 1 to 1000/,
    );
  });

  it("registers a synthetic event trigger for cron-only agents", () => {
    assert.deepEqual(
      resolveAgentTriggerNames({
        name: "nightlyAgent",
        trigger: [],
        cron: "0 2 * * *",
      }),
      ["__schedule.nightlyAgent"],
    );
    assert.deepEqual(
      resolveAgentTriggerNames({ name: "manualAgent", trigger: [] }),
      [],
    );
  });
});
