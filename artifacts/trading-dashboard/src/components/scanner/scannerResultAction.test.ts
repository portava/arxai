import { describe, it, expect } from "vitest";
import { scannerResultActionChip } from "./scannerResultAction";

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
