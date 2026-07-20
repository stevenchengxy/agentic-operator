import { describe, expect, it } from "vitest";
import {
  clientPointToCanvas,
  connectionEventName,
  nodePositionFromPointer,
  workflowEdgePath,
} from "./canvas-interactions";

describe("workflow canvas pointer geometry", () => {
  it("converts client coordinates through scroll, zoom, and the stage header", () => {
    expect(
      clientPointToCanvas(
        { clientX: 310, clientY: 250 },
        {
          rectLeft: 10,
          rectTop: 20,
          scrollLeft: 100,
          scrollTop: 50,
          zoom: 2,
        },
      ),
    ).toEqual({ x: 200, y: 110 });
  });

  it("moves from the original grab point and clamps invalid canvas overflow", () => {
    expect(
      nodePositionFromPointer(
        { x: 120, y: 80 },
        { clientX: 200, clientY: 200 },
        { clientX: 260, clientY: 240 },
        2,
      ),
    ).toEqual({ x: 150, y: 100 });

    expect(
      nodePositionFromPointer(
        { x: 2, y: 2 },
        { clientX: 100, clientY: 100 },
        { clientX: -500, clientY: -500 },
        1,
      ),
    ).toEqual({ x: 0, y: 0 });
  });
});

describe("workflow connection interaction", () => {
  it("creates stable readable event names", () => {
    expect(connectionEventName("supportTriage", "human-review")).toBe(
      "SUPPORT_TRIAGE_TO_HUMAN_REVIEW",
    );
  });

  it("uses the same cubic path for live previews and saved edges", () => {
    expect(workflowEdgePath({ x: 100, y: 50 }, { x: 400, y: 150 })).toBe(
      "M 100 50 C 250 50, 250 150, 400 150",
    );
  });
});
