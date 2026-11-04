// Trade Command Room panels: a position row the MT5 sync has not refreshed
// recently (route flag `stale`, mapped to status "stale" by the page) must say
// so — not render like a current position with a bare dash for P&L.
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";

vi.mock("wouter", () => ({
  Link: ({ href, children, ...rest }: { href?: string; children?: React.ReactNode }) => (
    <a href={href} {...rest}>{children}</a>
  ),
}));

import { PositionsPanel } from "./TradePanels";

afterEach(cleanup);

describe("PositionsPanel stale rows", () => {
  it("a stale row is labelled stale, not shown as a current position", () => {
    render(<PositionsPanel positions={[{ id: 7, symbol: "EURUSD", side: "BUY", lotSize: 0.1, entry: 1.08, pnl: null, status: "stale" }]} />);
    expect(screen.getByTestId("position-7-stale").textContent).toMatch(/Not refreshed by the MT5 sync recently/);
    expect(screen.getByTestId("position-7-pnl").textContent).toBe("P&L stale");
  });

  it("a fresh row with no P&L says it was not reported", () => {
    render(<PositionsPanel positions={[{ id: 8, symbol: "EURUSD", side: "SELL", lotSize: 0.1, pnl: null }]} />);
    expect(screen.queryByTestId("position-8-stale")).toBeNull();
    expect(screen.getByTestId("position-8-pnl").textContent).toBe("P&L not reported");
  });

  it("a fresh row with P&L shows the number", () => {
    render(<PositionsPanel positions={[{ id: 9, symbol: "EURUSD", side: "BUY", lotSize: 0.1, pnl: 12.5 }]} />);
    expect(screen.getByTestId("position-9-pnl").textContent).toBe("+12.50");
  });
});

import { OrdersPanel } from "./TradePanels";

describe("OrdersPanel scanner rows", () => {
  const now = Date.parse("2026-10-28T12:00:00.000Z");
  const base = {
    symbol: "EURUSD", timeframe: "M15", recommendedAction: "BUY", confidenceScore: 70,
    opportunity: { score: 82, label: "STRONG" },
    generatedAt: new Date(now - 5_000).toISOString(), dataStatus: "live", tradeable: true, disabledReason: null,
  };
  function renderRows(rows: unknown[]) {
    vi.spyOn(Date, "now").mockReturnValue(now);
    render(<OrdersPanel opps={rows as never} intentCount={0} picked={null} onPick={() => {}} />);
  }
  afterEach(() => vi.restoreAllMocks());

  it("a simulator-only row shows no BUY and no score", () => {
    renderRows([{ ...base, dataStatus: "simulator_only", tradeable: false, disabledReason: "Waiting for verified feed.", opportunity: { score: 0, label: "WEAK" } }]);
    const card = screen.getByTestId("order-opp-EURUSD-M15").textContent ?? "";
    expect(card).not.toContain("BUY");
    expect(screen.getByTestId("order-opp-noread-EURUSD-M15").textContent).toBe("Waiting for verified feed.");
  });

  it("a live row from a scan older than 30 s shows no direction or score", () => {
    renderRows([{ ...base, generatedAt: new Date(now - 120_000).toISOString() }]);
    expect(screen.getByTestId("order-opp-EURUSD-M15").textContent).not.toContain("BUY");
    expect(screen.getByTestId("order-opp-noread-EURUSD-M15").textContent).toMatch(/more than 30 s old/);
  });

  it("a final read of NO_TRADE replaces the raw BUY", () => {
    renderRows([{ ...base, finalRead: { label: "NO_TRADE" } }]);
    const card = screen.getByTestId("order-opp-EURUSD-M15").textContent ?? "";
    expect(card).not.toContain("BUY");
    expect(card).toContain("No trade");
  });

  it("a fresh live tradeable row shows its action and score", () => {
    renderRows([base]);
    const card = screen.getByTestId("order-opp-EURUSD-M15").textContent ?? "";
    expect(card).toContain("BUY");
    expect(screen.getByTestId("order-opp-score-EURUSD-M15").textContent).toBe("82");
  });
});

// The live intent queue counts only its newest `limit` intents (hasMore says
// older ones exist) and answers non-admins with an admin-only note and zero
// counts. The trade room took counts.total as the whole queue and showed the
// admin-only answer as "0 intents / No live intents queued".
import { TradeStatusBar } from "./TradePanels";
import { readIntentQueueCount } from "@/lib/intentQueueCount";

describe("Trade Command Room intent count", () => {
  function propsFor(body: unknown) {
    const iq = readIntentQueueCount(body);
    const counted = iq.kind === "exact" || iq.kind === "at_least";
    return {
      intentCount: counted ? iq.total : null,
      intentError: iq.kind === "error",
      intentAtLeast: iq.kind === "at_least",
      intentScopeNote: iq.kind === "not_shown" ? iq.note : null,
    };
  }
  const capped = { intents: [], counts: { total: 100 }, limit: 100, hasMore: true, adminScope: true };
  const nonAdmin = { intents: [], counts: { total: 0 }, scopeNote: "Live Intent Queue is admin-only operator data." };

  it("a capped window reads '100+', with a note that older intents exist", () => {
    const p = propsFor(capped);
    render(<OrdersPanel opps={[]} picked={null} onPick={() => {}} {...p} />);
    expect(screen.getByTestId("orders-intent-count").textContent).toBe("100+");
    expect(screen.getByTestId("orders-intent-window").textContent).toMatch(/newest 100/);
    cleanup();
    render(<TradeStatusBar modeLabel="Demo" isLive={false} gatesLabel="x" {...p} />);
    expect(screen.getByTestId("trade-intent-badge").textContent).toBe("100+ intents");
  });

  it("a non-admin's admin-only answer is not '0' / 'No live intents queued'", () => {
    const p = propsFor(nonAdmin);
    render(<OrdersPanel opps={[]} picked={null} onPick={() => {}} {...p} />);
    expect(screen.getByTestId("orders-intent-count").textContent).toBe("—");
    expect(screen.queryByText(/No live intents queued/)).toBeNull();
    expect(screen.getByTestId("orders-intent-scope").textContent).toMatch(/admin-only/);
    cleanup();
    render(<TradeStatusBar modeLabel="Demo" isLive={false} gatesLabel="x" {...p} />);
    expect(screen.getByTestId("trade-intent-badge").textContent).toBe("Intents: admin only");
  });

  it("a failed read stays 'could not be loaded' and an uncapped window stays exact", () => {
    render(<TradeStatusBar modeLabel="Demo" isLive={false} gatesLabel="x" {...propsFor(null)} />);
    expect(screen.getByTestId("trade-intent-badge").textContent).toBe("Intents: could not be loaded");
    cleanup();
    render(<TradeStatusBar modeLabel="Demo" isLive={false} gatesLabel="x" {...propsFor({ ...capped, counts: { total: 0 }, hasMore: false })} />);
    expect(screen.getByTestId("trade-intent-badge").textContent).toBe("0 intents");
  });

  it("the page reads the queue through the window-aware helper", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve, dirname } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const page = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "../../../pages/trade-command-room.tsx"), "utf8");
    expect(page).toMatch(/readIntentQueueCount\(ic\)/);
    expect(page).not.toMatch(/ic\?\.counts\?\.total/);
  });
});
