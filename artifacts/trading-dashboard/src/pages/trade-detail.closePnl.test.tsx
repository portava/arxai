// Regression: the trade detail page built the close-confirmation card with
// waitingForSync hard-coded false, so a trade whose P/L the broker had not
// reported (unrealizedPnl null) was shown in the "Close …?" dialog as a
// green "0.00" — the user confirmed a close against a fabricated zero.
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, waitFor, fireEvent, within } from "@testing-library/react";
import { ConfirmCloseModal } from "@/components/trading/ConfirmCloseModal";
import type { OpenCard } from "@/components/trading/MyOpenTradesPanel";

vi.mock("wouter", () => ({
  useRoute: () => [true, { tradeKey: "lp_1" }],
  Link: ({ children }: { children: unknown }) => children,
}));

const { default: TradeDetailPage } = await import("./trade-detail");

function card(over: Partial<OpenCard>): OpenCard {
  return {
    id: "lp_1", source: "user_owned_mt5", routingMode: "USER_OWNED_MT5", accountType: "demo",
    symbol: "EURUSD", side: "BUY", lotSize: 0.1, entryPrice: 1.085, currentPrice: null,
    stopLoss: 1.08, takeProfit: 1.1, unrealizedPnl: null, pnlIsEstimate: false, pnlPercent: null,
    status: "OPEN", openedAt: null, brokerLabelMasked: null, waitingForSync: false, ...over,
  };
}

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("close confirmation P/L truth", () => {
  it("ConfirmCloseModal never renders a null P/L as 0.00", () => {
    render(<ConfirmCloseModal card={card({})} accountType="demo" tradingMode="DEMO" onClose={() => {}} onClosed={() => {}} />);
    const pnl = screen.getByTestId("confirm-close-pnl");
    expect(pnl.textContent).not.toMatch(/0\.00/);
    expect(pnl.textContent).toMatch(/Not reported/);
    expect(pnl.className).not.toMatch(/text-success/);
  });

  it("ConfirmCloseModal marks an estimated P/L as est.", () => {
    render(<ConfirmCloseModal card={card({ unrealizedPnl: 4.2, pnlIsEstimate: true })} accountType="demo" tradingMode="DEMO" onClose={() => {}} onClosed={() => {}} />);
    expect(screen.getByTestId("confirm-close-pnl").textContent).toMatch(/4\.20.*est\./);
  });

  it("trade detail hands the dialog an unknown P/L as unknown", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (String(url).endsWith("/intelligence")) {
        return new Response(JSON.stringify({
          ok: true,
          trade: {
            tradeKey: "lp_1", routingMode: "USER_OWNED_MT5", symbol: "EURUSD", side: "BUY", lotSize: 0.1,
            entryPrice: 1.085, currentPrice: null, stopLoss: 1.08, takeProfit: 1.1,
            unrealizedPnl: null, pnlIsEstimate: false, brokerLabelMasked: null,
          },
        }), { status: 200 });
      }
      return new Response("{}", { status: 404 });
    }));
    render(<TradeDetailPage />);
    await waitFor(() => expect(screen.getByTestId("review-close-button")).toBeTruthy());
    fireEvent.click(screen.getByTestId("review-close-button"));
    const dialog = await screen.findByRole("dialog");
    const pnl = within(dialog).getByTestId("confirm-close-pnl");
    expect(pnl.textContent).not.toMatch(/0\.00/);
    expect(pnl.textContent).toMatch(/Not reported/);
  });
});
