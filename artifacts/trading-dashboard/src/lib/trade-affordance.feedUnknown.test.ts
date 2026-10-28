import { describe, it, expect } from "vitest";
import { resolveTradeAffordance } from "./trade-affordance";

// Regression: when the chart-candles request failed, the shared truth was null
// and resolveTradeAffordance returned NONE — no feed warning and no demo
// acknowledgement — so a demo order could be sent while the feed state was
// unknown. An unavailable feed WITH truth already warns + requires the ack.
describe("resolveTradeAffordance — failed feed read is not silence", () => {
  it("demo: a failed feed read warns and requires the acknowledgement", () => {
    const a = resolveTradeAffordance(null, "demo", { isError: true });
    expect(a.requireAck).toBe(true);
    expect(a.warningTitle).not.toBe("");
    expect(a.warningDetail.toLowerCase()).toContain("couldn't");
    // Display ceilings stay closed — nothing about the read is known.
    expect(a.mayShowTradeButton).toBe(false);
    expect(a.mayDescribeSetup).toBe(false);
  });
  it("live: the warning shows but no ack (live stays ack-free by design)", () => {
    const a = resolveTradeAffordance(null, "live", { isError: true });
    expect(a.warningTitle).not.toBe("");
    expect(a.requireAck).toBe(false);
  });
  it("read_only: nothing (no trade buttons render)", () => {
    const a = resolveTradeAffordance(null, "read_only", { isError: true });
    expect(a.warningTitle).toBe("");
    expect(a.requireAck).toBe(false);
  });
  it("still loading (no error): no premature warning", () => {
    expect(resolveTradeAffordance(null, "demo").warningTitle).toBe("");
    expect(resolveTradeAffordance(null, "demo", { isError: false }).requireAck).toBe(false);
  });
});
