import { describe, it, expect } from "vitest";
import { scannerResultActionChip, scannerResultCardClaims } from "./scannerResultAction";

describe("scanner result card direction chip", () => {
  it("never shows BUY beside a server final read of NO_TRADE", () => {
    const chip = scannerResultActionChip("BUY", "NO_TRADE");
    expect(chip.text).not.toBe("BUY");
    expect(chip.text).toBe("No trade");
    expect(chip.withheld).toBe(true);
  });
  it("never shows SELL beside AVOID_FOR_NOW", () => {
    expect(scannerResultActionChip("SELL", "AVOID_FOR_NOW").text).toBe("Avoid for now");
  });
  it("keeps the raw action when the final read allows watching or waiting", () => {
    expect(scannerResultActionChip("BUY", "TRADE_WATCH")).toEqual({ text: "BUY", variant: "default", withheld: false });
    expect(scannerResultActionChip("SELL", "WAIT_FOR_CONFIRMATION").text).toBe("SELL");
    expect(scannerResultActionChip("BUY", undefined).text).toBe("BUY");
  });
});

describe("scanner result card claims beside a withheld action", () => {
  it("a NO_TRADE final read drops the ELITE grade, the green border and the Hot setup badge", () => {
    const claims = scannerResultCardClaims(scannerResultActionChip("BUY", "NO_TRADE"), "ELITE", "HOT_SETUP");
    expect(claims).toEqual({ showGrade: false, showStatusBadge: false, borderTone: "neutral" });
  });
  it("a withheld action keeps cautionary badges and a REJECT grade", () => {
    const claims = scannerResultCardClaims(scannerResultActionChip("SELL", "AVOID_FOR_NOW"), "REJECT", "REJECTED_BY_RISK");
    expect(claims).toEqual({ showGrade: true, showStatusBadge: true, borderTone: "negative" });
  });
  it("an allowed action keeps the grade, badge and tone unchanged", () => {
    expect(scannerResultCardClaims(scannerResultActionChip("BUY", "TRADE_WATCH"), "ELITE", "HOT_SETUP"))
      .toEqual({ showGrade: true, showStatusBadge: true, borderTone: "positive" });
    expect(scannerResultCardClaims(scannerResultActionChip("BUY", undefined), "ACCEPTABLE", "WATCHLIST").borderTone).toBe("info");
  });
});
