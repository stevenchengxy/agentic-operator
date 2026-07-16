"use client";

import { useParams, useSearchParams } from "next/navigation";
import { AgentStudio } from "@/app/portal/components/agent-studio";

export default function AgentStudioPage() {
  const params = useParams<{ id: string }>();
  const searchParams = useSearchParams();
  return (
    <AgentStudio
      agentId={params?.id ?? ""}
      initialSection={
        searchParams.get("section") === "test" ? "test" : undefined
      }
    />
  );
}
