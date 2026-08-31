// Market Heat Map — non-admin Data Status card copy is keyed on the REAL data
// quality label, not on the unreachable "unavailable" branch.
//
// BEFORE
//   The card computed `isActive = !!data && label !== "unavailable"`. The
//   timing brain's resolveDataQuality never emits "unavailable" (it emits
//   basic_timing_estimate | real | partial), so the card claimed "Market timing
//   intelligence is active … Scores update automatically" even when ZERO market
//   providers were connected and every score came from the session clock alone.
//
// AFTER
//   `timingStatusDescription` distinguishes three honest states:
//     - no read / "unavailable"       → unavailable copy
//     - "basic_timing_estimate"       → session-clock-estimate copy (never
//                                       described as active market intelligence)
//     - "real" / "partial"            → active copy

import { describe, it, expect } from "vitest";
import { timingStatusDescription } from "./market-heat-map";

describe("timingStatusDescription", () => {
  it("describes real/partial reads as active intelligence", () => {
    expect(timingStatusDescription("real")).toMatch(/intelligence is active/i);
    expect(timingStatusDescription("partial")).toMatch(/intelligence is active/i);
  });

  it("never claims active intelligence for a session-clock-only estimate", () => {
    const copy = timingStatusDescription("basic_timing_estimate");
    expect(copy).not.toMatch(/intelligence is active/i);
    expect(copy).not.toMatch(/update automatically/i);
    expect(copy).toMatch(/session-clock estimate/i);
    expect(copy).toMatch(/no live market data/i);
  });

  it("reports honest absence when there is no read or the label is unavailable", () => {
    for (const label of [null, "unavailable"] as const) {
      const copy = timingStatusDescription(label);
      expect(copy).toMatch(/currently unavailable/i);
      expect(copy).not.toMatch(/intelligence is active/i);
    }
  });
});
