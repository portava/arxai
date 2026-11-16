// Task #392 — the run-on momentum stages get clearer, plain-English display
// labels: IGNITING → "Developing run", STRETCH → "Runaway move". This is a
// DISPLAY-ONLY rename: the internal FlameStage tokens the engine emits are
// unchanged, so every data-* attribute, test id, and backend contract keeps
// using IGNITING/STRETCH. These tests lock both halves of that contract.

import { describe, it, expect } from "vitest";
import { FLAME_STAGE_LABEL, FLAME_STAGE_TONE } from "./scalpLabels";

describe("FLAME_STAGE_LABEL — plain-English run-on stage labels", () => {
  it("renders the new wording for the developing and runaway stages", () => {
    expect(FLAME_STAGE_LABEL.IGNITING).toBe("Developing run");
    expect(FLAME_STAGE_LABEL.STRETCH).toBe("Runaway move");
  });

  it("keeps the internal stage tokens (display-only rename, not an enum change)", () => {
    // The engine still emits IGNITING/STRETCH; only the human label changed.
    expect(Object.keys(FLAME_STAGE_LABEL)).toEqual(
      expect.arrayContaining(["IGNITING", "STRETCH"]),
    );
    expect(Object.keys(FLAME_STAGE_TONE)).toEqual(
      expect.arrayContaining(["IGNITING", "STRETCH"]),
    );
  });

  it("keeps sensible tone bands — developing stays positive/early, runaway warns", () => {
    // Developing run is an early, trend-favouring stage → emerald (positive).
    expect(FLAME_STAGE_TONE.IGNITING).toContain("emerald");
    // Runaway move is a late, over-extended stage → amber (caution).
    expect(FLAME_STAGE_TONE.STRETCH).toContain("amber");
  });
});
