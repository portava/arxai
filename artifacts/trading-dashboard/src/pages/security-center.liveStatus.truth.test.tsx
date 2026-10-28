// Security Center showed "Live trading: DISABLED" in red from the security
// report's fixed liveTradingStatus label — for every platform, including one
// whose live-execution switch is on with LIVE_SHARED traders armed — and said
// "No live trading controls are exposed in the UI". The live line is now the
// platform switch as the server read it (livePosture), the fixed labels are
// called labels, and a failed load says "could not be loaded".
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import SecurityCenter from "./security-center";

const ON = "Live broker execution is switched on for the platform (server setting on, operator arm on; checked 11:40 UTC). An account sends live orders only when it is armed and every server check passes.";

function body(over: Record<string, unknown> = {}) {
  return {
    liveTradingStatus: "DISABLED", mode: "PAPER_ONLY",
    status: {
      security_status_id: "secstatus_1", appMode: "PAPER_ONLY", liveTradingStatus: "DISABLED",
      authStatus: {}, permissionStatus: {}, dataProtectionStatus: {},
      securityFlags: [], warnings: [], criticalFindings: [], recommendedActions: [],
    },
    settings: {},
    livePosture: { state: "ON", plainEnglish: ON },
    ...over,
  };
}

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("Security Center live-trading line", () => {
  it("shows the platform switch as read, never a red constant 'DISABLED' as live status", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(body()), { status: 200 })));
    render(<SecurityCenter />);
    const live = await screen.findByTestId("security-center-live-posture");
    expect(live.textContent).toContain(ON);
    expect(screen.getByTestId("security-center-mode-labels").textContent).toMatch(/not whether\s+live trading is on/);
    expect(document.body.textContent).not.toMatch(/Live trading: DISABLED/);
    expect(document.body.textContent).not.toMatch(/No live trading controls are exposed/);
    expect(document.querySelector(".text-red-600")).toBeNull();
  });

  it("a response without livePosture says it was not reported", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(body({ livePosture: undefined })), { status: 200 })));
    render(<SecurityCenter />);
    const live = await screen.findByTestId("security-center-live-posture");
    expect(live.textContent).toMatch(/not reported/);
  });

  it("a failed request is 'could not be loaded', not a crash", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "AUTH_REQUIRED" }), { status: 401 })));
    render(<SecurityCenter />);
    const err = await screen.findByTestId("security-center-load-error");
    expect(err.textContent).toMatch(/could not be loaded/);
  });
});
