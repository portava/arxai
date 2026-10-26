import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import DerivHealthPage from "./deriv-health";

const now = Date.parse("2026-10-26T18:00:00Z");
function health(overrides = {}) {
  return {
    ok: true, health: "healthy", mode: "public", source: "deriv_public",
    connected: true, configured: true, authorized: false, hasRecentTick: true,
    credentials: { appId: { present: false }, token: { present: false }, accountId: { present: false } },
    lastTickAt: new Date(now - 1000).toISOString(), activeSymbols: 89, knownSymbols: 22,
    subscribedSymbols: ["R_75"],
    perSymbol: [
      { symbol: "V75", derivId: "R_75", lastTickAt: new Date(now - 1000).toISOString(), lastTickAgeMs: 1000, hasRecentTick: true, feedReadinessState: "LIVE_FEED" },
      { symbol: "V75_1S", derivId: "1HZ75V", lastTickAt: null, lastTickAgeMs: null, hasRecentTick: false, feedReadinessState: "CONNECTED_AWAITING_FEED" },
    ],
    ...overrides,
  };
}
function response(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}
async function settle() { await act(async () => { await Promise.resolve(); }); }

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(now); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("Deriv health capability and freshness boundaries", () => {
  it("shows live public prices without implying account authorization or asking for tokens", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response(health())));
    render(<DerivHealthPage />); await settle();
    expect(screen.getByText("Live market prices")).toBeTruthy();
    expect(screen.getByText("Not available on this public connection")).toBeTruthy();
    expect(screen.getByText("1 / 22")).toBeTruthy();
    expect(screen.getByText(/No app ID, API token or account login is required/)).toBeTruthy();
    expect(screen.queryByText(/pat_xxxx/)).toBeNull();
    expect(screen.getByText("V75").parentElement?.textContent).toContain("Live · 1s ago");
    expect(screen.getByText("V75_1S").parentElement?.textContent).toContain("Not live");
  });

  it("ages the last venue timestamp without waiting for another server response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response(health({ lastTickAt: new Date(now - 30_000).toISOString() }))));
    render(<DerivHealthPage />); await settle();
    expect(screen.getByText("Live market prices")).toBeTruthy();
    await act(async () => { vi.advanceTimersByTime(1000); });
    expect(screen.queryByText("Live market prices")).toBeNull();
    expect(screen.getByText("Live prices not verified")).toBeTruthy();
  });

  it.each([
    { connected: false }, { hasRecentTick: false },
    { lastTickAt: new Date(now + 1000).toISOString() }, { lastTickAt: "invalid" },
  ])("refuses fresh presentation when provider evidence is invalid: %j", async overrides => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response(health(overrides))));
    render(<DerivHealthPage />); await settle();
    expect(screen.getByText("Live prices not verified")).toBeTruthy();
    expect(screen.queryByText("Live market prices")).toBeNull();
  });

  it("clears stale green status on an HTTP access failure and recovers on refresh", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(response(health())).mockResolvedValueOnce(response({ error: "FORBIDDEN" }, 403)).mockResolvedValue(response(health()));
    vi.stubGlobal("fetch", fetcher);
    render(<DerivHealthPage />); await settle();
    fireEvent.click(screen.getByRole("button", { name: "Refresh" })); await settle();
    expect(screen.getByRole("alert")).toBeTruthy();
    expect(screen.queryByText("Live market prices")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Refresh" })); await settle();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByText("Live market prices")).toBeTruthy();
  });

  it("releases the check button after network failure without triggering any trading route", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(response(health())).mockRejectedValueOnce(new Error("offline"));
    vi.stubGlobal("fetch", fetcher);
    render(<DerivHealthPage />); await settle();
    fireEvent.click(screen.getByRole("button", { name: "Test Connection" })); await settle();
    expect((screen.getByRole("button", { name: "Test Connection" }) as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getByRole("alert")).toBeTruthy();
    expect(fetcher.mock.calls.map(c => c[0])).toEqual(["/api/admin/deriv-status", "/api/admin/deriv-status/check"]);
  });

  it("ignores an older refresh completing after the latest response", async () => {
    let release!: (value: Response) => void;
    const fetcher = vi.fn().mockImplementationOnce(() => new Promise<Response>(resolve => { release = resolve; })).mockResolvedValue(response(health({ connected: false })));
    vi.stubGlobal("fetch", fetcher);
    render(<DerivHealthPage />);
    fireEvent.click(screen.getByRole("button", { name: "Refreshing…" })); await settle();
    expect(fetcher.mock.calls[0]![1].signal.aborted).toBe(true);
    await act(async () => { release(response(health())); });
    expect(screen.getByText("Live prices not verified")).toBeTruthy();
    expect(screen.queryByText("Live market prices")).toBeNull();
  });

  it("aborts the request and stops automatic refresh on unmount", async () => {
    const fetcher = vi.fn().mockImplementation(() => new Promise(() => {}));
    vi.stubGlobal("fetch", fetcher);
    const { unmount } = render(<DerivHealthPage />);
    const signal = fetcher.mock.calls[0]![1].signal as AbortSignal;
    unmount();
    await act(async () => { vi.advanceTimersByTime(30_000); });
    expect(signal.aborted).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("bounds a hung connection check and restores the controls", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(response(health())).mockImplementation(() => new Promise(() => {}));
    vi.stubGlobal("fetch", fetcher);
    render(<DerivHealthPage />); await settle();
    fireEvent.click(screen.getByRole("button", { name: "Test Connection" }));
    await act(async () => { vi.advanceTimersByTime(12_000); });
    expect(fetcher.mock.calls[1]![1].signal.aborted).toBe(true);
    expect((screen.getByRole("button", { name: "Test Connection" }) as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByRole("button", { name: "Refresh" }) as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getByRole("alert")).toBeTruthy();
    expect(screen.queryByText("Live market prices")).toBeNull();
  });

  it("does not starve a slow status response with automatic refreshes", async () => {
    let release!: (value: Response) => void;
    const fetcher = vi.fn().mockImplementation(() => new Promise<Response>(resolve => { release = resolve; }));
    vi.stubGlobal("fetch", fetcher);
    render(<DerivHealthPage />);
    await act(async () => { vi.advanceTimersByTime(11_000); });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]![1].signal.aborted).toBe(false);
    await act(async () => { release(response(health())); });
    expect(screen.getByText("Live market prices")).toBeTruthy();
  });

  it("immediately ages old prices when returning from a hidden tab", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(response(health())).mockImplementation(() => new Promise(() => {})));
    render(<DerivHealthPage />); await settle();
    vi.setSystemTime(now + 60_000);
    // No interval ran while hidden; visibility must age the old result itself.
    act(() => { document.dispatchEvent(new Event("visibilitychange")); });
    expect(screen.getByText("Live prices not verified")).toBeTruthy();
    expect(screen.queryByText("Live market prices")).toBeNull();
  });
});
