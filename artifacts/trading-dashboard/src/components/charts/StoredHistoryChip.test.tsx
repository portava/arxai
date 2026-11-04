import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { StoredHistoryChip, storedHistoryChipText } from "./StoredHistoryChip";
afterEach(cleanup);
const now = Date.parse("2026-11-04T12:00:00Z");
describe("stored chart history chip", () => {
  it("renders clear last-bar age and not-live wording with candles", () => {
    render(<StoredHistoryChip status={{ notLiveReason: "stored_history" }} newestOpenIso="2026-11-04T07:00:00Z" nowMs={now} />);
    expect(screen.getByTestId("arx-stored-history").textContent).toBe("Stored history up to the last bar (5 h ago), not live");
    expect(screen.queryByText("AI-confirmed")).toBeNull();
  });
  it("does not invent bars or show a chip for empty history", () => {
    render(<StoredHistoryChip status={{ notLiveReason: "stored_history" }} newestOpenIso={null} />);
    expect(screen.queryByTestId("arx-stored-history")).toBeNull();
  });
  it("does not label ordinary feeds as stored history", () => {
    render(<StoredHistoryChip status={{}} newestOpenIso="2026-11-04T07:00:00Z" />);
    expect(screen.queryByTestId("arx-stored-history")).toBeNull();
  });
  it("keeps missing and very recent timestamps honest", () => {
    expect(storedHistoryChipText("invalid", now)).toBe("Stored history, not live");
    expect(storedHistoryChipText("2026-11-04T11:55:00Z", now)).toContain("5 min ago");
    expect(storedHistoryChipText("2026-11-01T12:00:00Z", now)).toContain("3 days ago");
  });
});
