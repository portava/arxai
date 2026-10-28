// /onboarding printed "DEMO_ONLY · LIVE TRADING DISABLED" in its footer and
// "Live trading remains DISABLED" on completion for every account, including
// an armed LIVE_SHARED trader. Onboarding cannot read or change the account's
// live-trading status, so the page now says that instead.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import OnboardingPage from "./onboarding";

function status(over: Record<string, unknown> = {}) {
  return {
    onboardingId: "onb_1", status: "COMPLETED", currentStep: null, completedSteps: [], skippedSteps: [],
    paperOnlyAcknowledged: true, liveDisabledAcknowledged: true, riskDisclaimerAcknowledged: true,
    replaySimulationAcknowledged: true, brokerReadonlyAcknowledged: true, walkthroughCompleted: true,
    totalSteps: 16, nextStep: null, ...over,
  };
}

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("Onboarding page live-trading wording", () => {
  it("never states 'LIVE TRADING DISABLED' / 'Live trading remains DISABLED' as account status", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      const body = String(url).includes("/api/onboarding/steps") ? { steps: [] } : { status: status() };
      return new Response(JSON.stringify(body), { status: 200 });
    }));
    render(<OnboardingPage />);
    const footer = await screen.findByTestId("onboarding-footer");
    expect(footer.textContent).toMatch(/never change live-trading status/);
    expect(screen.getByTestId("onboarding-complete-note").textContent).toMatch(/Trading Permission card/);
    expect(document.body.textContent).not.toMatch(/LIVE TRADING DISABLED/i);
    expect(document.body.textContent).not.toMatch(/Live trading remains DISABLED/i);
  });
});
