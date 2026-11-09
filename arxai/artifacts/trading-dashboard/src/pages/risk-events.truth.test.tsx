import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

// The Risk Event Log reads /api/risk/events: the trader's Risk Governor
// trail, which holds paper, demo and live decisions alike. Each row says
// the venue the server recorded for it, or that the venue was not recorded.

const { default: RiskEvents } = await import("./risk-events");

type Ev = Record<string, unknown>;
const ev = (over: Ev = {}): Ev => ({
  eventId: "ure_1", ts: new Date().toISOString(), rule: "blocked_trade", severity: "BLOCK", decision: "block",
  explanation: "Daily loss limit reached.", ...over,
});

function serve(body: unknown, status = 200) {
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: status >= 200 && status < 300, status, json: async () => body })));
}

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("Risk Event Log — venue", () => {
  it("does not label the whole log SIMULATOR; each row shows its own recorded venue", async () => {
    serve({ events: [
      ev({ eventId: "ure_1", environment: "LIVE", explanation: "Live order blocked." }),
      ev({ eventId: "ure_2", explanation: "Cooldown after loss." }),
    ] });
    render(<RiskEvents />);
    await screen.findByText("Live order blocked.");
    expect(screen.queryByText("SIMULATOR")).toBeNull();
    expect(screen.getByText("LIVE")).toBeTruthy();
    expect(screen.getByText(/venue not recorded/i)).toBeTruthy();
  });
});

describe("Risk Event Log — failed read", () => {
  it("a 500 says the log could not be loaded, not '0 events' / 'No events match filter'", async () => {
    serve({ error: "x" }, 500);
    render(<RiskEvents />);
    await screen.findByText(/could not be loaded/i);
    expect(screen.queryByText(/^0 events/)).toBeNull();
    expect(screen.queryByText(/No events match filter/i)).toBeNull();
  });

  it("a rejected request says the log could not be loaded", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("network down"); }));
    render(<RiskEvents />);
    await screen.findByText(/could not be loaded/i);
    expect(screen.queryByText(/^0 events/)).toBeNull();
    expect(screen.queryByText(/No events match filter/i)).toBeNull();
  });

  it("a read that succeeds with no events still says so", async () => {
    serve({ events: [] });
    render(<RiskEvents />);
    await screen.findByText(/No events match filter/i);
    expect(screen.queryByText(/could not be loaded/i)).toBeNull();
  });

  it("a failed refresh after a good read keeps the last list and says it is not current", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const good = { ok: true, status: 200, json: async () => ({ events: [ev({ explanation: "Daily loss limit reached." })] }) };
      const bad = { ok: false, status: 500, json: async () => ({ error: "x" }) };
      const f = vi.fn().mockResolvedValueOnce(good).mockResolvedValue(bad);
      vi.stubGlobal("fetch", f);
      render(<RiskEvents />);
      await screen.findByText("Daily loss limit reached.");
      await vi.advanceTimersByTimeAsync(3500);
      await screen.findByText(/could not be refreshed/i);
      expect(screen.getByText("Daily loss limit reached.")).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("Risk Event Log — when and how many", () => {
  it("each row shows the date as well as the time", async () => {
    const ts = new Date(Date.now() - 2 * 86_400_000).toISOString();
    serve({ events: [ev({ ts, explanation: "Blocked two days ago." })] });
    render(<RiskEvents />);
    await screen.findByText("Blocked two days ago.");
    const day = new Date(ts).toLocaleDateString();
    expect(screen.getAllByText((_, el) => el?.tagName === "SPAN" && (el.textContent ?? "").includes(day)).length).toBeGreaterThan(0);
  });

  it("a full page of 200 is disclosed as the latest 200, not as the total", async () => {
    serve({ events: Array.from({ length: 200 }, (_, i) => ev({ eventId: `ure_${i}`, explanation: `event ${i}` })) });
    render(<RiskEvents />);
    await screen.findByText("event 0");
    expect(screen.queryByText("200 events")).toBeNull();
    expect(screen.getAllByText(/latest 200/i).length).toBeGreaterThan(0);
  });

  it("fewer than 200 is the whole trail and is counted as such", async () => {
    serve({ events: [ev({ eventId: "a" }), ev({ eventId: "b" }), ev({ eventId: "c" })] });
    render(<RiskEvents />);
    await screen.findByText("3 events");
    expect(screen.queryByText(/latest 200/i)).toBeNull();
  });
});
