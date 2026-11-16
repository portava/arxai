// Risk Governor card / onboarding "Risk Controls" chip: the trade command room
// passed riskLevel="Low" literally (always green) and onboarding showed
// "Active" whenever the account was not frozen. No risk metric was read. The
// label must come from the envelope's real freeze state and caps, and say
// "Checking" / "No caps assigned" instead of inventing a level.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import fs from "node:fs";
import path from "node:path";
import { riskCapsStatus, type RiskCapsEnvelopeSlice } from "@/lib/riskCapsStatus";

vi.mock("wouter", () => ({
  Link: ({ children, href }: { children: React.ReactNode; href: string }) => <a href={href}>{children}</a>,
}));

const { RiskGovernorCard } = await import("./TradePanels");

const NO_CAPS: RiskCapsEnvelopeSlice = {
  userRiskCaps: { maxLotSize: null, maxOpenTrades: null, maxDailyLossAmount: null, allowedSymbols: null },
  userFrozenStatus: { isFrozen: false },
};

afterEach(cleanup);

describe("risk caps status (no invented risk level)", () => {
  it("not frozen with no caps assigned is not 'Low' or 'Active'", () => {
    const s = riskCapsStatus(NO_CAPS);
    expect(s.label).toBe("No caps assigned");
    expect(s.tone).toBe("warning");
  });

  it("unknown envelope is Checking; frozen is a lock; assigned caps do not claim a level", () => {
    expect(riskCapsStatus(null).label).toBe("Checking");
    expect(riskCapsStatus({ ...NO_CAPS, userFrozenStatus: { isFrozen: true } }).label).toBe("Lock active");
    const s = riskCapsStatus({ ...NO_CAPS, userRiskCaps: { ...NO_CAPS.userRiskCaps, maxDailyLossAmount: 50 } });
    expect(s.label).toBe("Caps assigned");
    expect(s.tone).not.toBe("success");
  });

  it("the Risk Governor card renders the derived status, not a green 'Low'", () => {
    const s = riskCapsStatus(NO_CAPS);
    render(<RiskGovernorCard statusLabel="Trading available" statusTone="success" riskCaps={s}
      bridge="Connected" approval="Approved" isAdmin={false} rawCanPlace rawMode="LIVE" />);
    const card = screen.getByTestId("risk-governor-card").textContent ?? "";
    expect(card).toContain("No caps assigned");
    expect(card).not.toMatch(/\bLow\b/);
  });

  it("no surface hard-codes the risk level or derives 'Active' from not-frozen", () => {
    const room = fs.readFileSync(path.join(__dirname, "../../../pages/trade-command-room.tsx"), "utf8");
    expect(room).not.toMatch(/riskLevel="Low"/);
    expect(room).toMatch(/riskCapsStatus\(/);
    const onboarding = fs.readFileSync(path.join(__dirname, "../../onboarding/OnboardingProvider.tsx"), "utf8");
    expect(onboarding).not.toMatch(/\{ label: "Active", tone: "success" as const \}/);
    expect(onboarding).toMatch(/riskCapsStatus\(/);
  });
});
