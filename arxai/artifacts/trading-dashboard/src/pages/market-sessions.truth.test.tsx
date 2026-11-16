// Truth regression: the Market Sessions page must say the FX market is closed
// on the weekend (server `marketClosed`) and must not show any session OPEN.

import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, act } from "@testing-library/react";
import MarketSessionsPage, { nextOpenText } from "./market-sessions";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Market Sessions — weekend", () => {
  it("shows the weekend close and no OPEN badge", async () => {
    const clock = {
      nowUTC: "2026-10-31T13:30:00.000Z",
      marketClosed: true,
      activeSessions: [],
      overlap: false,
      sessionLabel: "CLOSED",
      recommendation: "Interbank FX is closed for the weekend (Friday 17:00 to Sunday 17:00 New York time). No session is open.",
      sessions: [
        { id: "Sydney", isActive: false, nextOpenInHours: 33, nextCloseInHours: 42 },
        { id: "Tokyo", isActive: false, nextOpenInHours: 35, nextCloseInHours: 44 },
        { id: "London", isActive: false, nextOpenInHours: 42, nextCloseInHours: 51 },
        { id: "NewYork", isActive: false, nextOpenInHours: 48, nextCloseInHours: 57 },
      ],
    };
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => clock }) as unknown as Response));
    render(<MarketSessionsPage />);
    expect(await screen.findByTestId("sessions-weekend-closed")).toBeTruthy();
    expect(screen.queryByText("OPEN")).toBeNull();
    expect(screen.queryByText("No major session active.")).toBeNull();
  });
});

// The server now steps through the weekend close (hoursToNextTransition) and
// sends marketClosed, so its nextOpenInHours on a Saturday is the real wait to
// the Sunday reopen. The page dropped it and showed only "Closed for the
// weekend". It now shows when each session next opens, as a UTC time.
describe("Market Sessions — weekend next open", () => {
  const sessions = [
    { id: "Sydney", isActive: false, nextOpenInHours: 33, nextCloseInHours: 42 },
    { id: "Tokyo", isActive: false, nextOpenInHours: 35, nextCloseInHours: 44 },
    { id: "London", isActive: false, nextOpenInHours: 42, nextCloseInHours: 51 },
    { id: "NewYork", isActive: false, nextOpenInHours: 48, nextCloseInHours: 57 },
  ];
  const base = {
    nowUTC: "2026-10-31T13:30:00.000Z", activeSessions: [], overlap: false,
    sessionLabel: "CLOSED", recommendation: "Interbank FX is closed for the weekend.", sessions,
  };

  it("shows the server's weekend-aware next open time for each session", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ ...base, marketClosed: true }) }) as unknown as Response));
    render(<MarketSessionsPage />);
    await screen.findByTestId("sessions-weekend-closed");
    // Sat 13:00 UTC hour start + 33 h = Sun 22:00 UTC.
    expect(screen.getByTestId("session-next-open-Sydney").textContent).toMatch(/Sun 22:00 UTC/);
    expect(screen.getByTestId("session-next-open-NewYork").textContent).toMatch(/Mon 13:00 UTC/);
    expect(screen.queryByText("OPEN")).toBeNull();
  });

  it("an older server (no marketClosed, hour-only times) gets no next-open time at the weekend", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ ...base, sessionLabel: "QUIET" }) }) as unknown as Response));
    render(<MarketSessionsPage />);
    await screen.findByTestId("sessions-weekend-closed");
    expect(screen.queryByTestId("session-next-open-Sydney")).toBeNull();
    expect(screen.getAllByText("Closed for the weekend.").length).toBe(4);
  });
});


// The weekend countdown was measured from the server time in the last
// successful response. When later polls failed the page kept that response,
// so "(in 32h 30m)" stayed on screen for hours as the current wait, and the
// error line never said the figures were from an earlier read.
describe("Market Sessions — weekend countdown keeps time when polls fail", () => {
  const sessions = [
    { id: "Sydney", isActive: false, nextOpenInHours: 33, nextCloseInHours: 42 },
    { id: "Tokyo", isActive: false, nextOpenInHours: 35, nextCloseInHours: 44 },
    { id: "London", isActive: false, nextOpenInHours: 42, nextCloseInHours: 51 },
    { id: "NewYork", isActive: false, nextOpenInHours: 48, nextCloseInHours: 57 },
  ];
  const body = {
    nowUTC: "2026-10-31T13:30:00.000Z", marketClosed: true, activeSessions: [], overlap: false,
    sessionLabel: "CLOSED", recommendation: "Interbank FX is closed for the weekend.", sessions,
  };
  afterEach(() => { vi.useRealTimers(); });

  it("counts down from the elapsed time and names the last read once polls fail", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-31T13:30:00.000Z"));
    let calls = 0;
    vi.stubGlobal("fetch", vi.fn(async () => {
      calls += 1;
      if (calls === 1) return { ok: true, status: 200, json: async () => body } as unknown as Response;
      return { ok: false, status: 503, json: async () => ({}) } as unknown as Response;
    }));
    render(<MarketSessionsPage />);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    // Sat 13:30 UTC → Sun 22:00 UTC.
    expect(screen.getByTestId("session-next-open-Sydney").textContent).toMatch(/Sun 22:00 UTC \(in 32h 30m\)/);
    // Two hours of failed polls.
    await act(async () => { await vi.advanceTimersByTimeAsync(2 * 3_600_000); });
    expect(calls).toBeGreaterThan(1);
    const sydney = screen.getByTestId("session-next-open-Sydney").textContent ?? "";
    expect(sydney).toMatch(/Sun 22:00 UTC/);
    expect(sydney).not.toMatch(/in 32h 30m/);
    expect(sydney).toMatch(/in 30h 30m/);
    const errLine = screen.getByText(/Could not load the session clock/).textContent ?? "";
    expect(errLine).toMatch(/last successful read/i);
    expect(errLine).toMatch(/13:30 UTC/);
  });

  it("a countdown that runs past the open time does not show a negative or zero wait", () => {
    // The open time is passed by 1 hour of elapsed client time with no fresh read.
    const text = nextOpenText("2026-11-01T21:30:00.000Z", 1, 3_600_000) ?? "";
    expect(text).toMatch(/^Sun 22:00 UTC/);
    expect(text).not.toMatch(/in -|in 0h 0m/);
    expect(text).toMatch(/not confirmed/i);
  });

  // Review pass 2: minutes were rounded before the "has passed" check, so a
  // fresh read 25 s before the open said the time had passed and the reopen
  // was not confirmed until the clock was read again — both false.
  it("a fresh read 25 s before the open says it opens in under a minute, not that it has passed", () => {
    const text = nextOpenText("2026-11-08T21:59:35.000Z", 1, 0) ?? "";
    expect(text).toBe("Sun 22:00 UTC (in under a minute)");
    expect(text).not.toMatch(/passed|not confirmed/i);
  });

  it("an elapsed-time tick 20 s before the open (failed polls) says under a minute", () => {
    const text = nextOpenText("2026-11-08T21:30:00.000Z", 1, 29 * 60_000 + 40_000) ?? "";
    expect(text).toBe("Sun 22:00 UTC (in under a minute)");
  });

  it("exactly at the open time with no fresh read, the time has passed", () => {
    const text = nextOpenText("2026-11-08T21:30:00.000Z", 1, 30 * 60_000) ?? "";
    expect(text).toMatch(/that time has passed/);
  });

  it("a minute or more away still shows hours and minutes", () => {
    expect(nextOpenText("2026-11-08T21:58:30.000Z", 1, 0)).toBe("Sun 22:00 UTC (in 0h 2m)");
    expect(nextOpenText("2026-11-08T21:59:00.000Z", 1, 0)).toBe("Sun 22:00 UTC (in 0h 1m)");
  });
});
