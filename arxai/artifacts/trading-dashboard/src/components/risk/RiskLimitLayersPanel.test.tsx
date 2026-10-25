// Limits in force (Tier 1 finalization, item 7): the trader sees each layer
// and the value the Risk Governor applies, and a failed load never looks like
// "no limits". Render proof only; fetch is stubbed.

import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RiskLimitLayersPanel } from "./RiskLimitLayersPanel";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function renderPanel() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}><RiskLimitLayersPanel /></QueryClientProvider>);
}

describe("RiskLimitLayersPanel", () => {
  it("shows platform, account, own and in-force values with the winning layer", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      rule: "strictest_wins",
      rows: [
        { key: "maxLotSize", label: "Max position size", unit: "lots", platform: 5, account: 0.5, user: 1, effective: 0.5, source: "user_risk_limits.max_lot_size", winner: "account" },
        { key: "maxDailyLossAmount", label: "Daily loss", unit: "USD", platform: null, account: 500, user: 300, effective: 300, source: "user_risk_settings.max_daily_loss_amount", winner: "user" },
      ],
      restrictions: { requireStopLoss: true, liveAllowed: false, allowedSymbols: null, allowedDirection: null },
    }), { status: 200 })));
    renderPanel();
    const lot = await screen.findByTestId("limit-row-maxLotSize");
    expect(within(lot).getAllByRole("cell").map((c) => c.textContent)).toEqual(["Max position size", "5", "0.5", "1", "0.5", "Account"]);
    const loss = screen.getByTestId("limit-row-maxDailyLossAmount");
    expect(within(loss).getAllByRole("cell").map((c) => c.textContent)).toEqual(["Daily loss ($)", "—", "$500", "$300", "$300", "You"]);
    expect(screen.getByText(/limited to demo by an operator/)).toBeTruthy();
  });

  it("a failed load says so and shows no limit table", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 500 })));
    renderPanel();
    await waitFor(() => expect(screen.getByText(/Could not load your limits/)).toBeTruthy());
    expect(screen.queryByRole("table")).toBeNull();
  });
});
