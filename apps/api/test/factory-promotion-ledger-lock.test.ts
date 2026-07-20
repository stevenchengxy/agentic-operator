import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  withFactoryPromotionRegressionLedgerLock,
  type FactoryPromotionRegressionLedgerLockOptions,
} from "../src/services/agent-factory/promotion-regression-ledger";

const lockSchema = "agent-factory-promotion-ledger-lock/v1";
const options: FactoryPromotionRegressionLedgerLockOptions = {
  leaseTtlMs: 250,
  heartbeatMs: 25,
  acquireTimeoutMs: 2_500,
  retryMs: 5,
  reclaimObservationMs: 5,
  mutationGuardTtlMs: 1_000,
};

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "factory-promotion-lock-"));
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("Factory promotion regression ledger lease lock", () => {
  it("atomically reclaims a crash-stale owner after the conservative lease TTL", async () => {
    const lockPath = path.join(root, ".finalize.lock");
    await fs.writeFile(
      lockPath,
      `${JSON.stringify({
        schema: lockSchema,
        token: "crashed-owner",
        pid: 99_999,
        acquiredAt: new Date(0).toISOString(),
        leaseTtlMs: options.leaseTtlMs,
      })}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
    const stale = new Date(Date.now() - 10_000);
    await fs.utimes(lockPath, stale, stale);

    let entered = false;
    await withFactoryPromotionRegressionLedgerLock(
      root,
      async () => {
        entered = true;
      },
      options,
    );

    expect(entered).toBe(true);
    await expect(fs.access(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(
      (await fs.readdir(root)).filter((entry) => entry.includes(".stale.")),
    ).toEqual([]);
  });

  it("heartbeats a live owner so a waiter cannot steal it after the original mtime would expire", async () => {
    let releaseFirst!: () => void;
    let firstEntered!: () => void;
    const entered = new Promise<void>((resolve) => {
      firstEntered = resolve;
    });
    const hold = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const order: string[] = [];

    const first = withFactoryPromotionRegressionLedgerLock(
      root,
      async () => {
        order.push("first-enter");
        firstEntered();
        await hold;
        order.push("first-leave");
      },
      options,
    );
    await entered;

    let secondEntered = false;
    const second = withFactoryPromotionRegressionLedgerLock(
      root,
      async () => {
        secondEntered = true;
        order.push("second-enter");
      },
      options,
    );

    await delay(650);
    expect(secondEntered).toBe(false);
    const activeStat = await fs.stat(path.join(root, ".finalize.lock"));
    expect(Date.now() - activeStat.mtimeMs).toBeLessThan(options.leaseTtlMs!);

    releaseFirst();
    await Promise.all([first, second]);
    expect(order).toEqual(["first-enter", "first-leave", "second-enter"]);
  });

  it("refuses to unlink a lock whose owner token changed before release", async () => {
    const lockPath = path.join(root, ".finalize.lock");
    const foreignToken = "foreign-owner-token";
    await expect(
      withFactoryPromotionRegressionLedgerLock(
        root,
        async () => {
          await fs.writeFile(
            lockPath,
            `${JSON.stringify({
              schema: lockSchema,
              token: foreignToken,
              pid: 88_888,
              acquiredAt: new Date().toISOString(),
              leaseTtlMs: 3_000,
            })}\n`,
            "utf8",
          );
        },
        {
          ...options,
          leaseTtlMs: 3_000,
          heartbeatMs: 1_000,
        },
      ),
    ).rejects.toThrow("release refused a different owner token");

    const foreign = JSON.parse(await fs.readFile(lockPath, "utf8")) as {
      token: string;
    };
    expect(foreign.token).toBe(foreignToken);
  });
});
