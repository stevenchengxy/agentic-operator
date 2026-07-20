export interface FactoryToolDocument {
  name: string;
  text: string;
}

export interface FactoryRunStartReceipt {
  runId: string;
  mode: "started" | "attached";
}

const DEFAULT_GENERATION_GOAL = "据此为当前运行领域生成能真正跑通的智能体并验证整条事件链。";

/**
 * Compose the exact JSON request payload sent to the factory start endpoint.
 * Document text is intentionally preserved in full; request-size policy belongs
 * to the API, whose 413/error envelope is shown to the operator.
 */
export function composeFactoryGoal(goal: string, documents: readonly FactoryToolDocument[]): string {
  const operatorGoal = goal.trim();
  if (!documents.length) return operatorGoal;

  const documentBlock = documents
    .map((document, index) => `--- 文档 ${index + 1}：${document.name} ---\n${document.text}`)
    .join("\n\n");

  return `【附带 ${documents.length} 份文档：请先阅读、推理，用 create_tool 把其中可用的 API 整合成工具、存进当前运行领域的工具库，再继续生成/验证 agents】\n\n${documentBlock}\n\n${operatorGoal || DEFAULT_GENERATION_GOAL}`;
}

export function isFactoryRunStartReceipt(value: unknown): value is FactoryRunStartReceipt {
  if (!value || typeof value !== "object") return false;
  const receipt = value as Partial<FactoryRunStartReceipt>;
  if (
    typeof receipt.runId !== "string" || !receipt.runId.trim()
    || (receipt.mode !== "started" && receipt.mode !== "attached")
  ) return false;
  return true;
}

export function replayModeForStart(receipt: FactoryRunStartReceipt, hadConversation: boolean): "append" | "replace" {
  return receipt.mode === "started" && hadConversation ? "append" : "replace";
}
