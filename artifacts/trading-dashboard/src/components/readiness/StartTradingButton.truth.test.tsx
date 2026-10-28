import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import React from "react";
import { StartTradingButton } from "./StartTradingButton";

/**
 * Truth guard: the readiness LOCKED status is advisory (api-server
 * routes/tradingReadiness.ts) and the page header says so. The button must not
 * claim "Trading LOCKED"; execution gates decide independently.
 */

afterEach(() => cleanup());

describe("StartTradingButton LOCKED copy", () => {
  it("says the readiness label is advisory instead of 'Trading LOCKED'", () => {
    render(<StartTradingButton status="LOCKED" onProceed={() => {}} />);
    expect(screen.queryByText(/Trading LOCKED/)).toBeNull();
    expect(screen.getByTestId("btn-readiness-locked").textContent).toBe("Readiness LOCKED — resolve the blockers above");
    expect(screen.getByTestId("text-readiness-locked-advisory").textContent).toMatch(/^Advisory: this pre-session check does not lock or unlock trading\./);
  });
});
