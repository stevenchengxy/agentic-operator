"use client";

import { useParams, useSearchParams } from "next/navigation";
import { AgentStudio } from "@/app/portal/components/agent-studio";

export default function AgentStudioPage() {
  const params = useParams<{ id: string }>();
  const searchParams = useSearchParams();
  const fromWorkflow = searchParams.get("from") === "workflow";
  const workflowSlug = fromWorkflow
    ? searchParams.get("workflow")?.trim() || undefined
    : undefined;
  const resumeToken = fromWorkflow
    ? searchParams.get("resume")?.trim() || undefined
    : undefined;
  const initialDraftId = searchParams.get("draftId")?.trim() || undefined;

  return (
    <AgentStudio
      agentId={params?.id ?? ""}
      initialDraftId={initialDraftId}
      initialEditing={searchParams.get("edit") === "1"}
      initialSection={
        searchParams.get("section") === "test" ? "test" : undefined
      }
      workflowSlug={workflowSlug}
      resumeToken={resumeToken}
    />
  );
}
