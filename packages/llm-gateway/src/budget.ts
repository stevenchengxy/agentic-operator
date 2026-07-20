/**
 * Atomic per-tenant LLM budget reservations.
 *
 * A provider call must first reserve a conservative input/output envelope in
 * SQLite using BEGIN IMMEDIATE. Concurrent processes therefore serialize the
 * cap check + insert and cannot all observe the same remaining capacity.
 * Successful calls settle to actual usage. Definitively unbilled failures
 * release capacity; ambiguous network/provider failures are charged using the
 * reserved envelope. A crashed process leaves a lease which is conservatively
 * accounted at expiry instead of silently reopening budget capacity.
 */

import { getRawSqlite } from "@agentic/db";
import { PROVIDER_MODEL_CATALOG } from "@agentic/contracts";
import { makeId } from "@agentic/shared";
import { isLLMError, LLMError } from "./errors";
import type { ChatRequest, ProviderId } from "./types";
import {
  estimateTokenCostCents,
  resolveModelTokenPricing,
} from "./pricing";

const RESERVATION_GRACE_MS = 60_000;

export interface BudgetReservation {
  id: string;
  tenantId: string;
  provider: ProviderId;
  model: string;
  perAttemptReservedTokens: number;
  perAttemptReservedUsdCents: number;
  maxAttempts: number;
  reservedTokens: number;
  reservedUsdCents: number;
  expiresAt: number;
}

export interface ActiveBudgetReservations {
  count: number;
  reservedTokens: number;
  reservedUsdCents: number;
}

interface RawBudgetRow {
  tenant_id: string;
  monthly_token_cap: number | null;
  monthly_usd_cap: number | null;
  used_tokens_month: number;
  used_usd_month: number;
  period_start: number;
}

interface RawReservationRow {
  id: string;
  tenant_id: string;
  provider: string;
  model: string;
  reserved_tokens: number;
  reserved_usd_cents: number;
  status: "active" | "settled" | "released" | "expired";
  actual_tokens: number | null;
  actual_usd_cents: number | null;
  expires_at: number;
  outcome: string | null;
}

function currentMonthStartMs(at = new Date()): number {
  return Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), 1);
}

function modelOutputLimit(provider: ProviderId, model: string): number | null {
  const hit = PROVIDER_MODEL_CATALOG[provider].find(
    (candidate) => candidate.name === model,
  );
  return hit?.out ?? null;
}

/** UTF-8 bytes are a conservative upper bound for BPE-like text tokenizers:
 * every token consumes at least one encoded byte. Tool schemas and structured
 * content are included because providers tokenize those request fields too. */
export function estimateInputTokenUpperBound(
  request: Pick<ChatRequest, "messages" | "tools" | "stop" | "jsonMode">,
): number {
  const serialized = JSON.stringify({
    messages: request.messages,
    tools: request.tools ?? null,
    stop: request.stop ?? null,
    jsonMode: request.jsonMode ?? false,
  });
  return Math.max(1, Buffer.byteLength(serialized, "utf8"));
}

function normalizeMaxOutputTokens(
  request: Pick<ChatRequest, "maxTokens">,
  provider: ProviderId,
  model: string,
): number | null {
  if (
    typeof request.maxTokens === "number" &&
    Number.isFinite(request.maxTokens) &&
    request.maxTokens > 0
  ) {
    return Math.ceil(request.maxTokens);
  }
  return modelOutputLimit(provider, model);
}

function ensureCurrentBudgetRow(
  tenantId: string,
  now: number,
): RawBudgetRow {
  const sqlite = getRawSqlite();
  const monthStart = currentMonthStartMs(new Date(now));
  sqlite
    .prepare(
      `INSERT INTO tenant_budgets
        (tenant_id, monthly_token_cap, monthly_usd_cap, used_tokens_month,
         used_usd_month, period_start, updated_at)
       VALUES (?, NULL, NULL, 0, 0, ?, ?)
       ON CONFLICT(tenant_id) DO NOTHING`,
    )
    .run(tenantId, monthStart, now);
  let row = sqlite
    .prepare("SELECT * FROM tenant_budgets WHERE tenant_id = ?")
    .get(tenantId) as RawBudgetRow | undefined;
  if (!row) throw new Error(`failed to materialize tenant budget ${tenantId}`);
  if (row.period_start < monthStart) {
    sqlite
      .prepare(
        `UPDATE tenant_budgets
         SET period_start = ?, used_tokens_month = 0, used_usd_month = 0,
             updated_at = ?
         WHERE tenant_id = ?`,
      )
      .run(monthStart, now, tenantId);
    sqlite
      .prepare(
        `UPDATE llm_budget_reservations
         SET status = 'expired', settled_at = ?, outcome = 'period_rotated'
         WHERE tenant_id = ? AND status = 'active'`,
      )
      .run(now, tenantId);
    row = {
      ...row,
      period_start: monthStart,
      used_tokens_month: 0,
      used_usd_month: 0,
    };
  }
  return row;
}

function expireStaleReservations(
  tenantId: string,
  periodStart: number,
  now: number,
): void {
  const sqlite = getRawSqlite();

  // Reservations from a previous accounting period must never consume the
  // new period. This also repairs rows when another code path rotated the
  // tenant_budgets row before the gateway next touched it.
  sqlite
    .prepare(
      `UPDATE llm_budget_reservations
       SET status = 'expired', settled_at = ?, outcome = 'period_rotated'
       WHERE tenant_id = ? AND status = 'active'
         AND created_at < ?`,
    )
    .run(now, tenantId, periodStart);

  const stale = sqlite
    .prepare(
      `SELECT count(*) AS count,
              coalesce(sum(reserved_tokens), 0) AS reservedTokens,
              coalesce(sum(reserved_usd_cents), 0) AS reservedUsdCents
       FROM llm_budget_reservations
       WHERE tenant_id = ? AND status = 'active'
         AND expires_at <= ? AND created_at >= ?`,
    )
    .get(tenantId, now, periodStart) as {
      count: number;
      reservedTokens: number;
      reservedUsdCents: number;
    };
  if (Number(stale.count) === 0) return;

  // Once a process has disappeared we cannot prove whether an upstream call
  // completed and was billed. Charging the full reservation is deliberately
  // fail-closed: a crash can reduce available capacity, but can never cause a
  // capped tenant to spend beyond a capacity snapshot that was reopened.
  sqlite
    .prepare(
      `UPDATE tenant_budgets
       SET used_tokens_month = used_tokens_month + ?,
           used_usd_month = used_usd_month + ?, updated_at = ?
       WHERE tenant_id = ?`,
    )
    .run(
      Number(stale.reservedTokens),
      Number(stale.reservedUsdCents),
      now,
      tenantId,
    );
  sqlite
    .prepare(
      `UPDATE llm_budget_reservations
       SET status = 'expired', actual_tokens = reserved_tokens,
           actual_usd_cents = reserved_usd_cents, settled_at = ?,
           outcome = 'lease_expired_conservative'
       WHERE tenant_id = ? AND status = 'active'
         AND expires_at <= ? AND created_at >= ?`,
    )
    .run(now, tenantId, now, periodStart);
}

function storageError(
  provider: ProviderId,
  operation: string,
  error: unknown,
): LLMError {
  if (isLLMError(error)) return error;
  return new LLMError(
    `LLM ${operation} failed because durable budget storage is unavailable`,
    "budget_storage",
    provider,
    error,
  );
}

function activeTotals(
  tenantId: string,
  periodStart: number,
  excludeId?: string,
): ActiveBudgetReservations {
  const row = getRawSqlite()
    .prepare(
      `SELECT count(*) AS count,
              coalesce(sum(reserved_tokens), 0) AS reservedTokens,
              coalesce(sum(reserved_usd_cents), 0) AS reservedUsdCents
       FROM llm_budget_reservations
       WHERE tenant_id = ? AND status = 'active' AND created_at >= ?
         AND (? IS NULL OR id <> ?)`,
    )
    .get(tenantId, periodStart, excludeId ?? null, excludeId ?? null) as {
      count: number;
      reservedTokens: number;
      reservedUsdCents: number;
    };
  return {
    count: Number(row.count),
    reservedTokens: Number(row.reservedTokens),
    reservedUsdCents: Number(row.reservedUsdCents),
  };
}

function capError(
  tenantId: string,
  provider: ProviderId,
  dimension: "token" | "USD",
  used: number,
  active: number,
  requested: number,
  cap: number,
): LLMError {
  return new LLMError(
    `tenant ${tenantId} ${dimension} budget reservation rejected: used=${used}, active=${active}, requested=${requested}, cap=${cap}`,
    "cost_limit_exceeded",
    provider,
  );
}

/** Atomically reserve worst-case capacity before touching a provider. */
export function reserveBudget(args: {
  tenantId: string | undefined;
  provider: ProviderId;
  model: string | null | undefined;
  request: Pick<
    ChatRequest,
    "messages" | "tools" | "stop" | "jsonMode" | "maxTokens"
  >;
  timeoutMs: number;
  /** Maximum provider attempts that can be billable for this reservation. */
  maxAttempts?: number;
}): BudgetReservation | null {
  if (!args.tenantId) return null;
  const tenantId = args.tenantId;
  const model = args.model?.trim() ?? "";
  const provider = args.provider;
  const now = Date.now();
  const expiresAt = now + Math.max(1_000, args.timeoutMs) + RESERVATION_GRACE_MS;
  const id = makeId("brv");
  const sqlite = getRawSqlite();

  const transaction = sqlite.transaction((): BudgetReservation => {
    const budget = ensureCurrentBudgetRow(tenantId, now);
    expireStaleReservations(tenantId, budget.period_start, now);
    const active = activeTotals(tenantId, budget.period_start);
    const hasTokenCap = budget.monthly_token_cap !== null;
    const hasUsdCap = budget.monthly_usd_cap !== null;

    if (!model && (hasTokenCap || hasUsdCap)) {
      throw new LLMError(
        `tenant ${tenantId} has a budget cap but the provider model is unset`,
        "cost_limit_exceeded",
        provider,
      );
    }

    const inputBound = estimateInputTokenUpperBound(args.request);
    const outputBound = normalizeMaxOutputTokens(args.request, provider, model);
    if ((hasTokenCap || hasUsdCap) && outputBound === null) {
      throw new LLMError(
        `tenant ${tenantId} has a budget cap but ${provider}/${model || "<unset>"} has no bounded max output; set maxTokens or catalog the model`,
        "cost_limit_exceeded",
        provider,
      );
    }
    const maxAttempts = Math.max(1, Math.ceil(args.maxAttempts ?? 1));
    const perAttemptReservedTokens = inputBound + (outputBound ?? 0);
    const reservedTokens = perAttemptReservedTokens * maxAttempts;

    const priced = resolveModelTokenPricing({ provider, model });
    if (hasUsdCap && !priced) {
      throw new LLMError(
        `tenant ${tenantId} has a monthly USD cap but ${provider}/${model || "<unset>"} has no configured provider+model price; refusing an unenforceable call`,
        "cost_limit_exceeded",
        provider,
      );
    }
    const perAttemptReservedUsdCents =
      estimateTokenCostCents({
        provider,
        model,
        tokensIn: inputBound,
        tokensOut: outputBound ?? 0,
      })?.usdCents ?? 0;
    // Round each potentially billable request independently. One timeout can
    // be charged upstream even when its response never reaches us.
    const reservedUsdCents = perAttemptReservedUsdCents * maxAttempts;

    if (
      budget.monthly_token_cap !== null &&
      budget.used_tokens_month + active.reservedTokens + reservedTokens >
        budget.monthly_token_cap
    ) {
      throw capError(
        tenantId,
        provider,
        "token",
        budget.used_tokens_month,
        active.reservedTokens,
        reservedTokens,
        budget.monthly_token_cap,
      );
    }
    if (
      budget.monthly_usd_cap !== null &&
      budget.used_usd_month + active.reservedUsdCents + reservedUsdCents >
        budget.monthly_usd_cap
    ) {
      throw capError(
        tenantId,
        provider,
        "USD",
        budget.used_usd_month,
        active.reservedUsdCents,
        reservedUsdCents,
        budget.monthly_usd_cap,
      );
    }

    sqlite
      .prepare(
        `INSERT INTO llm_budget_reservations
          (id, tenant_id, provider, model, reserved_tokens,
           reserved_usd_cents, status, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
      )
      .run(
        id,
        tenantId,
        provider,
        model,
        reservedTokens,
        reservedUsdCents,
        now,
        expiresAt,
      );
    return {
      id,
      tenantId,
      provider,
      model,
      perAttemptReservedTokens,
      perAttemptReservedUsdCents,
      maxAttempts,
      reservedTokens,
      reservedUsdCents,
      expiresAt,
    };
  });

  // BEGIN IMMEDIATE obtains the SQLite write lock before the cap read, so a
  // second process cannot pass the same remaining-capacity snapshot.
  try {
    return transaction.immediate();
  } catch (error) {
    throw storageError(provider, "budget reservation", error);
  }
}

/** Settle a successful provider call to actual usage. Any invariant breach is
 * recorded first, then surfaced as a terminal budget error. */
export function settleBudgetReservation(args: {
  reservation: BudgetReservation | null;
  servedModel: string;
  tokensIn: number;
  tokensOut: number;
  /** Earlier attempts whose billing outcome is unknowable (timeout/network/
   *  provider 5xx). Their full envelope is conservatively charged. */
  uncertainAttempts?: number;
}): { tokens: number; usdCents: number | null } | null {
  const reservation = args.reservation;
  if (!reservation) return null;
  const tokensIn = Number.isFinite(args.tokensIn) ? Math.max(0, args.tokensIn) : 0;
  const tokensOut = Number.isFinite(args.tokensOut) ? Math.max(0, args.tokensOut) : 0;
  const uncertainAttempts = Math.min(
    reservation.maxAttempts,
    Math.max(0, Math.ceil(args.uncertainAttempts ?? 0)),
  );
  const actualTokens =
    tokensIn +
    tokensOut +
    reservation.perAttemptReservedTokens * uncertainAttempts;
  const cost = estimateTokenCostCents({
    provider: reservation.provider,
    model: args.servedModel,
    tokensIn,
    tokensOut,
  });
  const actualUsdCents = cost
    ? cost.usdCents +
      reservation.perAttemptReservedUsdCents * uncertainAttempts
    : null;
  const now = Date.now();
  const sqlite = getRawSqlite();
  let violation: LLMError | null = null;

  const transaction = sqlite.transaction(() => {
    const budget = ensureCurrentBudgetRow(reservation.tenantId, now);
    // Expire first, then read the reservation. Reading before this update
    // leaves a stale in-memory `active` status and can incorrectly accept a
    // provider response whose lease already released capacity to another call.
    expireStaleReservations(reservation.tenantId, budget.period_start, now);
    const row = sqlite
      .prepare("SELECT * FROM llm_budget_reservations WHERE id = ?")
      .get(reservation.id) as RawReservationRow | undefined;
    if (!row) {
      throw new LLMError(
        `budget reservation ${reservation.id} disappeared before settlement`,
        "cost_limit_exceeded",
        reservation.provider,
      );
    }
    if (row.status === "settled") return;
    if (
      row.status === "expired" &&
      row.outcome === "lease_expired_conservative"
    ) {
      violation = new LLMError(
        `budget reservation ${reservation.id} expired before settlement; its full envelope was already conservatively accounted and the late response is rejected`,
        "cost_limit_exceeded",
        reservation.provider,
      );
      return;
    }
    const others = activeTotals(
      reservation.tenantId,
      budget.period_start,
      reservation.id,
    );

    if (row.status !== "active") {
      violation = new LLMError(
        `budget reservation ${reservation.id} was ${row.status} before settlement; actual usage was recorded but the call is rejected`,
        "cost_limit_exceeded",
        reservation.provider,
      );
    } else if (budget.monthly_usd_cap !== null && actualUsdCents === null) {
      violation = new LLMError(
        `tenant ${reservation.tenantId} has a USD cap but served model ${reservation.provider}/${args.servedModel} is unpriced; actual tokens were recorded and the call is rejected`,
        "cost_limit_exceeded",
        reservation.provider,
      );
    } else if (
      budget.monthly_token_cap !== null &&
      budget.used_tokens_month + others.reservedTokens + actualTokens >
        budget.monthly_token_cap
    ) {
      violation = capError(
        reservation.tenantId,
        reservation.provider,
        "token",
        budget.used_tokens_month,
        others.reservedTokens,
        actualTokens,
        budget.monthly_token_cap,
      );
    } else if (
      budget.monthly_usd_cap !== null &&
      budget.used_usd_month + others.reservedUsdCents + (actualUsdCents ?? 0) >
        budget.monthly_usd_cap
    ) {
      violation = capError(
        reservation.tenantId,
        reservation.provider,
        "USD",
        budget.used_usd_month,
        others.reservedUsdCents,
        actualUsdCents ?? 0,
        budget.monthly_usd_cap,
      );
    }

    sqlite
      .prepare(
        `UPDATE tenant_budgets
         SET used_tokens_month = used_tokens_month + ?,
             used_usd_month = used_usd_month + ?, updated_at = ?
         WHERE tenant_id = ?`,
      )
      .run(
        actualTokens,
        actualUsdCents ?? 0,
        now,
        reservation.tenantId,
      );
    sqlite
      .prepare(
        `UPDATE llm_budget_reservations
         SET status = 'settled', actual_tokens = ?, actual_usd_cents = ?,
             settled_at = ?, outcome = ?
         WHERE id = ?`,
      )
      .run(
        actualTokens,
        actualUsdCents,
        now,
        violation
          ? `settled_rejected:${violation.message}`.slice(0, 500)
          : uncertainAttempts > 0
            ? `settled_conservative:${uncertainAttempts}_uncertain_attempts`
            : "settled",
        reservation.id,
      );
  });
  try {
    transaction.immediate();
  } catch (error) {
    throw storageError(reservation.provider, "budget settlement", error);
  }
  if (violation) throw violation;
  return { tokens: actualTokens, usdCents: actualUsdCents };
}

/** Release a failed/cancelled provider attempt. Idempotent after settlement. */
export function releaseBudgetReservation(
  reservation: BudgetReservation | null,
  outcome = "provider_failed",
): void {
  if (!reservation) return;
  const transaction = getRawSqlite().transaction(() => {
    getRawSqlite()
      .prepare(
        `UPDATE llm_budget_reservations
         SET status = 'released', settled_at = ?, outcome = ?
         WHERE id = ? AND status = 'active'`,
      )
      .run(Date.now(), outcome.slice(0, 500), reservation.id);
  });
  try {
    transaction.immediate();
  } catch (error) {
    throw storageError(reservation.provider, "budget release", error);
  }
}

/** Current active reservation totals for supervision and budget UI. */
export function getActiveBudgetReservations(
  tenantId: string,
): ActiveBudgetReservations {
  const sqlite = getRawSqlite();
  const now = Date.now();
  const transaction = sqlite.transaction(() => {
    const existing = sqlite
      .prepare("SELECT * FROM tenant_budgets WHERE tenant_id = ?")
      .get(tenantId) as RawBudgetRow | undefined;
    if (!existing) return { count: 0, reservedTokens: 0, reservedUsdCents: 0 };
    const budget = ensureCurrentBudgetRow(tenantId, now);
    expireStaleReservations(tenantId, budget.period_start, now);
    return activeTotals(tenantId, budget.period_start);
  });
  return transaction.immediate();
}

// Compatibility forecast hook retained for older tests/callers. Unlike the
// removed provider-average implementation, unknown models return null.
function costCents(
  provider: ProviderId,
  model: string,
  tokensIn: number,
  tokensOut: number,
): number | null {
  return estimateTokenCostCents({ provider, model, tokensIn, tokensOut })
    ?.usdCents ?? null;
}
export { costCents as __costCentsForTest };
