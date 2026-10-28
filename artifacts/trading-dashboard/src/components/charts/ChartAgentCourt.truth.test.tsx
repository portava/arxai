// Chart Pulse "Agent court" chip and the Agent consensus panel agree with the
// state and with Ruby (truth upgrade, 2026-10-28).
//
// The Pulse chip was hard-coded "Agent court: standby" while the consensus
// panel directly below showed a populated stance and agent votes — even when
// the chart-truth gate was closed, where the Ruby panel on the same tab says
// "Chart data not verified — agent consensus withheld." Both now read the
// state: no read → "no read"; populated but unverified → withheld (like Ruby);
// populated and verified → the advisory stance.

import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup, screen } from "@testing-library/react";
import type { ChartIntelligenceResponse } from "@workspace/api-client-react";
import { ChartPulse } from "./ChartPulse";
import { ChartAgentConsensusPanel } from "./ChartReadPanels";

type ChartState = ChartIntelligenceResponse["state"];

afterEach(() => cleanup());

function state(opts: { populated: boolean; truth: number }): ChartState {
  const ok = opts.truth >= 75;
  return {
    symbol: "EURUSD",
    displaySymbol: "EURUSD",
    timeframe: "M5",
    truthState: { isLive: true, stale: false, aiUsable: true, quality: "clean", message: "Feed nominal" },
    aiUsable: true,
    stale: false,
    marketUnderstanding: {
      trend: { populated: true, regime: "trending", direction: "bullish" },
      levels: { nearestSupport: null, nearestResistance: null },
    },
    decisionState: { populated: true, bias: "bullish", quality: "B", actionability: "prepare", vetoed: false },
    fastFlags: { populated: true, momentumBurst: false },
    candleStats: { direction: "up" },
    marketSentences: { risk: { tone: "info", text: "" }, bestNextAction: { tone: "neutral", text: "x" } },
    setupState: { populated: false, ageBars: null, stage: "no_setup" },
    agentConsensus: opts.populated
      ? {
          populated: true, headline: "Agents lean supportive.", detail: "", stance: "support", conflict: false,
          protective: false, influencingAgentCount: 1, agents: [{ name: "X", stance: "SUPPORT" }], cautions: [],
          note: "Advisory/shadow consensus only — never gates a trade or the live path.",
        }
      : {
          populated: false, headline: "No agent consensus yet.", detail: "", stance: "neutral", conflict: false,
          protective: false, influencingAgentCount: 0, agents: [], cautions: [],
          note: "Specialist agents are in shadow — no consensus influenced this read.",
        },
    gateOutput: {
      chartTruthScore: opts.truth, confidentReadAllowed: ok, autonomousChartActionAllowed: true, tradeConfirmationAllowed: true,
    },
  } as unknown as ChartState;
}

describe("Agent court chip and consensus panel", () => {
  it("is never hard-coded 'standby': a verified populated read shows its advisory stance on both", () => {
    const s = state({ populated: true, truth: 87 });
    render(<><ChartPulse state={s} /><ChartAgentConsensusPanel state={s} /></>);
    const chip = screen.getByTestId("pulse-agent-court").textContent ?? "";
    expect(chip).not.toMatch(/standby/);
    expect(chip).toMatch(/support/);
    expect(screen.getByTestId("chart-consensus-panel").textContent).toContain("X: support");
  });

  it("an unverified read withholds the consensus on both, matching Ruby", () => {
    const s = state({ populated: true, truth: 70 });
    render(<><ChartPulse state={s} /><ChartAgentConsensusPanel state={s} /></>);
    expect(screen.getByTestId("pulse-agent-court").textContent).toMatch(/withheld/i);
    const panel = screen.getByTestId("chart-consensus-panel").textContent ?? "";
    expect(panel).not.toContain("X: support");
    expect(panel).not.toContain("Agents lean supportive.");
    expect(panel).toContain("Chart data not verified — agent consensus withheld.");
    expect(panel).toContain("Chart Truth 70/100 (needs 75)");
  });

  it("no populated consensus reads 'no read', not 'standby'", () => {
    const s = state({ populated: false, truth: 87 });
    render(<ChartPulse state={s} />);
    const chip = screen.getByTestId("pulse-agent-court");
    expect(chip.textContent).toBe("Agent court: no read");
    expect(chip.getAttribute("title")).toMatch(/shadow/);
  });
});
