/**
 * GET / PUT /v1/budgets — tenant-scoped budget management (P1-API-04).
 *
 *   GET  /v1/budgets         → current row (creates a default-empty one when missing)
 *   PUT  /v1/budgets         → upsert monthly caps; resets usage if `reset=true`
 *
 * Body for PUT (all fields optional):
 *
 *   {
 *     monthlyTokenCap?: number | null,
 *     monthlyUsdCap?:   number | null,   // integer cents
 *     reset?:           boolean          // when true, zeros used_* counters
 *                                        // and sets period_start to now
 *   }
 *
 * Setting a cap to `null` removes the cap (unlimited). Operators can also
 * set 0 to refuse all calls; the gateway treats `used > cap` as over-budget
 * for any non-null cap.
 */

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { getDb, getRawSqlite, tenantBudgets } from "@agentic/db";
import { getActiveBudgetReservations } from "@agentic/llm-gateway";
import { requirePermission } from "../../plugins/rbac";
import { writeAudit } from "../../plugins/audit";
import {
  ensureBudgetRow,
  reconcileBudgetUsage,
} from "../../services/usage-accounting";

const BudgetUpdateBody = z.object({
  monthlyTokenCap: z.number().int().nonnegative().nullable().optional(),
  monthlyUsdCap: z.number().int().nonnegative().nullable().optional(),
  reset: z.boolean().optional(),
});

class ActiveBudgetResetError extends Error {
  constructor(readonly count: number, readonly reservedTokens: number, readonly reservedUsdCents: number) {
    super(`Cannot reset budget while ${count} LLM call(s) are in flight`);
  }
}

function shapeRow(
  row: typeof tenantBudgets.$inferSelect,
) {
  const reservations = getActiveBudgetReservations(row.tenantId);
  // Lease expiry can conservatively increment the durable counters. Reload
  // after observing reservations so this same response never presents stale
  // lower usage alongside an already-disappeared active reservation.
  const refreshed = getDb()
    .select()
    .from(tenantBudgets)
    .where(eq(tenantBudgets.tenantId, row.tenantId))
    .all()[0] ?? row;
  const usage = reconcileBudgetUsage(refreshed);
  return {
    tenantId: refreshed.tenantId,
    monthlyTokenCap: refreshed.monthlyTokenCap,
    monthlyUsdCap: refreshed.monthlyUsdCap,
    usedTokensMonth: usage.tokens,
    usedUsdMonth: usage.usdCents,
    unpricedTokens: usage.unpricedTokens,
    costComplete: usage.costComplete,
    activeReservations: reservations.count,
    reservedTokens: reservations.reservedTokens,
    reservedUsdCents: reservations.reservedUsdCents,
    periodStart: refreshed.periodStart.getTime(),
    updatedAt: refreshed.updatedAt.getTime(),
  };
}

export async function budgetsRoutes(app: FastifyInstance): Promise<void> {
  app.get("/budgets", async (req, reply) => {
    const auth = requirePermission(req, "usage.read");
    const row = ensureBudgetRow(auth.tenantId);
    return reply.ok(shapeRow(row));
  });

  app.put("/budgets", async (req, reply) => {
    const auth = requirePermission(req, "budgets.write");
    const body = BudgetUpdateBody.parse(req.body ?? {});
    const db = getDb();
    ensureBudgetRow(auth.tenantId);

    const update: Partial<typeof tenantBudgets.$inferInsert> = {
      updatedAt: new Date(),
    };
    if (body.monthlyTokenCap !== undefined) {
      update.monthlyTokenCap = body.monthlyTokenCap;
    }
    if (body.monthlyUsdCap !== undefined) {
      update.monthlyUsdCap = body.monthlyUsdCap;
    }
    if (body.reset) {
      update.usedTokensMonth = 0;
      update.usedUsdMonth = 0;
      update.periodStart = new Date();
    }

    try {
      // Serialize reset/cap changes with reserveBudget's BEGIN IMMEDIATE.
      // Otherwise a call can reserve between a reset precheck and the update.
      getRawSqlite().transaction(() => {
        if (body.reset) {
          const now = Date.now();
          getRawSqlite().prepare(
            `UPDATE llm_budget_reservations
             SET status = 'expired', actual_tokens = reserved_tokens,
                 actual_usd_cents = reserved_usd_cents, settled_at = ?,
                 outcome = 'lease_expired_conservative'
             WHERE tenant_id = ? AND status = 'active' AND expires_at <= ?`,
          ).run(now, auth.tenantId, now);
          const active = getRawSqlite().prepare(
            `SELECT count(*) AS count,
                    coalesce(sum(reserved_tokens), 0) AS reservedTokens,
                    coalesce(sum(reserved_usd_cents), 0) AS reservedUsdCents
             FROM llm_budget_reservations
             WHERE tenant_id = ? AND status = 'active'`,
          ).get(auth.tenantId) as {
            count: number;
            reservedTokens: number;
            reservedUsdCents: number;
          };
          if (Number(active.count) > 0) {
            throw new ActiveBudgetResetError(
              Number(active.count),
              Number(active.reservedTokens),
              Number(active.reservedUsdCents),
            );
          }
        }
        db.update(tenantBudgets)
          .set(update)
          .where(eq(tenantBudgets.tenantId, auth.tenantId))
          .run();
      }).immediate();
    } catch (error) {
      if (error instanceof ActiveBudgetResetError) {
        return reply.status(409).send({
          error: {
            code: "budget_reservations_active",
            message: error.message,
            details: {
              count: error.count,
              reservedTokens: error.reservedTokens,
              reservedUsdCents: error.reservedUsdCents,
            },
          },
        });
      }
      throw error;
    }

    const after = db
      .select()
      .from(tenantBudgets)
      .where(eq(tenantBudgets.tenantId, auth.tenantId))
      .all()[0]!;

    writeAudit({
      tenantId: auth.tenantId,
      actorUserId: auth.userId ?? undefined,
      action: "budget.update",
      targetType: "tenant_budget",
      targetId: auth.tenantId,
      meta: {
        monthlyTokenCap: after.monthlyTokenCap,
        monthlyUsdCap: after.monthlyUsdCap,
        reset: body.reset === true,
      },
    });

    return reply.ok(shapeRow(after));
  });
}
