"use client";

import { Empty, Panel } from "@/app/portal/components";

/** Notification rules have no persistence or delivery service yet. */
export function NotificationsSection() {
  return (
    <Panel
      title="Notifications"
      subtitle="No notification routing service is configured."
      padded={false}
    >
      <Empty
        title="Notification settings unavailable"
        hint="Event routes, quiet hours, email, chat, and paging destinations cannot be configured until a notification backend is installed."
      />
    </Panel>
  );
}
