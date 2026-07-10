"use client";

/**
 * Settings → People & roles.
 *
 * Since P6-AUTH the canonical member-management surface is the dedicated
 * "Access & roles" tab (live data + add/role/remove + the superadmin view).
 * This section is now a read-only summary of the current tenant's real
 * members that links out to that tab — no more mock fixtures.
 */

import { Badge, Button, Empty, Panel, Td, Th } from "@/app/portal/components";
import { RoleBadge } from "@/app/portal/components/settings/atoms";
import { useI18n } from "@/app/portal/lib/preferences-context";
import { useTenant } from "@/app/portal/lib/use-tenant";
import { useCan } from "@/lib/hooks/useMe";
import { useMembers } from "@/lib/hooks/useAccess";
import { fmtAgo } from "@/lib/format";

export function PeopleSection() {
  const { t } = useI18n();
  const tenant = useTenant();
  const can = useCan();
  const canRead = can("members.read");
  const { data: members, isLoading } = useMembers(canRead);

  const accessHref = `/portal/${tenant}/access`;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(3, 1fr)",
          gap: 1,
          background: "var(--border)",
          border: "1px solid var(--border)",
          borderRadius: 6,
          overflow: "hidden",
        }}
      >
        {[
          { role: "Admin", hint: t("access.roleHintAdmin") },
          { role: "Operator", hint: t("access.roleHintOperator") },
          { role: "Viewer", hint: t("access.roleHintViewer") },
        ].map((r) => (
          <div key={r.role} style={{ padding: "10px 12px", background: "var(--panel)" }}>
            <div style={{ marginBottom: 5 }}>
              <RoleBadge role={r.role} />
            </div>
            <div style={{ fontSize: 11, color: "var(--text-3)", lineHeight: 1.45 }}>{r.hint}</div>
          </div>
        ))}
      </div>

      <Panel
        title={t("people.membersCount", { count: members?.length ?? 0 })}
        padded={false}
        action={
          <Button small icon="human" tone="primary" onClick={() => (window.location.href = accessHref)}>
            {t("people.openAccess")}
          </Button>
        }
      >
        <div style={{ padding: "10px 14px", borderBottom: "1px solid var(--border)", fontSize: 12, color: "var(--text-3)" }}>
          {t("people.managedNote")}
        </div>
        {!canRead ? (
          <div style={{ padding: 24 }}>
            <Empty title={t("people.adminsOnly")} />
          </div>
        ) : isLoading ? (
          <div style={{ padding: 24 }}>
            <Empty title={t("access.loading")} />
          </div>
        ) : !members || members.length === 0 ? (
          <div style={{ padding: 24 }}>
            <Empty title={t("access.emptyMembers")} />
          </div>
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5 }}>
            <thead>
              <tr style={{ borderBottom: "1px solid var(--border)" }}>
                <Th>{t("access.colMember")}</Th>
                <Th>{t("access.colRole")}</Th>
                <Th>{t("access.colJoined")}</Th>
                <Th />
              </tr>
            </thead>
            <tbody>
              {members.map((m) => (
                <tr key={m.userId} style={{ borderBottom: "1px solid var(--border)" }}>
                  <Td>
                    <div style={{ display: "flex", flexDirection: "column" }}>
                      <span style={{ color: "var(--text)" }}>
                        {m.name}
                        {m.platformRole === "superadmin" ? (
                          <Badge tone="signal" style={{ marginLeft: 6 }}>
                            {t("access.platformSuperadmin")}
                          </Badge>
                        ) : null}
                      </span>
                      <span className="mono" style={{ fontSize: 10.5, color: "var(--text-3)" }}>
                        {m.email}
                      </span>
                    </div>
                  </Td>
                  <Td>
                    <Badge tone="muted">{t(`access.role${m.role[0]!.toUpperCase()}${m.role.slice(1)}`)}</Badge>
                  </Td>
                  <Td>
                    <span style={{ color: "var(--text-3)" }}>{fmtAgo(m.createdAt)}</span>
                  </Td>
                  <Td style={{ textAlign: "right" }} />
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>
    </div>
  );
}
