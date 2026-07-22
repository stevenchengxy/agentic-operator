import { auditLog, getDb } from "@agentic/db";
import { makeId } from "@agentic/shared";
// NOTE: `publishStreamEvent` is imported lazily at call time (see writeAudit)
// so importing audit/rbac/auth never eagerly evaluates @agentic/runtime, whose
// module top-level builds the system Inngest client and would otherwise demand
// production Inngest credentials merely to import the auth plugin.

export interface AuditEntry {
  tenantId: string;
  actorUserId?: string;
  action: string;
  targetType?: string;
  targetId?: string;
  meta?: Record<string, unknown>;
}

export function writeAudit(entry: AuditEntry): void {
  const db = getDb();
  const id = makeId("aud");
  const at = new Date();
  db.insert(auditLog)
    .values({
      id,
      tenantId: entry.tenantId,
      actorUserId: entry.actorUserId ?? null,
      action: entry.action,
      targetType: entry.targetType ?? null,
      targetId: entry.targetId ?? null,
      at,
      metaJson: (entry.meta ?? null) as never,
    })
    .run();
  const decision = entry.meta?.decision;
  // Fire-and-forget lazy load: the audit row is already durably persisted
  // above; live stream delivery is best-effort, so a dynamic import that
  // resolves @agentic/runtime only at call time (never at module import) keeps
  // the same durability contract without the import-time credential landmine.
  void import("@agentic/runtime")
    .then(({ publishStreamEvent }) =>
      publishStreamEvent({
        type: "audit.recorded",
        tenantId: entry.tenantId,
        at: at.getTime(),
        auditId: id,
        action: entry.action,
        actorUserId: entry.actorUserId ?? null,
        targetType: entry.targetType ?? null,
        targetId: entry.targetId ?? null,
        decision: decision === "allow" || decision === "deny" ? decision : null,
      }),
    )
    .catch(() => {
      /* audit durability is authoritative; live delivery is best-effort */
    });
}
