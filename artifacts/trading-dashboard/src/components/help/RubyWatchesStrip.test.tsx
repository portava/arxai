// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { RubyWatchesStrip, describeWatch } from "./RubyWatchesStrip";
import type { RubyWatchView } from "@/lib/instantTradeRouter";

const monitor: RubyWatchView = {
  id: 5, kind: "MONITOR_TRADE", status: "ACTIVE", symbol: "EURUSD", side: null, lot: null, positionTicket: "123",
  trigger: null, expiresAt: null, createdAt: "2026-11-04T10:00:00.000Z",
  monitor: { alertsSinceAck: 2, maxAlerts: 3, lastAlertAt: "2026-11-04T10:05:00.000Z", acknowledgedAt: null, keepCount: 0, awaitingAnswer: true,
    lastAlert: { at: "2026-11-04T10:05:00.000Z", price: 1.1, reversalRiskScore: 80, health: "weakening", reason: "reversal risk 80 ≥ 65" } },
};
const entry: RubyWatchView = {
  id: 6, kind: "WATCH_AND_ENTER", status: "ACTIVE", symbol: "XAUUSD", side: "BUY", lot: 0.1, positionTicket: null,
  trigger: { op: ">=", price: 2400 }, expiresAt: null, createdAt: "2026-11-04T10:00:00.000Z", monitor: null,
};

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("describeWatch", () => {
  it("words each kind", () => {
    expect(describeWatch(monitor)).toBe("Monitoring EURUSD #123");
    expect(describeWatch(entry)).toBe("Buy XAUUSD 0.1 when price reaches 2400");
    expect(describeWatch({ ...entry, kind: "WATCH_AND_CLOSE", trigger: { op: "<=", price: 2300 } })).toBe("Close XAUUSD when price drops to 2300");
  });
});

describe("RubyWatchesStrip", () => {
  it("renders nothing without watches", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ ok: true, watches: [], sweeper: { enabled: true, running: true, intervalMs: 10000 } }))));
    render(<RubyWatchesStrip />);
    await waitFor(() => expect(fetch).toHaveBeenCalled());
    expect(screen.queryByTestId("ruby-watches-strip")).toBeNull();
  });

  it("shows the alert count, the answer buttons for a waiting monitor, and posts the answer", async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).endsWith("/ack")) {
        expect(JSON.parse(String(init?.body))).toEqual({ decision: "keep" });
        return new Response(JSON.stringify({ ok: true, decision: "keep", message: "Understood — staying in." }));
      }
      return new Response(JSON.stringify({ ok: true, watches: [monitor, entry], sweeper: { enabled: true, running: true, intervalMs: 10000 } }));
    });
    vi.stubGlobal("fetch", fetchMock);
    const onMessage = vi.fn();
    render(<RubyWatchesStrip onMessage={onMessage} />);
    await screen.findByTestId("ruby-watches-strip");
    expect(screen.getByTestId("ruby-watch-5-alerts").textContent).toContain("reversal alert 2/3");
    expect(screen.queryByTestId("ruby-watch-6-keep")).toBeNull();
    fireEvent.click(screen.getByTestId("ruby-watch-5-keep"));
    await waitFor(() => expect(onMessage).toHaveBeenCalledWith("Understood — staying in."));
    expect(fetchMock.mock.calls.some((c) => String(c[0]).includes("/api/me/assistant/watches/5/ack"))).toBe(true);
  });

  it("says so when the sweeper is off", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ ok: true, watches: [entry], sweeper: { enabled: false, running: false, intervalMs: 10000 } }))));
    render(<RubyWatchesStrip />);
    await screen.findByTestId("ruby-watches-sweeper-off");
  });
});
