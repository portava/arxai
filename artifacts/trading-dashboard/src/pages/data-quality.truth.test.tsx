// Data Quality: /api/data-quality describes the legacy in-process simulator
// layer (constants ACTIVE_PROVIDER='SIMULATOR', MT5_BRIDGE_CONNECTED=false and
// a quote timestamp stamped at request time). The page must say so, must not
// colour a constant "MT5 connected: no" green, and must not present the
// request time as the last quote time.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

const { default: DataQualityPage } = await import("./data-quality");

// Payload exactly as dataQuality() in api-server/src/lib/marketDataLayer.ts builds it.
const LEGACY_PAYLOAD = {
  quoteSource: "SIMULATOR", candleSource: "SIMULATOR",
  lastQuoteTime: new Date().toISOString(), lastCandleTime: null,
  quoteIsStale: false, candleIsStale: false,
  simulatorActive: true, chartActive: true,
  mt5Connected: false, brokerExecutableData: false,
  scannerProvider: "SIMULATOR", riskGovernorProvider: "SIMULATOR",
  notice: "Active provider is SIMULATOR. Chart embed is visual only. MT5 bridge is deferred — no quote here is broker-executable.",
};

function stubFetch(status: number, body: unknown) {
  vi.stubGlobal("fetch", vi.fn(async () => ({
    ok: status >= 200 && status < 300, status, json: async () => body,
  }) as unknown as Response));
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function card(label: string): HTMLElement {
  return screen.getByText(label).closest("[data-testid='dq-card']") as HTMLElement;
}

describe("Data Quality truth", () => {
  it("labels the payload as the legacy simulator layer, not the live platform", async () => {
    stubFetch(200, LEGACY_PAYLOAD);
    render(<DataQualityPage />);
    const scope = await screen.findByTestId("dq-scope");
    expect(scope.textContent).toMatch(/legacy simulator data layer/i);
    expect(scope.textContent).toMatch(/does not read the live MT5 bridge/i);
  });

  it("does not colour the constant 'MT5 connected: no' as OK", async () => {
    stubFetch(200, LEGACY_PAYLOAD);
    render(<DataQualityPage />);
    await screen.findByTestId("dq-scope");
    const mt5 = card("MT5 connected");
    expect(mt5.innerHTML).not.toMatch(/emerald/);
    expect(mt5.textContent).toMatch(/not measured/i);
    const scanner = card("Scanner provider");
    expect(scanner.textContent).toMatch(/not measured/i);
  });

  it("does not present the request time as the last quote time", async () => {
    stubFetch(200, LEGACY_PAYLOAD);
    render(<DataQualityPage />);
    await screen.findByTestId("dq-scope");
    const q = card("Last quote time");
    expect(q.textContent).toMatch(/not recorded/i);
  });

  it("a failed request is an error, not a permanent 'Loading…'", async () => {
    stubFetch(500, { error: "boom" });
    render(<DataQualityPage />);
    const err = await screen.findByTestId("dq-error");
    expect(err.textContent).toMatch(/could not load/i);
  });
});
