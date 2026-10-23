// Task #600 — Scanner-truth regression suite (pure-contract assertions).
//
// The Scanner page used to show mutually-contradictory states at once (header
// "Live / Ruby: Full read" while the Ruby panel said "Feed not confirmed";
// "Ready now" cards whose own copy said "wait for confirmation"; etc.). The fix
// makes every surface derive from ONE resolved truth. This suite locks the pure
// derivation so the contradictions cannot return.
//
// It exercises the REAL contract functions (no mocks, no fake-pass):
//   • resolveCappedRubyReadStatus  — header Ruby cell vs Ruby Chart Read panel
//   • resolveScannerTruth          — header (consolidated) vs chart (displayStatus)
//   • resolveScannerActionability  — one verdict drives badge + copy + buttons
//
// The render-level assertions of the 10 required (no-scan empty state #4,
// 16-of-23 skipped #5, trade-health split #6/#7, scores-not-placeholders #8)
// live next to the surfaces they prove:
//   • #4 → src/pages/market-scanner.empty-state.test.tsx
//   • #5, #8 → src/components/scanner/BroadScanOpportunityMap.test.tsx
//   • #6, #7 → src/components/live/TradeHealthPanel.test.tsx

import { describe, it, expect } from "vitest";
import type { ChartFeedStatus } from "@workspace/api-client-react";
import {
  resolveScannerTruth,
  type ScannerTruthInputs,
  type ScannerTruthMode,
} from "./scannerTruth";
import {
  resolveScannerActionability,
  resolveSelectedSymbolActionability,
  resolveSelectedSymbolActionabilityDisplay,
  resolveDataActionabilityCap,
  SCANNER_ACTIONABILITY_UI,
  ACTIONABILITY_PENDING_UI,
  ACTIONABILITY_NO_CONFIRMATION_UI,
  ACTIONABILITY_CHECK_FAILED_UI,
  PENDING_RESOLVE_TIMEOUT_MS,
  actionabilityDisplayUi,
  resolveVisibleActionLabel,
  resolveVisibleActionButtonLabel,
  biasToActionDirection,
  type ActionabilityDataInput,
  type ScannerActionability,
  type PublicCandleStatus,
  type RubyReadStatus,
} from "./scannerActionability";
import { scalpStatusToSetup } from "../components/scanner/scalpLabels";
import {
  resolveCappedRubyReadStatus,
  type RubyReadServerState,
} from "./rubyReadPanelState";

const NOW = Date.parse("2026-06-08T12:00:00.000Z");

function feed(over: Partial<ChartFeedStatus> = {}): ChartFeedStatus {
  return {
    symbol: "EURUSD",
    displaySymbol: "EUR/USD",
    assetClass: "forex",
    source: "twelvedata",
    isLive: true,
    lastTickTime: new Date(NOW).toISOString(),
    lastCandleTime: new Date(NOW).toISOString(),
    latencyMs: 100,
    missing: 0,
    duplicate: 0,
    outOfOrder: 0,
    invalidOhlc: 0,
    stale: false,
    quality: "clean",
    warning: null,
    aiUsable: true,
    feedReadinessState: "ready",
    message: "ok",
    ...over,
  } as ChartFeedStatus;
}

function mode(over: Partial<ScannerTruthMode> = {}): ScannerTruthMode {
  return {
    isLoading: false,
    isDemo: true,
    isLiveShared: false,
    isPaper: false,
    isLiveArmed: false,
    isFrozen: false,
    canManualTrade: true,
    canAutoTrade: false,
    isSharedMasterAssigned: false,
    ownBridgeConnected: false,
    approvalStatus: null,
    frozenReason: null,
    cleanBlockedReason: null,
    ...over,
  };
}

function inputs(over: Partial<ScannerTruthInputs> = {}): ScannerTruthInputs {
  return {
    symbolDisplay: "EURUSD",
    symbolInternal: "EURUSD",
    timeframe: "1m",
    feedStatus: feed(),
    candleCount: 200,
    requestedCount: 200,
    firstTime: new Date(NOW - 200 * 60_000).toISOString(),
    lastTime: new Date(NOW - 10_000).toISOString(),
    lastClose: 1.15059,
    quote: null,
    headerOk: null,
    mode: mode(),
    nowMs: NOW,
    ...over,
  };
}

// Live-clean candle/feed input for the action verdict (cap returns null).
const CLEAN_DATA: ActionabilityDataInput = {
  quoteStatus: "LIVE",
  candleStatus: "CONFIRMED",
  chartIntelligenceStatus: "FULL",
};

// ── (1) Header Ruby cell and Ruby Chart Read panel cannot disagree ───────────
describe("(1) header Ruby cell and Ruby Chart Read panel cannot disagree", () => {
  const RANK: Record<RubyReadStatus, number> = {
    NO_READ: 0,
    LIMITED_READ: 1,
    FULL_READ: 2,
  };
  const bases: RubyReadStatus[] = ["NO_READ", "LIMITED_READ", "FULL_READ"];
  const reads: Array<{ name: string; read: RubyReadServerState | null }> = [
    { name: "no read yet", read: null },
    { name: "clean read", read: { dataQuality: "ok" } },
    { name: "gated read", read: { gated: true, blockedReason: "Feed not confirmed" } },
    {
      name: "insufficient read",
      read: { dataQuality: "insufficient", headline: "Chart data is syncing" },
    },
  ];
  const overrides: Array<boolean | undefined> = [undefined, true, false];

  it("is monotonic downgrade-only across every (base, read, override)", () => {
    for (const base of bases) {
      for (const { read } of reads) {
        for (const override of overrides) {
          const capped = resolveCappedRubyReadStatus(base, read, override);
          expect(
            RANK[capped.status],
            `${base}/${JSON.stringify(read)}/${override} upgraded`,
          ).toBeLessThanOrEqual(RANK[base]);
        }
      }
    }
  });

  it("never claims FULL_READ once the feed isn't confirmed (gated/insufficient/override-false)", () => {
    // This is the exact reported contradiction: header "Ruby: Full read" while
    // the panel says "Feed not confirmed". With a FULL base, any not-confirmed
    // signal must cap to LIMITED_READ and surface a reason.
    for (const { read } of reads.filter((r) => r.read && r.name !== "clean read")) {
      const capped = resolveCappedRubyReadStatus("FULL_READ", read, undefined);
      expect(capped.status).toBe("LIMITED_READ");
      expect(capped.reason).toBeTruthy();
    }
    const overridden = resolveCappedRubyReadStatus("FULL_READ", null, false);
    expect(overridden.status).toBe("LIMITED_READ");
    expect(overridden.reason).toBeTruthy();
  });

  it("keeps FULL_READ only when the read is clean AND the override doesn't block", () => {
    expect(resolveCappedRubyReadStatus("FULL_READ", null, undefined).status).toBe("FULL_READ");
    expect(resolveCappedRubyReadStatus("FULL_READ", { dataQuality: "ok" }, true).status).toBe(
      "FULL_READ",
    );
  });

  it("NO_READ stays NO_READ regardless of read/override (no upgrade path)", () => {
    for (const { read } of reads) {
      for (const override of overrides) {
        expect(resolveCappedRubyReadStatus("NO_READ", read, override)).toEqual({
          status: "NO_READ",
          reason: null,
        });
      }
    }
  });

  it("header and panel call with identical args ⇒ identical verdict (one truth)", () => {
    // Both surfaces call the SAME pure cap with the SAME lifted (base, read,
    // override). Determinism is what makes them unable to disagree.
    const base: RubyReadStatus = "FULL_READ";
    const read: RubyReadServerState = { gated: true, blockedReason: "Feed not confirmed" };
    const headerCell = resolveCappedRubyReadStatus(base, read, undefined);
    const panel = resolveCappedRubyReadStatus(base, read, undefined);
    expect(headerCell).toEqual(panel);
  });
});

// ── (2) Header (consolidated) and chart (displayStatus) candle status agree ──
describe("(2) header and chart candle status cannot disagree", () => {
  type Case = {
    name: string;
    over: Partial<ScannerTruthInputs>;
    candleStatus: PublicCandleStatus;
    displayStatus: string;
    isLivePrice: boolean;
  };
  const cases: Case[] = [
    {
      name: "live-clean",
      over: {},
      candleStatus: "CONFIRMED",
      displayStatus: "LIVE",
      isLivePrice: true,
    },
    {
      name: "insufficient candles",
      over: { candleCount: 40 },
      candleStatus: "LIMITED_HISTORY",
      displayStatus: "ANALYSIS_ONLY",
      isLivePrice: false,
    },
    {
      name: "delayed feed",
      over: { feedStatus: feed({ quality: "delayed", isLive: false, aiUsable: false }) },
      candleStatus: "SYNCING",
      displayStatus: "FALLBACK_COMPOSITE",
      isLivePrice: false,
    },
    {
      name: "stale feed",
      over: { feedStatus: feed({ quality: "stale", stale: true, isLive: false, aiUsable: false }) },
      candleStatus: "STALE",
      displayStatus: "STALE",
      isLivePrice: false,
    },
    {
      name: "no candles",
      over: {
        candleCount: 0,
        lastClose: null,
        lastTime: null,
        feedStatus: feed({ quality: "empty", isLive: false, aiUsable: false }),
      },
      candleStatus: "UNAVAILABLE",
      displayStatus: "UNAVAILABLE",
      isLivePrice: false,
    },
  ];

  for (const c of cases) {
    it(`${c.name}: consolidated candleStatus, chart displayStatus and isLivePrice stay in lockstep`, () => {
      const t = resolveScannerTruth(inputs(c.over));
      expect(t.consolidated.candleStatus).toBe(c.candleStatus);
      expect(t.displayStatus).toBe(c.displayStatus);
      expect(t.isLivePrice).toBe(c.isLivePrice);
      // The invariant that makes "Live confirmed candles" impossible to claim
      // when the chart isn't live: CONFIRMED ⇔ chart LIVE ⇔ isLivePrice.
      expect(t.consolidated.candleStatus === "CONFIRMED").toBe(t.displayStatus === "LIVE");
      expect(t.consolidated.candleStatus === "CONFIRMED").toBe(t.isLivePrice);
    });
  }

  it("an unconfirmed feed forbids a FULL Ruby read in the same truth (header dependency rule)", () => {
    const t = resolveScannerTruth(
      inputs({ feedStatus: feed({ quality: "stale", stale: true, isLive: false, aiUsable: false }) }),
    );
    expect(t.consolidated.candleStatus).not.toBe("CONFIRMED");
    expect(t.consolidated.rubyReadStatus).not.toBe("FULL_READ");
  });
});

// ── (3) A "Ready now" card cannot contain wait-for-confirmation text ─────────
describe("(3) a Ready-now verdict cannot carry wait-for-confirmation copy", () => {
  it("READY_NOW invites action and never carries a wait/not-yet instruction", () => {
    const ready = SCANNER_ACTIONABILITY_UI.READY_NOW;
    expect(ready.canAct).toBe(true);
    // It says act now ("confirmed" here is the positive "data is confirmed",
    // which is fine) — but it must never tell the user to wait / hold off.
    expect(ready.copy).toMatch(/act now/i);
    expect(ready.copy).not.toMatch(/\bwait\b|needs to confirm|still needs|not .*entry/i);
    for (const [verdict, ui] of Object.entries(SCANNER_ACTIONABILITY_UI)) {
      if (verdict === "READY_NOW") continue;
      expect(ui.canAct, `${verdict} must not enable trade buttons`).toBe(false);
    }
  });

  it("READY_NOW requires BOTH clean data AND a READY setup", () => {
    expect(resolveScannerActionability(CLEAN_DATA, "READY")).toBe("READY_NOW");
    // Clean data but no asserted setup ⇒ wait (not ready).
    expect(resolveScannerActionability(CLEAN_DATA, "UNKNOWN")).toBe("WAIT_FOR_CONFIRMATION");
    expect(resolveScannerActionability(CLEAN_DATA, "WAIT")).toBe("WAIT_FOR_CONFIRMATION");
  });

  it("the data cap dominates: a READY setup on unconfirmed data is never READY_NOW", () => {
    const syncing: ActionabilityDataInput = { ...CLEAN_DATA, candleStatus: "SYNCING" };
    expect(resolveDataActionabilityCap(syncing)).toBe("FEED_LIMITED");
    expect(resolveScannerActionability(syncing, "READY")).toBe("FEED_LIMITED");
    expect(SCANNER_ACTIONABILITY_UI.FEED_LIMITED.canAct).toBe(false);
  });

  it("one verdict drives badge + copy + button, so they can never contradict", () => {
    // Whichever verdict a card holds, its label/copy/canAct come from the SAME
    // map entry — a "Ready now" badge with "wait" copy is unrepresentable. The
    // structural lock: exactly ONE verdict may act, and only its copy says so.
    const verdicts: ScannerActionability[] = [
      "READY_NOW",
      "WAIT_FOR_CONFIRMATION",
      "TOO_LATE",
      "NO_CLEAN_SETUP",
      "MARKET_CLOSED",
      "FEED_LIMITED",
      "ANALYSIS_ONLY",
    ];
    const actionable = verdicts.filter((v) => SCANNER_ACTIONABILITY_UI[v].canAct);
    expect(actionable).toEqual(["READY_NOW"]);
    expect(SCANNER_ACTIONABILITY_UI.READY_NOW.copy).toMatch(/\bact now\b/i);
    for (const v of verdicts) {
      if (v === "READY_NOW") continue;
      expect(SCANNER_ACTIONABILITY_UI[v].copy, `${v} must not invite action`).not.toMatch(
        /\bact now\b/i,
      );
    }
  });
});

// ── (9) Changing symbol updates every surface together ───────────────────────
describe("(9) changing symbol updates header/chart/Ruby/actionability together", () => {
  it("a single input switch moves selectedSymbol AND all derived surfaces", () => {
    const a = resolveScannerTruth(inputs());
    const b = resolveScannerTruth(
      inputs({
        symbolDisplay: "GBPUSD",
        symbolInternal: "GBPUSD",
        feedStatus: feed({ symbol: "GBPUSD", displaySymbol: "GBP/USD", quality: "stale", stale: true, isLive: false, aiUsable: false }),
      }),
    );

    // Symbol identity moves on every surface that names it.
    expect(a.consolidated.selectedSymbol).toBe("EURUSD");
    expect(b.consolidated.selectedSymbol).toBe("GBPUSD");
    expect(b.symbolDisplay).toBe("GBPUSD");
    expect(b.symbolInternal).toBe("GBPUSD");

    // And the dependent verdicts move WITH it (A live, B stale) — no surface is
    // left showing the previous symbol's state.
    expect(a.consolidated.candleStatus).toBe("CONFIRMED");
    expect(a.displayStatus).toBe("LIVE");
    expect(a.isLivePrice).toBe(true);

    expect(b.consolidated.candleStatus).toBe("STALE");
    expect(b.displayStatus).toBe("STALE");
    expect(b.isLivePrice).toBe(false);
    expect(b.consolidated.rubyReadStatus).not.toBe("FULL_READ");
    expect(b.consolidated.scannerActionability).toBe("FEED_LIMITED");
  });
});

// ── (10) Changing timeframe updates every surface together ───────────────────
describe("(10) changing timeframe updates header/chart/Ruby/actionability together", () => {
  it("the same candle count flips state when only the timeframe changes", () => {
    // 60 candles is below the 1m minimum (150) but above the 1d minimum (50),
    // so switching ONLY the timeframe must flip every surface in lockstep.
    const m1 = resolveScannerTruth(inputs({ timeframe: "1m", candleCount: 60 }));
    const d1 = resolveScannerTruth(inputs({ timeframe: "1d", candleCount: 60 }));

    expect(m1.consolidated.selectedTimeframe).toBe("1m");
    expect(d1.consolidated.selectedTimeframe).toBe("1d");

    // 1m: too few candles → limited history across every surface.
    expect(m1.consolidated.candleStatus).toBe("LIMITED_HISTORY");
    expect(m1.displayStatus).toBe("ANALYSIS_ONLY");
    expect(m1.isLivePrice).toBe(false);
    expect(m1.consolidated.scannerActionability).toBe("FEED_LIMITED");

    // 1d: same count is sufficient → confirmed/live across every surface.
    expect(d1.consolidated.candleStatus).toBe("CONFIRMED");
    expect(d1.displayStatus).toBe("LIVE");
    expect(d1.isLivePrice).toBe(true);
    expect(d1.consolidated.rubyReadStatus).toBe("FULL_READ");
  });
});

// ── (11) Header Action cell shows the selected card's setup-aware verdict ─────
//
// The original screenshot bug: a Focus scalp card reads "Ready now" while the
// header strip's Action cell — deriving its OWN data-only verdict off the same
// query — reads "Wait for confirmation". Task #600 fixes this by having the card
// LIFT its setup-aware verdict to a page store the header consumes, with ONE
// precedence rule (`resolveSelectedSymbolActionability`) living in the pure
// contract. This block locks that precedence: lifted-over-data-only, an honest
// fallback when no card has published, and the feed-limited cap still dominating
// even a READY scalp so the alignment never comes at the cost of honesty.
describe("(11) header Action cell == selected card's verdict (lifted, never data-only)", () => {
  it("surfaces the card's READY_NOW over the header's conservative data-only WAIT", () => {
    // The Focus scalp card knows the SCALP-ENGINE status (setup-aware). On
    // confirmed-live data with a READY scalp the card's verdict is READY_NOW; the
    // header's own data-only verdict (setup = UNKNOWN) is the more conservative
    // WAIT_FOR_CONFIRMATION. The header must show the card's verdict so the two
    // surfaces can never disagree — the exact contradiction this suite exists for.
    const cardVerdict = resolveScannerActionability(CLEAN_DATA, scalpStatusToSetup("READY"));
    const dataOnly = resolveScannerActionability(CLEAN_DATA, "UNKNOWN");
    expect(cardVerdict).toBe("READY_NOW");
    expect(dataOnly).toBe("WAIT_FOR_CONFIRMATION");
    // The header consumes lifted-over-data-only.
    expect(resolveSelectedSymbolActionability(cardVerdict, dataOnly)).toBe("READY_NOW");
  });

  it("falls back to the data-only verdict when no card has published one", () => {
    const dataOnly = resolveScannerActionability(CLEAN_DATA, "UNKNOWN");
    expect(resolveSelectedSymbolActionability(null, dataOnly)).toBe(dataOnly);
    // With neither a lifted card verdict nor a resolved data verdict, there is no
    // verdict to show — never a fabricated default.
    expect(resolveSelectedSymbolActionability(null, null)).toBeNull();
  });

  it("a feed-limited data cap dominates even a READY scalp setup (honesty floor)", () => {
    // A syncing/unconfirmed feed caps the verdict to FEED_LIMITED no matter how
    // ready the scalp setup looks, so lifting the card's verdict can never offer a
    // live action on an unconfirmed feed.
    const syncing: ActionabilityDataInput = { ...CLEAN_DATA, candleStatus: "SYNCING" };
    const cardVerdict = resolveScannerActionability(syncing, scalpStatusToSetup("READY"));
    expect(cardVerdict).toBe("FEED_LIMITED");
    // …and the header (lifting that already-capped verdict) stays FEED_LIMITED.
    expect(
      resolveSelectedSymbolActionability(
        cardVerdict,
        resolveScannerActionability(syncing, "UNKNOWN"),
      ),
    ).toBe("FEED_LIMITED");
  });
});

// ── (12) Resolved-verdict mirroring — the header mirrors the chart's verdict ──
//
// The desync bug this locks: the truth source is keyed by symbol+timeframe
// (null mid-switch, never stale), so a PRESENT data-only verdict is always a
// RESOLVED scanner verdict for the current key — the same resolved state the
// chart's own badge displays. The display layer previously classified the
// data-only WAIT_FOR_CONFIRMATION as un-resolved and sat on "Checking…" (then
// aged into "No confirmation") while the chart showed its resolved WAIT state.
// The contract now: ANY resolved verdict (lifted OR data-only) renders as-is
// IMMEDIATELY; PENDING is reserved for the genuinely-unresolved gap (no
// verdict of any kind).
// DISPLAY-ONLY: resolveScannerActionability / resolveSelectedSymbolActionability
// are untouched (locked above); PENDING is not a ScannerActionability member.
describe("(12) resolved-verdict mirroring — a resolved data-only verdict renders immediately", () => {
  it("no lifted verdict + resolved data-only WAIT ⇒ WAIT_FOR_CONFIRMATION (mirrors the chart), never PENDING", () => {
    const dataOnly = resolveScannerActionability(CLEAN_DATA, "UNKNOWN");
    expect(dataOnly).toBe("WAIT_FOR_CONFIRMATION"); // the fallthrough (unchanged)
    expect(resolveSelectedSymbolActionabilityDisplay(null, dataOnly)).toBe(
      "WAIT_FOR_CONFIRMATION",
    );
  });

  it("PENDING shows ONLY when no verdict exists at all (truth not yet resolved for the key)", () => {
    expect(resolveSelectedSymbolActionabilityDisplay(null, null)).toBe("PENDING");
  });

  it("the pending state is neutral and non-actionable: 'Checking…', muted, canAct false", () => {
    expect(actionabilityDisplayUi("PENDING")).toBe(ACTIONABILITY_PENDING_UI);
    expect(ACTIONABILITY_PENDING_UI.label).toBe("Checking…");
    expect(ACTIONABILITY_PENDING_UI.tone).toBe("muted");
    expect(ACTIONABILITY_PENDING_UI.canAct).toBe(false);
    // No directional/setup language — honest-neutral only.
    expect(ACTIONABILITY_PENDING_UI.copy).not.toMatch(
      /\b(buy|sell|long|short|setup|confirm|ready|act now)\b/i,
    );
  });

  it("a PUBLISHED (lifted) WAIT_FOR_CONFIRMATION is a real engine verdict and renders as-is", () => {
    const lifted = resolveScannerActionability(CLEAN_DATA, "WAIT");
    expect(lifted).toBe("WAIT_FOR_CONFIRMATION");
    expect(resolveSelectedSymbolActionabilityDisplay(lifted, null)).toBe(
      "WAIT_FOR_CONFIRMATION",
    );
    expect(actionabilityDisplayUi("WAIT_FOR_CONFIRMATION")).toBe(
      SCANNER_ACTIONABILITY_UI.WAIT_FOR_CONFIRMATION,
    );
  });

  it("EVERY resolved data-only verdict renders as-is with no lifted verdict — none masked as pending", () => {
    const syncing: ActionabilityDataInput = { ...CLEAN_DATA, candleStatus: "SYNCING" };
    const closed: ActionabilityDataInput = { ...CLEAN_DATA, quoteStatus: "MARKET_CLOSED" };
    const limited: ActionabilityDataInput = { ...CLEAN_DATA, chartIntelligenceStatus: "LIMITED" };
    expect(
      resolveSelectedSymbolActionabilityDisplay(null, resolveScannerActionability(syncing, "UNKNOWN")),
    ).toBe("FEED_LIMITED");
    expect(
      resolveSelectedSymbolActionabilityDisplay(null, resolveScannerActionability(closed, "UNKNOWN")),
    ).toBe("MARKET_CLOSED");
    expect(
      resolveSelectedSymbolActionabilityDisplay(null, resolveScannerActionability(limited, "UNKNOWN")),
    ).toBe("ANALYSIS_ONLY");
  });

  it("a lifted setup-aware verdict wins exactly as before (precedence unchanged)", () => {
    const cardVerdict = resolveScannerActionability(CLEAN_DATA, scalpStatusToSetup("READY"));
    const dataOnly = resolveScannerActionability(CLEAN_DATA, "UNKNOWN");
    expect(resolveSelectedSymbolActionabilityDisplay(cardVerdict, dataOnly)).toBe("READY_NOW");
    // Lifted terminal verdicts pass through untouched too.
    const noSetup = resolveScannerActionability(CLEAN_DATA, scalpStatusToSetup("NO_CLEAN_SCALP"));
    expect(resolveSelectedSymbolActionabilityDisplay(noSetup, dataOnly)).toBe(noSetup);
  });
});

// ── (13) Bounded pending — PENDING is a finite transition, never a terminal ──
//
// PENDING now covers ONLY the genuinely-unresolved gap (no lifted verdict AND
// no data-only truth verdict for the current key — e.g. a truth read that
// never lands). The display resolver takes a `pendingExpired` flag (driven by
// the header's PENDING_RESOLVE_TIMEOUT_MS timer): once expired, that gap
// converts to the FINAL honest "No confirmation" state. Expiry NEVER
// overrides a resolved verdict — a resolved verdict always renders as-is —
// and a lifted CHECK_FAILED (errored read) resolves immediately.
// DISPLAY-ONLY: the underlying verdict/gate layers are untouched (locked above).
describe("(13) bounded pending — every market resolves to a FINAL state", () => {
  const dataOnlyUnknownWait = () => resolveScannerActionability(CLEAN_DATA, "UNKNOWN");

  it("expired pending converts the no-verdict gap to FINAL NO_CONFIRMATION", () => {
    expect(resolveSelectedSymbolActionabilityDisplay(null, null, false)).toBe("PENDING");
    expect(resolveSelectedSymbolActionabilityDisplay(null, null, true)).toBe("NO_CONFIRMATION");
  });

  it("expiry NEVER overrides a resolved data-only verdict — it renders as-is", () => {
    const dataOnly = dataOnlyUnknownWait();
    expect(resolveSelectedSymbolActionabilityDisplay(null, dataOnly, false)).toBe(
      "WAIT_FOR_CONFIRMATION",
    );
    expect(resolveSelectedSymbolActionabilityDisplay(null, dataOnly, true)).toBe(
      "WAIT_FOR_CONFIRMATION",
    );
  });

  it("the timeout constant is finite and sane (bounded, not effectively-infinite)", () => {
    expect(Number.isFinite(PENDING_RESOLVE_TIMEOUT_MS)).toBe(true);
    expect(PENDING_RESOLVE_TIMEOUT_MS).toBeGreaterThan(0);
    expect(PENDING_RESOLVE_TIMEOUT_MS).toBeLessThanOrEqual(30_000);
  });

  it("a lifted CHECK_FAILED resolves immediately — expired or not — and never leaks into gates", () => {
    expect(resolveSelectedSymbolActionabilityDisplay("CHECK_FAILED", dataOnlyUnknownWait(), false)).toBe("CHECK_FAILED");
    expect(resolveSelectedSymbolActionabilityDisplay("CHECK_FAILED", dataOnlyUnknownWait(), true)).toBe("CHECK_FAILED");
    expect(resolveSelectedSymbolActionabilityDisplay("CHECK_FAILED", null, false)).toBe("CHECK_FAILED");
    // Vocabulary isolation: CHECK_FAILED is NOT a ScannerActionability member —
    // the gate/verdict layer can never receive it.
    expect(Object.keys(SCANNER_ACTIONABILITY_UI)).not.toContain("CHECK_FAILED");
    expect(Object.keys(SCANNER_ACTIONABILITY_UI)).not.toContain("NO_CONFIRMATION");
    expect(Object.keys(SCANNER_ACTIONABILITY_UI)).not.toContain("PENDING");
  });

  it("real data caps are unaffected by expiry — they were already final states", () => {
    const syncing: ActionabilityDataInput = { ...CLEAN_DATA, candleStatus: "SYNCING" };
    const closed: ActionabilityDataInput = { ...CLEAN_DATA, quoteStatus: "MARKET_CLOSED" };
    expect(
      resolveSelectedSymbolActionabilityDisplay(null, resolveScannerActionability(syncing, "UNKNOWN"), true),
    ).toBe("FEED_LIMITED");
    expect(
      resolveSelectedSymbolActionabilityDisplay(null, resolveScannerActionability(closed, "UNKNOWN"), true),
    ).toBe("MARKET_CLOSED");
  });

  it("a lifted real verdict beats expiry — a late-arriving verdict always wins", () => {
    const cardVerdict = resolveScannerActionability(CLEAN_DATA, scalpStatusToSetup("READY"));
    expect(resolveSelectedSymbolActionabilityDisplay(cardVerdict, dataOnlyUnknownWait(), true)).toBe("READY_NOW");
    const liftedWait = resolveScannerActionability(CLEAN_DATA, "WAIT");
    expect(resolveSelectedSymbolActionabilityDisplay(liftedWait, dataOnlyUnknownWait(), true)).toBe(
      "WAIT_FOR_CONFIRMATION",
    );
  });

  it("the final display states are honest and non-actionable", () => {
    expect(actionabilityDisplayUi("NO_CONFIRMATION")).toBe(ACTIONABILITY_NO_CONFIRMATION_UI);
    expect(ACTIONABILITY_NO_CONFIRMATION_UI.label).toBe("No confirmation");
    expect(ACTIONABILITY_NO_CONFIRMATION_UI.canAct).toBe(false);
    // Honest reason: says nothing confirmed — no directional/actionable language.
    expect(ACTIONABILITY_NO_CONFIRMATION_UI.copy).not.toMatch(/\b(buy|sell|long|short|ready|act now)\b/i);

    expect(actionabilityDisplayUi("CHECK_FAILED")).toBe(ACTIONABILITY_CHECK_FAILED_UI);
    expect(ACTIONABILITY_CHECK_FAILED_UI.label).toBe("Check failed");
    expect(ACTIONABILITY_CHECK_FAILED_UI.canAct).toBe(false);
    expect(ACTIONABILITY_CHECK_FAILED_UI.copy).not.toMatch(/\b(buy|sell|long|short|ready|act now)\b/i);
  });

  it("the resolver is total — the no-verdict gap yields PENDING, then NO_CONFIRMATION on expiry, never null", () => {
    expect(resolveSelectedSymbolActionabilityDisplay(null, null)).toBe("PENDING");
    expect(resolveSelectedSymbolActionabilityDisplay(null, null, true)).toBe("NO_CONFIRMATION");
  });
});

// ── (14) The visible ACTION label reveals the directional decision ───────────
//
// The header/action badge used to render the raw verdict label, so a directional
// "Conditional BUY" decision on WAIT_FOR_CONFIRMATION showed only the generic
// "Wait for confirmation" — hiding the side. `resolveVisibleActionLabel` folds
// the ONE canonical directional read into ONLY the two clean-data verdicts
// (WAIT_FOR_CONFIRMATION → "Conditional Buy/Sell", READY_NOW → "Buy/Sell now").
// A true no-direction wait, and every degraded / no-setup / display-only state,
// keeps its neutral base label so no direction can leak onto an unconfirmed feed.
describe("(14) the visible action label reveals the directional decision", () => {
  const BUY_SELL = /\b(buy|sell)\b/i;

  it("a Conditional BUY (WAIT + bullish) reads 'Conditional Buy', not a bare wait", () => {
    expect(resolveVisibleActionLabel("WAIT_FOR_CONFIRMATION", biasToActionDirection("BULLISH"))).toBe(
      "Conditional Buy",
    );
    // The generic wait wording no longer hides the side.
    expect(resolveVisibleActionLabel("WAIT_FOR_CONFIRMATION", "BUY")).not.toBe(
      SCANNER_ACTIONABILITY_UI.WAIT_FOR_CONFIRMATION.label,
    );
  });

  it("a Conditional SELL (WAIT + bearish) reads 'Conditional Sell'", () => {
    expect(resolveVisibleActionLabel("WAIT_FOR_CONFIRMATION", biasToActionDirection("BEARISH"))).toBe(
      "Conditional Sell",
    );
  });

  it("a true WAIT with no clear direction stays the neutral base label", () => {
    for (const bias of ["NEUTRAL", "CONFLICT", "UNKNOWN", null, undefined]) {
      const label = resolveVisibleActionLabel("WAIT_FOR_CONFIRMATION", biasToActionDirection(bias));
      expect(label).toBe(SCANNER_ACTIONABILITY_UI.WAIT_FOR_CONFIRMATION.label);
      expect(label).not.toMatch(BUY_SELL);
    }
  });

  it("no direction leaks onto a degraded / no-setup verdict even with a bullish read", () => {
    const dir = biasToActionDirection("BULLISH");
    for (const v of [
      "NO_CLEAN_SETUP",
      "TOO_LATE",
      "MARKET_CLOSED",
      "FEED_LIMITED",
      "ANALYSIS_ONLY",
      "PENDING",
      "NO_CONFIRMATION",
      "CHECK_FAILED",
    ] as const) {
      const label = resolveVisibleActionLabel(v, dir);
      expect(label).toBe(actionabilityDisplayUi(v).label);
      expect(label).not.toMatch(BUY_SELL);
    }
  });

  it("precedence: an explicit direction beats the generic wait — READY_NOW folds a side too", () => {
    // A directional decision must win over the generic wording on both directional verdicts.
    expect(resolveVisibleActionLabel("WAIT_FOR_CONFIRMATION", "SELL")).toBe("Conditional Sell");
    expect(resolveVisibleActionLabel("READY_NOW", biasToActionDirection("BULLISH"))).toBe("Buy now");
    expect(resolveVisibleActionLabel("READY_NOW", biasToActionDirection("BEARISH"))).toBe("Sell now");
    // But a READY_NOW with no direction still reads the neutral base label.
    expect(resolveVisibleActionLabel("READY_NOW", null)).toBe(SCANNER_ACTIONABILITY_UI.READY_NOW.label);
  });

  it("one shared formatter — the same (verdict, direction) yields identical text on every surface", () => {
    // The header derives direction from `verdict.bias`; a card/row would pass a
    // raw "BUY"/"SELL". Both routes flow through the SAME pure formatter, so they
    // can never drift for the same decision.
    const headerRoute = resolveVisibleActionLabel("WAIT_FOR_CONFIRMATION", biasToActionDirection("BULLISH"));
    const cardRoute = resolveVisibleActionLabel("WAIT_FOR_CONFIRMATION", biasToActionDirection("BUY"));
    expect(headerRoute).toBe(cardRoute);
    expect(headerRoute).toBe("Conditional Buy");
    // Determinism: repeated calls are stable.
    expect(resolveVisibleActionLabel("READY_NOW", "SELL")).toBe(resolveVisibleActionLabel("READY_NOW", "SELL"));
  });

  // ── (15) consolidated.readId and readTimestamp ─────────────────────────────
  describe("(15) consolidated truth carries a non-empty readId and readTimestamp", () => {
    it("readId is a non-empty string", () => {
      const result = resolveScannerTruth(inputs());
      expect(typeof result.consolidated.readId).toBe("string");
      expect(result.consolidated.readId.length).toBeGreaterThan(0);
    });

    it("readTimestamp is a positive integer in the recent past", () => {
      const before = Date.now();
      const result = resolveScannerTruth(inputs());
      const after = Date.now();
      expect(result.consolidated.readTimestamp).toBeGreaterThanOrEqual(before);
      expect(result.consolidated.readTimestamp).toBeLessThanOrEqual(after);
    });

    it("same inputs produce the SAME readId (deterministic per data cycle — all surfaces agree)", () => {
      // Both calls carry identical symbol+timeframe+candle-window, so every
      // surface (header, chart, Eleanor panel) sees the same readId for that cycle.
      const a = resolveScannerTruth(inputs());
      const b = resolveScannerTruth(inputs());
      expect(a.consolidated.readId).toBe(b.consolidated.readId);
    });

    it("a different lastTime produces a different readId (new candle = new cycle)", () => {
      const base = resolveScannerTruth(inputs());
      const next = resolveScannerTruth(
        inputs({ lastTime: new Date(NOW + 60_000).toISOString() }),
      );
      expect(base.consolidated.readId).not.toBe(next.consolidated.readId);
    });
  });

  // ── (16) resolveVisibleActionButtonLabel — directional CTA copy ───────────
  describe("(16) resolveVisibleActionButtonLabel — CTA button label convergence", () => {
    it("WAIT_FOR_CONFIRMATION + BUY → 'Prepare Conditional Buy'", () => {
      expect(resolveVisibleActionButtonLabel("WAIT_FOR_CONFIRMATION", "BUY")).toBe("Prepare Conditional Buy");
    });

    it("WAIT_FOR_CONFIRMATION + SELL → 'Prepare Conditional Sell'", () => {
      expect(resolveVisibleActionButtonLabel("WAIT_FOR_CONFIRMATION", "SELL")).toBe("Prepare Conditional Sell");
    });

    it("READY_NOW + BUY → 'Prepare Buy'", () => {
      expect(resolveVisibleActionButtonLabel("READY_NOW", "BUY")).toBe("Prepare Buy");
    });

    it("READY_NOW + SELL → 'Prepare Sell'", () => {
      expect(resolveVisibleActionButtonLabel("READY_NOW", "SELL")).toBe("Prepare Sell");
    });

    it("FEED_LIMITED + any direction → 'Prepare Trade' (no direction leak on degraded state)", () => {
      expect(resolveVisibleActionButtonLabel("FEED_LIMITED", "BUY")).toBe("Prepare Trade");
      expect(resolveVisibleActionButtonLabel("FEED_LIMITED", "SELL")).toBe("Prepare Trade");
    });

    it("NO_CLEAN_SETUP + BUY → 'Prepare Trade'", () => {
      expect(resolveVisibleActionButtonLabel("NO_CLEAN_SETUP", "BUY")).toBe("Prepare Trade");
    });

    it("null direction → 'Prepare Trade' even for otherwise-actionable verdicts", () => {
      expect(resolveVisibleActionButtonLabel("WAIT_FOR_CONFIRMATION", null)).toBe("Prepare Trade");
      expect(resolveVisibleActionButtonLabel("READY_NOW", null)).toBe("Prepare Trade");
    });

    it("PENDING → 'Prepare Trade' (safe disabled default)", () => {
      expect(resolveVisibleActionButtonLabel("PENDING", null)).toBe("Prepare Trade");
      expect(resolveVisibleActionButtonLabel("PENDING", "BUY")).toBe("Prepare Trade");
    });

    it("NO_CONFIRMATION → 'Prepare Trade'", () => {
      expect(resolveVisibleActionButtonLabel("NO_CONFIRMATION", "BUY")).toBe("Prepare Trade");
    });

    it("CHECK_FAILED → 'Prepare Trade'", () => {
      expect(resolveVisibleActionButtonLabel("CHECK_FAILED", "SELL")).toBe("Prepare Trade");
    });

    it("button label and badge label are consistent in direction for WAIT_FOR_CONFIRMATION", () => {
      const badgeLabel = resolveVisibleActionLabel("WAIT_FOR_CONFIRMATION", "BUY");
      const buttonLabel = resolveVisibleActionButtonLabel("WAIT_FOR_CONFIRMATION", "BUY");
      // Both must agree on the trade direction (Buy appears in both).
      expect(badgeLabel).toContain("Buy");
      expect(buttonLabel).toContain("Buy");
      // Button has "Prepare" prefix, badge does not.
      expect(buttonLabel.startsWith("Prepare")).toBe(true);
      expect(badgeLabel.startsWith("Prepare")).toBe(false);
    });
  });
});
