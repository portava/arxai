import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, act } from "@testing-library/react";
import React from "react";
import { PositionPickerPanel } from "./PositionPickerPanel";
import { positionReportState, type UnifiedPosition } from "./PositionSideCard";

/**
 * Clock-skew guard for the position freshness re-check. observedAt and the
 * FRESH verdict are on the server's clock; Date.now() is the browser's. The
 * age of a report is (server generatedAt − observedAt) plus the time since the
 * answer arrived, never observedAt compared with the browser's clock:
 *  - a browser 45s fast must not mark every freshly polled row "Unconfirmed —
 *    last reported 47s ago";
 *  - a browser 2 minutes slow must not keep "Open — reported by bridge
 *    (0s ago)" for minutes after the poll starts failing.
 */

vi.mock("./PositionMiniChart", () => ({ PositionMiniChart: () => null }));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: () => {} }) }));
vi.mock("@/hooks/useCurrentUser", () => ({ useCurrentUser: () => ({ user: null }) }));

function row(patch: Partial<UnifiedPosition>): UnifiedPosition {
  return {
    scope: "live",
    brokerTicket: "777",
    symbol: "EURUSD",
    side: "BUY",
    lotSize: 0.1,
    entryPrice: 1.1,
    currentPrice: 1.101,
    stopLoss: 1.099,
    takeProfit: 1.103,
    floatingPnl: 12.5,
    openedAt: new Date().toISOString(),
    sourceCommandId: null,
    accountMode: "LIVE",
    source: "MT5_LIVE_BRIDGE",
    ...patch,
  };
}

function stubFetch(positions: Array<string | "fail">) {
  let i = 0;
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (String(url).includes("/api/chart/candles")) {
      return new Response(JSON.stringify({ candles: [], feedStatus: null }), { status: 200 });
    }
    const next = positions[Math.min(i++, positions.length - 1)];
    if (next === "fail") throw new Error("network down");
    return new Response(next, { status: 200 });
  }));
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("positionReportState ages a report on one clock at a time", () => {
  it("browser clock 45s fast: a report 2s old on the server is confirmed and reads 2s, not 47s", () => {
    const serverNow = Date.UTC(2026, 10, 3, 10, 0, 0);
    const browserNow = serverNow + 45_000;
    const p = { observedAt: new Date(serverNow - 2_000).toISOString(), freshness: "FRESH" as const };
    const r = positionReportState(p, browserNow, { receivedAtMs: browserNow, serverNowMs: serverNow });
    expect(r.confirmed).toBe(true);
    expect(r.status).toBe("Open — reported by bridge");
    expect(r.lastReported).toMatch(/\(2s ago\)$/);
    expect(r.lastReported).not.toMatch(/47s ago/);
  });

  it("browser clock 2 minutes slow: a FRESH verdict expires 30s after its report, not minutes later", () => {
    const serverNow = Date.UTC(2026, 10, 3, 10, 0, 0);
    const receivedAt = serverNow - 120_000;
    const p = { observedAt: new Date(serverNow - 2_000).toISOString(), freshness: "FRESH" as const };
    // 20s after the answer: the report is 22s old.
    const early = positionReportState(p, receivedAt + 20_000, { receivedAtMs: receivedAt, serverNowMs: serverNow });
    expect(early.confirmed).toBe(true);
    expect(early.lastReported).toMatch(/\(22s ago\)$/);
    // 60s after the answer with no new data: 62s old, no longer confirmed.
    const late = positionReportState(p, receivedAt + 60_000, { receivedAtMs: receivedAt, serverNowMs: serverNow });
    expect(late.confirmed).toBe(false);
    expect(late.status).toBe("Unconfirmed — last reported 1m ago");
    expect(late.lastReported).not.toMatch(/0s ago/);
  });

  it("a STALE row's age is the server's age plus the time since the answer arrived", () => {
    const serverNow = Date.UTC(2026, 10, 3, 10, 0, 0);
    const browserNow = serverNow - 600_000; // browser 10 minutes slow
    const p = { observedAt: new Date(serverNow - 5 * 60_000).toISOString(), freshness: "STALE" as const };
    const r = positionReportState(p, browserNow, { receivedAtMs: browserNow, serverNowMs: serverNow });
    expect(r.confirmed).toBe(false);
    expect(r.status).toBe("Unconfirmed — last reported 5m ago");
  });

  it("no server clock in the answer: the verdict holds 30s from arrival and no age is computed", () => {
    const browserNow = Date.UTC(2026, 10, 3, 10, 0, 0);
    const p = { observedAt: new Date(browserNow - 90_000).toISOString(), freshness: "FRESH" as const };
    const fresh = positionReportState(p, browserNow + 10_000, { receivedAtMs: browserNow, serverNowMs: null });
    expect(fresh.confirmed).toBe(true);
    expect(fresh.lastReported).not.toMatch(/ago/);
    const expired = positionReportState(p, browserNow + 31_000, { receivedAtMs: browserNow, serverNowMs: null });
    expect(expired.confirmed).toBe(false);
    expect(expired.status).not.toMatch(/ago/);
    expect(expired.status).toMatch(/^Unconfirmed — last reported at /);
  });
});

describe("PositionPickerPanel with a skewed browser clock", () => {
  it("browser 45s fast: a freshly polled FRESH row is confirmed in the list and the side card", async () => {
    const browserNow = Date.now();
    const serverNow = browserNow - 45_000;
    stubFetch([JSON.stringify({
      ok: true, generatedAt: new Date(serverNow).toISOString(),
      live: [row({ observedAt: new Date(serverNow - 2_000).toISOString(), freshness: "FRESH" })],
      demo: [], liveCount: 1, demoCount: 0, notLiveReason: null,
    })]);
    render(<PositionPickerPanel />);
    const pnl = await screen.findByTestId("text-row-pnl-live-777");
    expect(pnl.className).toMatch(/text-emerald-300/);
    expect(screen.queryByTestId("text-row-report-live-777")).toBeNull();
    fireEvent.click(screen.getByTestId("btn-select-position-live-777"));
    expect(screen.getByTestId("text-position-status").textContent).toBe("Open — reported by bridge");
    expect(screen.getByTestId("text-position-last-reported").textContent).not.toMatch(/4\ds ago/);
  });

  it("browser 2 minutes slow: once the poll fails the side card stops saying Open after the report is 30s old", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: false });
    const browserNow = Date.now();
    const serverNow = browserNow + 120_000;
    stubFetch([JSON.stringify({
      ok: true, generatedAt: new Date(serverNow).toISOString(),
      live: [row({ observedAt: new Date(serverNow - 2_000).toISOString(), freshness: "FRESH" })],
      demo: [], liveCount: 1, demoCount: 0, notLiveReason: null,
    }), "fail"]);
    render(<PositionPickerPanel />);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    fireEvent.click(screen.getByTestId("btn-select-position-live-777"));
    expect(screen.getByTestId("text-position-status").textContent).toBe("Open — reported by bridge");

    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(screen.getByTestId("text-position-status").textContent).toBe("Unconfirmed — last reported 1m ago");
    expect(screen.getByTestId("text-position-last-reported").textContent).not.toMatch(/\(0s ago\)/);
    expect(screen.getByTestId("text-row-report-live-777").textContent).toBe("Unconfirmed — last reported 1m ago");
  });
});

// Round 3 review: generatedAt is the server's clock reading before its DEMO
// reads, serialization and the transfer; the panel stamped receivedAtMs only
// after the answer was parsed. Everything in between was left out of the age,
// so a report 33s old read "25s ago" and stayed confirmed past its 30s window.
// The age is now anchored on when the request was sent: an upper bound, so it
// can only downgrade.
describe("PositionPickerPanel with a slow answer", () => {
  it("an answer that takes 8s to arrive is aged from when the request was sent, not from when it arrived", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: false });
    let first = true;
    vi.stubGlobal("fetch", vi.fn((url: string) => {
      if (String(url).includes("/api/chart/candles")) {
        return Promise.resolve(new Response(JSON.stringify({ candles: [], feedStatus: null }), { status: 200 }));
      }
      if (!first) return new Promise<Response>(() => {});
      first = false;
      // The server reads its clock when the request reaches it; the report is
      // 25s old then. Its slow reads and the transfer take another 8s.
      const serverNow = Date.now();
      const body = JSON.stringify({
        ok: true, generatedAt: new Date(serverNow).toISOString(),
        live: [row({ observedAt: new Date(serverNow - 25_000).toISOString(), freshness: "FRESH" })],
        demo: [], liveCount: 1, demoCount: 0, notLiveReason: null,
      });
      return new Promise<Response>((resolve) => setTimeout(() => resolve(new Response(body, { status: 200 })), 8_000));
    }));
    render(<PositionPickerPanel />);
    await act(async () => { await vi.advanceTimersByTimeAsync(8_000); });
    // The report is 33s old when the answer arrives: past the 30s window.
    expect(screen.getByTestId("text-row-report-live-777").textContent).toBe("Unconfirmed — last reported 33s ago");
    fireEvent.click(screen.getByTestId("btn-select-position-live-777"));
    expect(screen.getByTestId("text-position-status").textContent).toBe("Unconfirmed — last reported 33s ago");
    expect(screen.getByTestId("text-position-last-reported").textContent).not.toMatch(/\(25s ago\)/);
  });
});
