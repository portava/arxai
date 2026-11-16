import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { ChartMarketSelect, ChartTimeframeSelect } from "./ChartPickers";
import { CHART_INTERVALS } from "@/lib/chart-engine/chartIntervals";
import { SYMBOL_REGISTRY } from "@/lib/symbolRegistry";

describe("ChartMarketSelect", () => {
  it("lists every registry market, grouped, and shows the current one", () => {
    render(<ChartMarketSelect symbol="EURUSD" onSelect={() => {}} />);
    const select = screen.getByLabelText("Chart market") as HTMLSelectElement;
    expect(select.value).toBe("EURUSD");
    const values = [...select.options].map(o => o.value);
    for (const e of SYMBOL_REGISTRY) expect(values).toContain(e.canonicalSymbol);
    expect(select.querySelectorAll("optgroup").length).toBeGreaterThan(1);
  });

  it("resolves a broker or prefixed symbol to its registry market", () => {
    const entry = SYMBOL_REGISTRY.find(e => e.aliases.length > 0)!;
    render(<ChartMarketSelect symbol={entry.aliases[0]!} onSelect={() => {}} />);
    expect((screen.getByLabelText("Chart market") as HTMLSelectElement).value).toBe(entry.canonicalSymbol);
  });

  it("reports the chosen market and ignores re-selecting the current one", () => {
    const onSelect = vi.fn();
    render(<ChartMarketSelect symbol="EURUSD" onSelect={onSelect} />);
    const select = screen.getByLabelText("Chart market");
    fireEvent.change(select, { target: { value: "XAUUSD" } });
    expect(onSelect).toHaveBeenCalledWith("XAUUSD");
    onSelect.mockClear();
    fireEvent.change(select, { target: { value: "EURUSD" } });
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("keeps an unknown market selected and labelled instead of snapping to another", () => {
    render(<ChartMarketSelect symbol="NOTAMARKET" onSelect={() => {}} />);
    const select = screen.getByLabelText("Chart market") as HTMLSelectElement;
    expect(select.value).toBe("NOTAMARKET");
    const own = [...select.options].find(o => o.value === "NOTAMARKET")!;
    expect(own.disabled).toBe(true);
    expect(own.textContent).toMatch(/not in the market list/);
  });
});

describe("ChartTimeframeSelect", () => {
  it("offers every native interval once and shows the current one", () => {
    render(<ChartTimeframeSelect timeframe="H4" onSelect={() => {}} />);
    const select = screen.getByLabelText("Chart timeframe") as HTMLSelectElement;
    expect(select.value).toBe("H4");
    expect([...select.options].map(o => o.value).sort()).toEqual([...CHART_INTERVALS].sort());
  });

  it("reports the chosen interval", () => {
    const onSelect = vi.fn();
    render(<ChartTimeframeSelect timeframe="M15" onSelect={onSelect} />);
    fireEvent.change(screen.getByLabelText("Chart timeframe"), { target: { value: "D1" } });
    expect(onSelect).toHaveBeenCalledWith("D1");
  });
});
