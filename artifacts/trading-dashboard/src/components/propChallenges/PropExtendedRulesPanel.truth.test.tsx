// Truth: the Prop Challenge "max risk per trade" rule is evaluated as each
// closed trade's realised loss vs that day's starting balance. Stop-distance
// risk at entry is never measured, so the control must not be labelled as a
// risk-at-entry limit; it must say what is checked and what is not.
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { PropExtendedRulesPanel, type ExtendedRules } from "./PropExtendedRulesPanel";

const rules: ExtendedRules = {
  trailingDrawdownEnabled: false, trailingDrawdownAmount: 0.05, trailingDrawdownType: "STATIC",
  maxRiskPerTrade: 0.01, maxOpenTrades: 5, maxPendingOrders: 5, maxPositionSize: 1,
  newsTradingAllowed: true, weekendHoldingAllowed: true, overnightHoldingAllowed: true,
  strictGuardrailsEnabled: false,
};

afterEach(() => cleanup());

describe("PropExtendedRulesPanel — per-trade rule label", () => {
  it("labels the rule as a realised loss per closed trade and says entry risk is not measured", () => {
    const qc = new QueryClient();
    render(<QueryClientProvider client={qc}><PropExtendedRulesPanel challengeId={5} rules={rules} /></QueryClientProvider>);
    expect(screen.queryByText(/^Max risk per trade/)).toBeNull();
    expect(screen.getByLabelText(/Max loss per closed trade/)).toBeTruthy();
    const basis = screen.getByTestId("prop-risk-per-trade-basis").textContent ?? "";
    expect(basis).toMatch(/realised loss/i);
    expect(basis).toMatch(/Risk at entry \(stop-loss distance\) is not measured/);
  });
});
