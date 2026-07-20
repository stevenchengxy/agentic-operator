import { auditLog, getDb } from "@agentic/db";
import { makeId } from "@agentic/shared";
import { publishStreamEvent } from "@agentic/runtime";

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
  try {
    const decision = entry.meta?.decision;
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
    });
  } catch {
    /* audit durability is authoritative; live delivery is best-effort */
  }
}
