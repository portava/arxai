// /help "Why am I blocked?": the drawer printed a hard-coded
// "liveTradingStatus=DISABLED" footer and "Live trading remains DISABLED" for
// every account, including an armed LIVE_SHARED trader. The server's
// explanation carries the account's posture (livePosture.plainEnglish, the
// same check as the Trading Permission card); the drawer now shows that, and a
// failed request says "could not be loaded" instead of an empty sheet.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { WhyBlockedDrawer } from "./WhyBlockedDrawer";

const ARMED = "Your account mode (checked 11:40 UTC, the same check as the dashboard's Trading Permission card): Live (shared). Live trading is active.";

function explanation(over: Record<string, unknown> = {}) {
  return {
    explanation_id: "expl_1", blockedAction: "ENABLE_LIVE_TRADING", blockingSystems: ["AA", "NN"],
    highestSeverity: "BLOCK", plainEnglishReasons: [ARMED], technicalReasons: [], recommendedFixes: [],
    safeNextStep: "Check the Trading Permission card.", links: [],
    liveTradingStatus: "DISABLED", livePosture: { state: "LIVE_ARMED", plainEnglish: ARMED },
    generatedAt: "2026-10-28T11:40:00.000Z", ...over,
  };
}

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("WhyBlockedDrawer", () => {
  it("shows the account's posture from the server, never a constant 'DISABLED'", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ liveTradingStatus: "DISABLED", explanation: explanation() }), { status: 200 })));
    render(<WhyBlockedDrawer />);
    fireEvent.click(screen.getByRole("button", { name: /Why am I blocked/ }));
    const posture = await screen.findByTestId("why-blocked-live-posture");
    expect(posture.textContent).toBe(ARMED);
    expect(document.body.textContent).not.toMatch(/liveTradingStatus=DISABLED/);
    expect(document.body.textContent).not.toMatch(/Live trading remains DISABLED/);
  });

  it("an explanation without a posture says it was not reported", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ explanation: explanation({ livePosture: undefined }) }), { status: 200 })));
    render(<WhyBlockedDrawer />);
    fireEvent.click(screen.getByRole("button", { name: /Why am I blocked/ }));
    const posture = await screen.findByTestId("why-blocked-live-posture");
    expect(posture.textContent).toMatch(/did not report your account's live-trading status/);
  });

  it("a failed request is 'could not be loaded', not an empty sheet", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "boom" }), { status: 500 })));
    render(<WhyBlockedDrawer />);
    fireEvent.click(screen.getByRole("button", { name: /Why am I blocked/ }));
    const err = await screen.findByTestId("why-blocked-load-error");
    expect(err.textContent).toMatch(/could not be loaded/);
  });
});
