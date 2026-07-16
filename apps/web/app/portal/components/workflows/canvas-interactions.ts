import {
  clampCanvasPosition,
  type CanvasPoint,
} from "@/app/portal/components/workflows/layout";

export const WORKFLOW_AGENT_DRAG_TYPE = "application/x-agentic-workflow-agent";

export interface CanvasViewportMetrics {
  rectLeft: number;
  rectTop: number;
  scrollLeft: number;
  scrollTop: number;
  zoom: number;
}

export interface ClientPoint {
  clientX: number;
  clientY: number;
}

/**
 * Convert a browser pointer coordinate into the unscaled workflow plane.
 * `contentTop` accounts for the stage-header strip above the SVG/node layer.
 */
export function clientPointToCanvas(
  point: ClientPoint,
  viewport: CanvasViewportMetrics,
  contentTop = 30,
): CanvasPoint {
  const zoom =
    Number.isFinite(viewport.zoom) && viewport.zoom > 0 ? viewport.zoom : 1;
  return {
    x: (viewport.scrollLeft + point.clientX - viewport.rectLeft) / zoom,
    y:
      (viewport.scrollTop + point.clientY - viewport.rectTop) / zoom -
      contentTop,
  };
}

/** Move a node by the pointer delta while preserving where it was grabbed. */
export function nodePositionFromPointer(
  origin: CanvasPoint,
  start: ClientPoint,
  current: ClientPoint,
  zoom: number,
): CanvasPoint {
  const scale = Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
  return clampCanvasPosition({
    x: origin.x + (current.clientX - start.clientX) / scale,
    y: origin.y + (current.clientY - start.clientY) / scale,
  });
}

export function connectionEventName(
  sourceId: string,
  targetId: string,
): string {
  const eventPart = (value: string) =>
    value
      .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
      .replace(/[^A-Za-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .toUpperCase();
  return `${eventPart(sourceId)}_TO_${eventPart(targetId)}`.slice(0, 160);
}

/** Shared path geometry for persisted edges and the live drag preview. */
export function workflowEdgePath(
  source: CanvasPoint,
  target: CanvasPoint,
): string {
  const distance = Math.max(40, Math.abs(target.x - source.x) * 0.5);
  return `M ${source.x} ${source.y} C ${source.x + distance} ${source.y}, ${
    target.x - distance
  } ${target.y}, ${target.x} ${target.y}`;
}
