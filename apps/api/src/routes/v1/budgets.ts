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
import { getDb, tenantBudgets } from "@agentic/db";
import { requireAuth } from "../../plugins/auth";
import { writeAudit } from "../../plugins/audit";

const BudgetUpdateBody = z.object({
  monthlyTokenCap: z.number().int().nonnegative().nullable().optional(),
  monthlyUsdCap: z.number().int().nonnegative().nullable().optional(),
  reset: z.boolean().optional(),
});

function shapeRow(row: typeof tenantBudgets.$inferSelect) {
  return {
    tenantId: row.tenantId,
    monthlyTokenCap: row.monthlyTokenCap,
    monthlyUsdCap: row.monthlyUsdCap,
    usedTokensMonth: row.usedTokensMonth,
    usedUsdMonth: row.usedUsdMonth,
    usedUsdNanos: row.usedUsdNanos,
    periodStart: row.periodStart.getTime(),
    updatedAt: row.updatedAt.getTime(),
  };
}

function ensureRow(tenantId: string) {
  const db = getDb();
  let row = db
    .select()
    .from(tenantBudgets)
    .where(eq(tenantBudgets.tenantId, tenantId))
    .all()[0];
  if (!row) {
    db.insert(tenantBudgets)
      .values({
        tenantId,
        monthlyTokenCap: null,
        monthlyUsdCap: null,
        usedTokensMonth: 0,
        usedUsdMonth: 0,
      })
      .onConflictDoNothing({ target: tenantBudgets.tenantId })
      .run();
    row = db
      .select()
      .from(tenantBudgets)
      .where(eq(tenantBudgets.tenantId, tenantId))
      .all()[0]!;
  }
  return row;
}

export async function budgetsRoutes(app: FastifyInstance): Promise<void> {
  app.get("/budgets", async (req, reply) => {
    const auth = requireAuth(req);
    const row = ensureRow(auth.tenantId);
    return reply.ok(shapeRow(row));
  });

  app.put("/budgets", async (req, reply) => {
    const auth = requireAuth(req);
    const body = BudgetUpdateBody.parse(req.body ?? {});
    const db = getDb();
    ensureRow(auth.tenantId);

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
      update.usedUsdNanos = 0;
      update.periodStart = new Date();
    }

    db.update(tenantBudgets)
      .set(update)
      .where(eq(tenantBudgets.tenantId, auth.tenantId))
      .run();

    const after = db
      .select()
      .from(tenantBudgets)
      .where(eq(tenantBudgets.tenantId, auth.tenantId))
      .all()[0]!;

    writeAudit({
      tenantId: auth.tenantId,
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
