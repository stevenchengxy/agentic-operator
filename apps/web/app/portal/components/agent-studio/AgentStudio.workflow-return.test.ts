import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const studioSource = readFileSync(
  resolve(__dirname, "AgentStudio.tsx"),
  "utf8",
);
const routeSource = readFileSync(
  resolve(
    __dirname,
    "..",
    "..",
    "[tenant]",
    "(views)",
    "agents",
    "[id]",
    "page.tsx",
  ),
  "utf8",
);

describe("Agent Studio workflow round trip", () => {
  it("parses the workflow editor context and requested draft at the route", () => {
    expect(routeSource).toContain(
      'const fromWorkflow = searchParams.get("from") === "workflow"',
    );
    expect(routeSource).toContain(
      'const initialDraftId = searchParams.get("draftId")?.trim() || undefined',
    );
    expect(routeSource).toContain(
      'initialEditing={searchParams.get("edit") === "1"}',
    );
    expect(routeSource).toContain("workflowSlug={workflowSlug}");
    expect(routeSource).toContain("resumeToken={resumeToken}");
  });

  it("loads the exact requested draft and enters Edit mode once hydrated", () => {
    expect(studioSource).toContain(
      "const editor = useAgentEditor(agentId, initialDraftId)",
    );
    expect(studioSource).toContain('const initialEditHandled = useRef("")');
    expect(studioSource).toMatch(
      /const initialEditKey = `\$\{agentId\}:\$\{initialDraftId \?\? "current"\}`[\s\S]{0,500}initialEditHandled\.current = initialEditKey[\s\S]{0,120}void startEditing\(\)/,
    );
    expect(studioSource).toMatch(
      /async function startEditing\(\)[\s\S]{0,500}if \(!editor\.data\.draft\)[\s\S]{0,120}makeDraft\(true\)/,
    );
  });

  it("offers an explicit safe return action that saves dirty work first", () => {
    expect(studioSource).toContain("Back to workflow");
    expect(studioSource).toMatch(
      /async function returnToWorkflow\(\)[\s\S]{0,500}if \(dirty\)[\s\S]{0,180}await persist\(true\)[\s\S]{0,500}workflowCanvasHref\(/,
    );
    expect(studioSource).toContain("agentDraftId = saved.id");
    expect(studioSource).toContain(
      "Your changes are still open in Agent Studio.",
    );
  });

  it("pins the workflow handoff to the requested agent and version", () => {
    expect(studioSource).not.toContain("agentStudioWorkflowHref({");
    expect(studioSource).toMatch(
      /async function openAnotherAgent\(nextAgentId: string\)[\s\S]{0,240}if \(workflowSlug\)[\s\S]{0,240}Return to the workflow canvas before choosing another agent/,
    );
    expect(studioSource).toContain("This workflow agent is pinned");
    expect(studioSource).toContain(
      "This agent and its exact workflow version are pinned together.",
    );
    expect(studioSource).toContain(
      '{workflowSlug ? (\n            <div\n              className="agent-studio-agent-select"',
    );
    expect(studioSource).toContain(
      '"Workflow handoff for {workflow}. {agent} is pinned until you return to the workflow canvas."',
    );
    expect(studioSource).toContain(
      "{ workflow: workflowSlug, agent: definition.title }",
    );
    expect(studioSource).toContain(
      ') : (\n            <select\n              className="agent-studio-agent-select"',
    );
  });

  it("keeps normal Agent Studio agent switching outside workflow sessions", () => {
    expect(studioSource).toMatch(
      /const href = `\/portal\/\$\{encodeURIComponent\([\s\S]{0,240}nextAgentId[\s\S]{0,180}router\.push\(href as never\)/,
    );
    expect(studioSource).toContain(
      "onChange={(event) => void openAnotherAgent(event.target.value)}",
    );
  });
});
