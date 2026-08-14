import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup, within } from "@testing-library/react";
import type { ScalpResult } from "@workspace/api-client-react";
import { RubyReasoningBlock } from "./RubyReasoningBlock";
import {
  buildReasoningFromScalp,
  buildReasoningFromSelfTrade,
  NEWS_UNAVAILABLE_NOTE,
  type RubyReasoningBlockData,
} from "@/lib/rubyReasoningBlock";

afterEach(() => cleanup());

/**
 * Render-proof coverage for the ONE standardized, ALWAYS-VISIBLE Ruby Reasoning
 * Block. These tests prove the display contract end-to-end (component + the
 * honesty-preserving builders), asserting via stable data-testids — never via
 * scrubbed user-facing prose. They cover the 10 spec scenarios:
 *   1. every labeled line renders for a clean directional read,
 *   2. the compact (dense) card keeps every label,
 *   3. reasoning is NEVER hidden behind a collapse/accordion,
 *   4. the chat surface uses the identical block format as the scalp card,
 *   5. a downgraded/awaiting feed -> WAIT + the limit stated in Feed/Data, no
 *      fabricated direction or levels,
 *   6. an extended move -> TOO LATE,
 *   7. a blind / low-visibility read -> Conditional + the limit in Feed/Data,
 *   8. a real plan surfaces levels + the support/resistance watch-out,
 *   9. a blocking safety-gate FAIL -> NO TRADE + the gate named in Risk Note,
 *  10. a missing news provider -> the NEWS_UNAVAILABLE_NOTE in Risk.
 *
 * DISPLAY ONLY: nothing here asserts (or could grant) an execution permission.
 */

const ALL_LINE_SUFFIXES = [
  "decision",
  "why",
  "evidence",
  "evidence-structure",
  "evidence-momentum",
  "evidence-pattern",
  "evidence-supportResistance",
  "evidence-feedData",
  "evidence-risk",
  "confirmation",
  "invalidation",
  "trader-test",
  "risk-note",
] as const;

function cleanData(): RubyReasoningBlockData {
  return {
    decision: "BUY setup",
    why: "Trend up with a clean pullback into support.",
    evidence: {
      structure: "Higher highs and higher lows on the 15m.",
      momentum: "Momentum turning back up off the pullback.",
      pattern: "Bull flag continuation.",
      supportResistance: "Resting on prior support; room to the next level up.",
      feedData: "Live candles confirmed.",
      risk: "Spread normal. Manage to your plan.",
    },
    confirmation: "Confirms on a clean break of the flag high.",
    invalidation: "Cancel if price breaks back below support.",
    traderTest: "Mark support and watch whether the next candle holds it.",
    riskNote: "Don't chase if it has already run.",
  };
}

function makeScalp(partial: Partial<ScalpResult>): ScalpResult {
  const base = {
    symbol: "EURUSD",
    displayName: "EUR/USD",
    assetClass: "forex",
    direction: "NONE",
    scalpType: "flame",
    mode: "FOCUS",
    status: "READY",
    qualityScore: 0,
    confidenceLabel: "LOW",
    entryType: "MARKET",
    entryZone: null,
    currentPrice: null,
    takeProfit: { main: null },
    stopLoss: null,
    invalidationPrice: null,
    suggestedLot: null,
    minLot: null,
    maxLot: null,
    lotStep: null,
    digits: null,
    targetProfitAmount: null,
    estimatedProfitMainTP: null,
    estimatedRiskAmount: null,
    rewardToRisk: null,
    estimatedMargin: null,
    spreadRisk: "NORMAL",
    slippageRisk: "LOW",
    newsRisk: "",
    timingStatus: "OK",
    validForSeconds: 60,
    expiresAt: "",
    chaseWarning: null,
    plainEnglishReason: "",
    riskWarning: null,
    targetRealityCheck: "OK",
    userAction: "WAIT",
    canBuildTrade: false,
    canWatch: true,
    noTradeReason: null,
    flame: { blind: true, scalpScore: 0, setupType: "NONE" },
    generatedAt: "",
    ...partial,
  };
  return base as unknown as ScalpResult;
}

describe("RubyReasoningBlock — always-visible standardized format", () => {
  it("1. renders every labeled line for a clean directional read", () => {
    render(<RubyReasoningBlock data={cleanData()} testid="rb" />);
    for (const suffix of ALL_LINE_SUFFIXES) {
      expect(screen.getByTestId(`rb-${suffix}`)).toBeTruthy();
    }
    expect(screen.getByTestId("rb-decision").textContent).toContain("BUY setup");
    expect(screen.getByText("Eleanor's Reasoning")).toBeTruthy();
  });

  it("2. keeps every label in the compact (dense) card variant", () => {
    render(<RubyReasoningBlock data={cleanData()} testid="rb" dense />);
    for (const suffix of ALL_LINE_SUFFIXES) {
      expect(screen.getByTestId(`rb-${suffix}`)).toBeTruthy();
    }
    // All six evidence factors are always present even when compact.
    for (const k of ["structure", "momentum", "pattern", "supportResistance", "feedData", "risk"]) {
      expect(screen.getByTestId(`rb-evidence-${k}`).textContent).toBeTruthy();
    }
  });

  it("3. never hides reasoning behind a collapse/accordion", () => {
    const { container } = render(<RubyReasoningBlock data={cleanData()} testid="rb" />);
    // No toggle/expander of any kind: the block is fully visible immediately.
    expect(container.querySelectorAll("button").length).toBe(0);
    // Every factor is in the DOM without any interaction.
    expect(screen.getByTestId("rb-evidence-feedData").textContent).toBeTruthy();
    expect(screen.getByTestId("rb-risk-note").textContent).toBeTruthy();
  });

  it("4. chat surface uses the identical block format as the scalp card", () => {
    const data = cleanData();
    const { container: chat } = render(
      <RubyReasoningBlock data={data} testid="ruby-chat-reasoning" dense />,
    );
    const { container: scalp } = render(
      <RubyReasoningBlock data={data} testid="scalp-reasoning-EURUSD" dense />,
    );
    const suffixes = (root: HTMLElement, prefix: string) =>
      Array.from(root.querySelectorAll<HTMLElement>("[data-testid]"))
        .map((el) => el.dataset.testid!.replace(`${prefix}-`, ""))
        .filter((s) => s !== prefix)
        .sort();
    expect(suffixes(chat, "ruby-chat-reasoning")).toEqual(
      suffixes(scalp, "scalp-reasoning-EURUSD"),
    );
  });

  it("5. awaiting-feed scalp -> WAIT + Feed/Data states the limit, no fabricated levels", () => {
    const data = buildReasoningFromScalp({
      result: makeScalp({ status: "AWAITING_DATA", direction: "NONE" }),
    });
    expect(data.decision).toBe("WAIT — awaiting live data");
    render(<RubyReasoningBlock data={data} testid="rb" />);
    expect(screen.getByTestId("rb-decision").textContent).toContain("WAIT");
    expect(screen.getByTestId("rb-evidence-feedData").textContent?.toLowerCase()).toContain(
      "awaiting live feed",
    );
    // Honesty: no entry/stop/target numbers fabricated while withheld.
    expect(screen.getByTestId("rb-evidence-supportResistance").textContent).toContain(
      "withheld until live candles confirm",
    );
    expect(screen.getByTestId("rb-evidence-supportResistance").textContent).not.toMatch(/\d/);
  });

  it("6. an already-extended move -> TOO LATE", () => {
    const data = buildReasoningFromScalp({
      result: makeScalp({
        status: "READY",
        direction: "BUY",
        chaseWarning: "Move already extended ~3x ATR.",
        flame: { blind: false, scalpScore: 70, setupType: "FLAG" },
      }),
    });
    render(<RubyReasoningBlock data={data} testid="rb" />);
    expect(screen.getByTestId("rb-decision").textContent).toContain("TOO LATE");
  });

  it("7. a blind / low-visibility scalp -> Conditional + the limit in Feed/Data", () => {
    const data = buildReasoningFromScalp({
      result: makeScalp({
        status: "READY",
        direction: "BUY",
        canBuildTrade: false,
        flame: { blind: true, scalpScore: 0, setupType: "NONE" },
      }),
    });
    render(<RubyReasoningBlock data={data} testid="rb" />);
    expect(screen.getByTestId("rb-decision").textContent).toContain("Conditional BUY");
    expect(screen.getByTestId("rb-evidence-feedData").textContent).toContain(
      "limited candle visibility",
    );
  });

  it("8. a real plan surfaces levels and the support/resistance watch-out", () => {
    const data = buildReasoningFromScalp({
      result: makeScalp({
        status: "READY",
        direction: "BUY",
        canBuildTrade: true,
        entryZone: { from: 1.0825, to: 1.083 },
        stopLoss: 1.081,
        takeProfit: { main: 1.0865 },
        flame: { blind: false, scalpScore: 72, setupType: "FLAG" },
      }),
      patternLabel: "Bull flag",
    });
    render(<RubyReasoningBlock data={data} testid="rb" />);
    const sr = screen.getByTestId("rb-evidence-supportResistance").textContent ?? "";
    expect(sr.toLowerCase()).toContain("support/resistance");
    expect(sr).toContain("1.0825");
  });

  it("9. a blocking safety-gate FAIL -> NO TRADE + the gate named in Risk Note", () => {
    const data = buildReasoningFromSelfTrade({
      outcome: "APPROVED",
      side: "BUY",
      reason: "Setup looked clean",
      setup: "trend-pullback",
      confidence: 80,
      checks: [
        {
          label: "Stop-loss required",
          key: "MISSING_STOP_LOSS",
          status: "FAIL",
          blocking: true,
          detail: "No stop-loss on the proposed order",
        },
      ],
    });
    expect(data.decision).toBe("NO TRADE");
    render(<RubyReasoningBlock data={data} testid="st" />);
    expect(screen.getByTestId("st-decision").textContent).toContain("NO TRADE");
    expect(screen.getByTestId("st-risk-note").textContent).toContain("Stop-loss required");
  });

  it("10. a missing news provider -> the NEWS_UNAVAILABLE_NOTE in Risk", () => {
    const data = buildReasoningFromSelfTrade({
      outcome: "WAIT",
      side: null,
      reason: "No clean setup yet",
      thesis: null,
    });
    expect(data.decision).toContain("WAIT");
    render(<RubyReasoningBlock data={data} testid="st" />);
    const risk = within(screen.getByTestId("st")).getByTestId("st-evidence-risk");
    expect(risk.textContent).toContain(NEWS_UNAVAILABLE_NOTE);
  });
});
