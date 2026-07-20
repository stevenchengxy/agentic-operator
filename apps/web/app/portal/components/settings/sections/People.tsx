"use client";

import { Empty, Panel } from "@/app/portal/components";

/**
 * No membership/RBAC administration API exists in this deployment. Keep the
 * section as an explicit capability status instead of presenting fake users,
 * SSO domains, invitations, or role mutations.
 */
export function PeopleSection() {
  return (
    <Panel
      title="People & roles"
      subtitle="Workspace membership administration is not installed."
      padded={false}
    >
      <Empty
        title="Member management unavailable"
        hint="Authentication may identify the current operator, but there is no members, invitations, SSO, or role-management API to configure here."
      />
    </Panel>
  );
}
