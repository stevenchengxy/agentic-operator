"use client";

import { useParams } from "next/navigation";
import { AgentStudio } from "@/app/portal/components/agent-studio";

export default function AgentStudioPage() {
  const params = useParams<{ id: string }>();
  return <AgentStudio agentId={params?.id ?? ""} />;
}
