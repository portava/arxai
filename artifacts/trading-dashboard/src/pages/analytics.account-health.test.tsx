import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

// Analytics Overview used to show a green "Healthy" Account Health badge and a
// "Margin: Healthy" chip whenever a balance or equity number existed, a
// success-toned "Drawdown: Watch", and "No open positions are stressing
// margin right now" whenever open P/L was exactly 0 — none of it measured.

let summary: Record<string, unknown> = {};
let acct: Record<string, unknown> | undefined;
let posData: { rows: unknown[] } | undefined;

vi.mock("@workspace/api-client-react", () => ({
  useGetPerformanceSummary: () => ({ data: summary, isLoading: false }),
  useGetDailyPerformance: () => ({ data: [], isLoading: false }),
  useGetStrategies: () => ({ data: [] }),
  useGetMeSharedAccountSummary: () => ({ data: acct }),
  useGetMeSharedAccountPositions: () => ({ data: posData }),
}));
vi.mock("wouter", () => ({ useLocation: () => ["/analytics", () => undefined] }));
vi.mock("@/lib/assistant-name", () => ({ useAssistantName: () => ({ name: "Ruby" }) }));

const { default: Analytics } = await import("./analytics");

const pos = (symbol: string) => ({ symbol, side: "BUY", lotSize: 0.1, entryPrice: 1.1, pnl: 0 });

afterEach(cleanup);

function chip(label: string): HTMLElement {
  const el = screen.getAllByText(label).find((n) => n.className.includes("text-[10px]"));
  if (!el) throw new Error(`chip ${label} not found`);
  return el.parentElement!;
}

describe("Analytics Overview — account health is not a non-null check", () => {
  it("deep drawdown and equity far below balance never read 'Healthy'", () => {
    summary = { maxDrawdown: 40, totalPnl: -700, totalTrades: 12 };
    acct = { balance: 1000, equity: 300, pnl: -700 };
    posData = { rows: [pos("EURUSD"), pos("GBPUSD"), pos("USDJPY")] };
    render(<Analytics />);
    expect(screen.queryByText("Healthy")).toBeNull();
    const dd = chip("Drawdown");
    expect(dd.textContent).toContain("Watch");
    expect(dd.querySelector(".text-success")).toBeNull();
    expect(chip("Margin").textContent).not.toMatch(/Healthy/);
  });

  it("open P/L of 0 with open positions does not say nothing is stressing margin", () => {
    summary = { maxDrawdown: 2, totalPnl: 10, totalTrades: 3 };
    acct = { balance: 1000, equity: 1000, pnl: 0 };
    posData = { rows: [pos("EURUSD"), pos("GBPUSD")] };
    render(<Analytics />);
    expect(document.body.textContent).not.toMatch(/No open positions are stressing margin/);
  });

  it("unread positions are not 'Clear' exposure or 0 open positions", () => {
    summary = { maxDrawdown: 2, totalPnl: 10, totalTrades: 3 };
    acct = { balance: 1000, equity: 1000, pnl: 0 };
    posData = undefined;
    render(<Analytics />);
    expect(chip("Exposure").textContent).not.toMatch(/Clear/);
    expect(document.body.textContent).not.toMatch(/No open positions/);
  });
});
