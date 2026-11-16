import { afterEach, describe, expect, it, vi } from "vitest";
import { getChartSymbol, setChartSymbol } from "./use-chart-symbol";

describe("workspace symbol propagation", () => {
  afterEach(() => localStorage.clear());
  it("publishes scanner market choices to the shared chart symbol bus", () => {
    const listener = vi.fn();
    window.addEventListener("highroll-chart-symbol", listener);
    setChartSymbol("EURUSD");
    expect(getChartSymbol()).toBe("EURUSD");
    expect(listener).toHaveBeenCalledOnce();
    expect((listener.mock.calls[0]?.[0] as CustomEvent<string>).detail).toBe("EURUSD");
    window.removeEventListener("highroll-chart-symbol", listener);
  });
});
