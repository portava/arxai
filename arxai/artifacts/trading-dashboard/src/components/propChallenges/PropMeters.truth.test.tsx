import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import React from "react";
import { PropDrawdownMeter } from "./PropDrawdownMeter";
import { PropDailyLossLimitCard } from "./PropDailyLossLimitCard";

/**
 * Truth guard: the evaluator (api-server routes/propChallenges.ts) fails a
 * challenge only when drawdown / daily loss is strictly ABOVE the limit. The
 * meters must not say "breached — fails on next evaluation" at exactly it.
 */

afterEach(() => cleanup());

describe("PropDrawdownMeter at the limit", () => {
  it("exactly at the limit is not shown as breached", () => {
    render(<PropDrawdownMeter ddPct={0.1} limit={0.1} />);
    const state = screen.getByTestId("text-drawdown-state");
    expect(state.textContent).not.toMatch(/breached/i);
    expect(state.textContent).toBe("At the drawdown limit. The challenge fails only if drawdown goes above it.");
    expect(state.className).not.toMatch(/text-red/);
  });

  it("above the limit is shown as breached", () => {
    render(<PropDrawdownMeter ddPct={0.1001} limit={0.1} />);
    expect(screen.getByTestId("text-drawdown-state").textContent).toBe("Drawdown limit breached — challenge fails on next evaluation.");
  });

  it("exactly 80% of the limit is not yet a warning (the evaluator warns only above it)", () => {
    render(<PropDrawdownMeter ddPct={0.08} limit={0.1} />);
    expect(screen.queryByTestId("text-drawdown-state")).toBeNull();
  });
});

describe("PropDailyLossLimitCard at the limit", () => {
  it("exactly at the limit is not coloured as a breach", () => {
    render(<PropDailyLossLimitCard worstPct={0.05} worstDate="2026-10-27" limit={0.05} />);
    const bar = screen.getByTestId("bar-daily-loss");
    expect(bar.className).not.toMatch(/bg-red-500/);
    expect(bar.className).toMatch(/bg-amber-500/);
  });

  it("above the limit is coloured as a breach", () => {
    render(<PropDailyLossLimitCard worstPct={0.051} worstDate="2026-10-27" limit={0.05} />);
    expect(screen.getByTestId("bar-daily-loss").className).toMatch(/bg-red-500/);
  });
});
