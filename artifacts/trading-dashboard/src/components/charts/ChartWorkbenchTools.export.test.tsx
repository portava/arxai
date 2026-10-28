// Truth regression: the PNG header stamps the export wall clock as an export
// time, never as a "capture" of the data (the data time is in the feed label).
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChartWorkbenchTools } from "./ChartWorkbenchTools";
import { DEFAULT_PREFERENCES } from "@/lib/chart-engine/chartWorkspace";
import type { ChartEngineAdapter } from "@/lib/chart-engine";

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("chart PNG export header", () => {
  it("labels the wall clock as the export time and keeps the feed label", () => {
    const drawn: string[] = [];
    const ctx = { font: "", fillStyle: "", measureText: () => ({ width: 10 }), fillRect: vi.fn(),
      fillText: (text: string) => { drawn.push(text); }, drawImage: vi.fn() };
    const realCreate = document.createElement.bind(document);
    vi.spyOn(document, "createElement").mockImplementation(((tag: string) => {
      if (tag === "canvas") return { getContext: () => ctx, toDataURL: () => "data:image/png;base64,", width: 0, height: 0 } as unknown as HTMLCanvasElement;
      if (tag === "a") return { click: vi.fn(), download: "", href: "" } as unknown as HTMLAnchorElement;
      return realCreate(tag);
    }) as typeof document.createElement);
    class FakeImage { width = 2000; height = 100; onload: (() => void) | null = null; set src(_v: string) { this.onload?.(); } }
    vi.stubGlobal("Image", FakeImage);
    const adapter = { exportImage: () => "data:image/png;base64,x" } as unknown as ChartEngineAdapter;
    render(<ChartWorkbenchTools adapter={adapter} epoch={1} symbol="EURUSD" timeframe="M15" preferences={DEFAULT_PREFERENCES}
      onPreferences={vi.fn()} hasCandles feedLabel="mt5_broker · Newest bar opened 2026-10-27T15:55:00.000Z" />);
    fireEvent.click(screen.getByRole("button", { name: "Export PNG" }));
    const text = drawn.join("\n");
    expect(text).not.toMatch(/Captured/);
    expect(text).toMatch(/Image exported \d{4}-\d{2}-\d{2}T/);
    expect(text).toContain("Newest bar opened 2026-10-27T15:55:00.000Z");
  });
});
