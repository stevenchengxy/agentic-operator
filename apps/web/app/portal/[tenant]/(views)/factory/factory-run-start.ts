import type { Translate } from "@/app/portal/lib/preferences-context";

export interface FactoryToolDocument {
  name: string;
  text: string;
}

export interface FactoryRunStartReceipt {
  runId: string;
  mode: "started" | "attached";
}

/**
 * Compose the exact JSON request payload sent to the factory start endpoint.
 * Document text is intentionally preserved in full; request-size policy belongs
 * to the API, whose 413/error envelope is shown to the operator.
 */
export function composeFactoryGoal(t: Translate, goal: string, documents: readonly FactoryToolDocument[]): string {
  const operatorGoal = goal.trim();
  if (!documents.length) return operatorGoal;

  const documentBlock = documents
    .map((document, index) => `${t("factory.runStart.documentHeader", { index: index + 1, name: document.name })}\n${document.text}`)
    .join("\n\n");

  return `${t("factory.runStart.documentsAttachedPrefix", { count: documents.length })}\n\n${documentBlock}\n\n${operatorGoal || t("factory.runStart.defaultGenerationGoal")}`;
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
