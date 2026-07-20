export const WORKFLOW_INSPECTOR_DEFAULT_WIDTH = 520;
export const WORKFLOW_INSPECTOR_MIN_WIDTH = 360;
export const WORKFLOW_INSPECTOR_MAX_WIDTH = 960;
export const WORKFLOW_INSPECTOR_WIDE_WIDTH = 720;
export const WORKFLOW_CANVAS_MIN_WIDTH = 420;
export const WORKFLOW_INSPECTOR_SPLITTER_WIDTH = 14;

/**
 * The inspector may grow only while a useful canvas remains visible.
 * Narrow layouts are stacked by CSS, so this function deliberately keeps
 * returning a valid panel width even below the desktop breakpoint.
 */
export function workflowInspectorMaxWidth(containerWidth: number): number {
  if (!Number.isFinite(containerWidth) || containerWidth <= 0) {
    return WORKFLOW_INSPECTOR_MAX_WIDTH;
  }
  return Math.max(
    WORKFLOW_INSPECTOR_MIN_WIDTH,
    Math.min(
      WORKFLOW_INSPECTOR_MAX_WIDTH,
      Math.floor(
        containerWidth -
          WORKFLOW_CANVAS_MIN_WIDTH -
          WORKFLOW_INSPECTOR_SPLITTER_WIDTH,
      ),
    ),
  );
}

export function clampWorkflowInspectorWidth(
  width: number,
  containerWidth: number,
): number {
  const finiteWidth = Number.isFinite(width)
    ? width
    : WORKFLOW_INSPECTOR_DEFAULT_WIDTH;
  return Math.max(
    WORKFLOW_INSPECTOR_MIN_WIDTH,
    Math.min(
      workflowInspectorMaxWidth(containerWidth),
      Math.round(finiteWidth),
    ),
  );
}

export function workflowInspectorWideWidth(containerWidth: number): number {
  return clampWorkflowInspectorWidth(
    WORKFLOW_INSPECTOR_WIDE_WIDTH,
    containerWidth,
  );
}

export function workflowInspectorStorageKey(tenant: string): string {
  return `agentic:workflow-inspector-width:v1:${tenant}`;
}
