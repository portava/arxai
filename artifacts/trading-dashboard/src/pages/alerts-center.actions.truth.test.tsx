// Alerts Center: the acknowledge / snooze / dismiss endpoints are
// requireAdmin (routes/scanner.ts) and production ignores the page's
// x-security-role header, so a non-admin click is refused with 403. The page
// must say so instead of silently reloading the same open alert.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import AlertsCenter from "./alerts-center";

const NOW = Date.parse("2026-10-28T12:00:00.000Z");

function alert(i: number, over: Record<string, unknown> = {}) {
  return {
    alertId: `a${i}`, severity: "info", source: "SCANNER", symbol: "EURUSD", timeframe: "M15",
    message: `HOT setup ${i}`, reason: "Trend + pullback", recommendedAction: "Backtest first.",
    createdAt: new Date(NOW - 2 * 60_000).toISOString(), acknowledgedAt: null, ...over,
  };
}

beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(NOW); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("Alerts Center actions", () => {
  it("a 403 on Acknowledge is shown to the user, not swallowed", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === "POST") {
        return new Response(JSON.stringify({ error: "Forbidden", requiredRole: "ADMIN" }), { status: 403 });
      }
      return new Response(JSON.stringify({ alerts: [alert(1)], count: 1 }), { status: 200 });
    }));
    render(<AlertsCenter />);
    await screen.findByTestId("alert-a1");
    fireEvent.click(screen.getByRole("button", { name: /Acknowledge/ }));
    const err = await screen.findByTestId("alert-action-error");
    expect(err.textContent).toMatch(/refused/i);
    expect(err.textContent).toMatch(/admin/i);
    expect(err.textContent).toMatch(/still open/i);
  });
});
