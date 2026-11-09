// Replay Simulator: the scenario pill showed the stored market condition
// ("RANGING", "TRENDING_UP") as if it described the candles. Nothing measures
// it: for an import it is the caller's label (or, on older rows, a defaulted
// RANGING), for a synthetic scenario it is the generator setting. A synthetic
// "V75" scenario also read like real Volatility 75 prices.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

vi.mock("@/components/ss/PageShell", async (orig) => {
  const real = await orig<typeof import("@/components/ss/PageShell")>();
  return { ...real, PageShell: ({ children }: { children: React.ReactNode }) => <div>{children}</div> };
});

const { default: ReplaySimulator } = await import("./replay-simulator");

function stubScenario(over: Record<string, unknown>) {
  const scenario = {
    scenarioId: "scn_a", title: "Scenario A", symbol: "V75", timeframe: "M5",
    source: "SYNTHETIC", marketCondition: "TRENDING_UP", candleCount: 80, notes: "", ...over,
  };
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ scenarios: [scenario], count: 1 }) })));
}

const pill = () => screen.getByTestId("replay-scenario-condition");

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("Replay Simulator scenario condition label", () => {
  it("an imported RANGING is an import label (or old default), not measured", async () => {
    stubScenario({ source: "IMPORTED", marketCondition: "RANGING", symbol: "EURUSD" });
    render(<ReplaySimulator />);
    await screen.findByText(/Scenario A \(80c, imported\)/);
    expect(pill().textContent).toMatch(/not measured/i);
    expect(pill().textContent).toMatch(/default/i);
    expect(pill().querySelector("[aria-label]")?.getAttribute("aria-label")).toMatch(/not measured/i);
  });

  it("an import with no condition says so", async () => {
    stubScenario({ source: "IMPORTED", marketCondition: "UNSPECIFIED", symbol: "EURUSD" });
    render(<ReplaySimulator />);
    await screen.findByText(/Scenario A \(80c, imported\)/);
    expect(pill().textContent).toMatch(/not specified/i);
    expect(pill().textContent).not.toMatch(/UNSPECIFIED/);
  });

  it("a synthetic condition is the generator setting, and its prices are not real market data", async () => {
    stubScenario({});
    render(<ReplaySimulator />);
    await screen.findByText(/Scenario A \(80c, synthetic\)/);
    expect(pill().textContent).toMatch(/generator setting/i);
    expect(pill().textContent).toMatch(/not measured/i);
    expect(screen.getByTestId("replay-scenario-meta").textContent).toMatch(/generated prices, not real V75 market data/i);
  });
});
