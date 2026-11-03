import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { PropExtendedRulesPanel, type ExtendedRules } from "./PropExtendedRulesPanel";

/**
 * Truth guard: "Strict guardrails" is read only by the assistant's
 * getPropFirmModeStatus tool (lib/assistant/tools.ts), which reports BLOCKED
 * instead of VIOLATION. The challenge evaluator and the paper order path never
 * read it, so the panel must not promise BLOCKED status or flagged demo actions.
 */

const rules: ExtendedRules = {
  trailingDrawdownEnabled: false,
  trailingDrawdownAmount: 0.05,
  trailingDrawdownType: "STATIC",
  maxRiskPerTrade: 0.01,
  maxOpenTrades: 3,
  maxPendingOrders: 2,
  maxPositionSize: 1,
  newsTradingAllowed: true,
  weekendHoldingAllowed: false,
  overnightHoldingAllowed: true,
  strictGuardrailsEnabled: true,
};

afterEach(() => cleanup());

describe("PropExtendedRulesPanel strict guardrails copy", () => {
  it("says what the toggle does and does not do", () => {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <PropExtendedRulesPanel challengeId={1} rules={rules} />
      </QueryClientProvider>,
    );
    const copy = screen.getByTestId("text-strict-guardrails-scope").textContent ?? "";
    expect(copy).not.toMatch(/demo actions are flagged/i);
    expect(copy).not.toMatch(/escalate demo rule status/i);
    expect(copy).toMatch(/assistant/i);
    expect(copy).toMatch(/does not block, flag or change any order/i);
    expect(copy).toMatch(/challenge evaluation on this page ignores it/i);
  });
});

// Truth: the Prop Challenge "max risk per trade" rule is evaluated as each
// closed trade's realised loss vs that day's starting balance. Stop-distance
// risk at entry is never measured, so the control must not be labelled as a
// risk-at-entry limit; it must say what is checked and what is not.
const perTradeRules: ExtendedRules = {
  trailingDrawdownEnabled: false, trailingDrawdownAmount: 0.05, trailingDrawdownType: "STATIC",
  maxRiskPerTrade: 0.01, maxOpenTrades: 5, maxPendingOrders: 5, maxPositionSize: 1,
  newsTradingAllowed: true, weekendHoldingAllowed: true, overnightHoldingAllowed: true,
  strictGuardrailsEnabled: false,
};

describe("PropExtendedRulesPanel — per-trade rule label", () => {
  it("labels the rule as a realised loss per closed trade and says entry risk is not measured", () => {
    const qc = new QueryClient();
    render(<QueryClientProvider client={qc}><PropExtendedRulesPanel challengeId={5} rules={perTradeRules} /></QueryClientProvider>);
    expect(screen.queryByText(/^Max risk per trade/)).toBeNull();
    expect(screen.getByLabelText(/Max loss per closed trade/)).toBeTruthy();
    const basis = screen.getByTestId("prop-risk-per-trade-basis").textContent ?? "";
    expect(basis).toMatch(/realised loss/i);
    expect(basis).toMatch(/Risk at entry \(stop-loss distance\) is not measured/);
  });
});
