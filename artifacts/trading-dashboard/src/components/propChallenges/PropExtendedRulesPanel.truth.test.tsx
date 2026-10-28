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
