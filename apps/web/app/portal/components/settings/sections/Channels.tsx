"use client";

import { Empty, Panel } from "@/app/portal/components";

/** Channel routing is intentionally unavailable until a real backend lands. */
export function ChannelsSection() {
  return (
    <Panel
      title="Channels"
      subtitle="No job-board or messaging channel service is configured."
      padded={false}
    >
      <Empty
        title="Channel configuration unavailable"
        hint="There is no channel connection, quota, or default-routing API in this deployment. External systems with supported adapters can be managed under Integrations."
      />
    </Panel>
  );
}
