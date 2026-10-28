import { describe, it, expect, afterEach, vi, beforeEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import type { ScannerTruth } from "@/lib/scannerTruth";
import {
  resolveRubyReadPanelState,
  resolveCappedRubyReadStatus,
  withRouteReadLayer,
  chartReadExpiresAtMs,
  type RubyReadServerState,
} from "@/lib/rubyReadPanelState";
import type { RubyReadStatus } from "@/lib/scannerActionability";

// Frontend guard for the Scanner "Ruby Chart Read" panel honesty (Task #391 +
// Task #506). The panel composes three sub-surfaces — a source BADGE, a
// feed-not-confirmed BANNER, and the read BODY — that historically each read a
// DIFFERENT verdict off the same query and so could render mutually
// contradictory claims at once (the screenshot bug: badge "Clean · AI" + banner
// "not confirmed" + body "cannot verify"). Task #506 routes all three through
// ONE resolved verdict (`resolveRubyReadPanelState`).
//
// This pins:
//   1. The original feed-not-confirmed warning gating (render proofs).
//   2. The single-verdict resolver: badge / banner derive from one state, the
//      banner reason describes the same dimension as the downgrade, and the
//      screenshot contradiction is structurally unrepresentable.
//
// The shared hook is mocked so the render tests are a pure render proof. The
// presentational FeedConfidenceBadge (which pulls in UI primitives + the api
// client) is stubbed to keep the test hermetic.

const mockUseScannerTruth = vi.fn();

vi.mock("@/hooks/useScannerTruth", () => ({
  useScannerTruth: (...args: unknown[]) => mockUseScannerTruth(...args),
}));

// The presentational FeedConfidenceBadge is stubbed to keep the test hermetic
// (no Radix popover / api client), but the stub is FAITHFUL to the badge's one
// trust contract: it consumes the resolved `aiUsableResolved` verdict and only
// renders the affirmative live/verified trust tokens when that verdict is `true`
// (mirroring the real chip's Clean/AI "Confirmed" affordance). This lets the
// regression block below pin, at the rendered surface, that the chip is never
// fed — and so can never render — a live/verified trust label on a degraded feed.
let mockFeedBadgeProps: { aiUsableResolved?: boolean | null } = {};
vi.mock("@/components/charts/FeedConfidenceBadge", () => ({
  FeedConfidenceBadge: (props: { aiUsableResolved?: boolean | null }) => {
    mockFeedBadgeProps = props;
    const confirmed = props.aiUsableResolved === true;
    return (
      <span
        data-testid="feed-confidence-badge"
        data-ai-usable={String(props.aiUsableResolved)}
      >
        {confirmed
          ? "Live feed · Verified · AACI verified · Live-confirmed · Execution-ready"
          : props.aiUsableResolved === false
            ? "Feed quality not confirmed"
            : "Feed verdict pending"}
      </span>
    );
  },
}));

// The page-level read store is mocked so a test can inject a server read (e.g. a
// STRUCTURAL_ONLY read) without driving the async fetch. Default is `null` (no
// read), which is exactly the pre-read state the other render proofs expect.
let mockStoredRead: RubyReadServerState | null = null;
vi.mock("@/components/scanner/rubyReadStore", () => ({
  useRubyReadStore: () => ({
    get: () => mockStoredRead,
    set: (_s: string, _t: string, next: RubyReadServerState | null) => {
      mockStoredRead = next;
    },
  }),
}));

// Imported AFTER the mocks (vi.mock is hoisted) so the component binds the stubs.
import { RubyChartRead } from "./RubyChartRead";

// Minimal ScannerTruth — the component only reads analysis.level/analysis.reason.
// Cast a partial shape to keep the test focused on the gating contract.
function truthAt(
  level: ScannerTruth["analysis"]["level"],
  reason?: string,
): ScannerTruth {
  return {
    analysis: { level, reason: reason ?? `reason for ${level}` },
  } as unknown as ScannerTruth;
}

function hookState(over: { truth: ScannerTruth | null }) {
  return {
    truth: over.truth,
    feedStatus: null,
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
  };
}

beforeEach(() => {
  mockUseScannerTruth.mockReset();
  mockStoredRead = null;
  mockFeedBadgeProps = {};
});
afterEach(() => cleanup());

describe("RubyChartRead — feed-not-confirmed warning honesty", () => {
  it("renders the feed-warning when the shared truth is downgraded (not full)", () => {
    mockUseScannerTruth.mockReturnValue(hookState({ truth: truthAt("historical_only") }));
    render(<RubyChartRead symbol="EURUSD" timeframe="M5" draft={null} />);
    expect(screen.getByTestId("ruby-chart-read")).toBeTruthy();
    expect(screen.getByTestId("ruby-chart-read-feed-warning")).toBeTruthy();
  });

  it("stays quiet while the shared truth is unresolved/loading", () => {
    mockUseScannerTruth.mockReturnValue(hookState({ truth: null }));
    render(<RubyChartRead symbol="EURUSD" timeframe="M5" draft={null} />);
    // The card itself renders, but the warning is withheld until we actually
    // know the truth is bad — an unresolved verdict must never raise the alarm.
    expect(screen.getByTestId("ruby-chart-read")).toBeTruthy();
    expect(screen.queryByTestId("ruby-chart-read-feed-warning")).toBeNull();
  });

  it("stays quiet when the shared truth is fully actionable (level full)", () => {
    mockUseScannerTruth.mockReturnValue(hookState({ truth: truthAt("full") }));
    render(<RubyChartRead symbol="EURUSD" timeframe="M5" draft={null} />);
    expect(screen.queryByTestId("ruby-chart-read-feed-warning")).toBeNull();
  });

  it("shows the downgrade reason in the banner when truth is downgraded", () => {
    mockUseScannerTruth.mockReturnValue(
      hookState({ truth: truthAt("historical_only", "Latest candle is frozen.") }),
    );
    render(<RubyChartRead symbol="EURUSD" timeframe="M5" draft={null} />);
    const banner = screen.getByTestId("ruby-chart-read-feed-warning");
    expect(banner.textContent).toContain("Latest candle is frozen.");
  });
});

// ── Single-verdict resolver: contradiction-impossibility matrix (Task #506) ───
//
// Every sub-surface derives from resolveRubyReadPanelState. We enumerate the
// matrix of feed/truth/read states and assert no combination can produce the
// screenshot contradiction (badge clean+AI + banner not-confirmed + body
// cannot-verify), and that the banner reason can never be self-contradictory.

type Level = ScannerTruth["analysis"]["level"];
const LEVELS: (Level | null)[] = [null, "full", "limited", "historical_only", "blocked"];
const FULL_REASON = "Live data — valid for a live read.";
const DOWNGRADE_REASON = "Only 12 candles loaded — historical context only.";
const SERVER_BLOCK_REASON = "Chart intelligence unavailable — cannot verify chart data.";

const READ_STATES: (RubyReadServerState | null)[] = [
  null,
  { gated: false, dataQuality: "ok" },
  { gated: true, dataQuality: "insufficient", blockedReason: SERVER_BLOCK_REASON },
  { gated: false, dataQuality: "insufficient" },
];

const AI_PROPS: (boolean | undefined)[] = [undefined, true, false];

describe("resolveRubyReadPanelState — one verdict, no contradictions", () => {
  it("never lets the badge claim Clean/AI while the banner says not-confirmed", () => {
    for (const level of LEVELS) {
      for (const aiUsableProp of AI_PROPS) {
        for (const read of READ_STATES) {
          const state = resolveRubyReadPanelState({
            truthLevel: level,
            truthReason: level === "full" ? FULL_REASON : DOWNGRADE_REASON,
            aiUsableProp,
            read,
          });
          // The badge's "Clean/AI" affordance is gated on badgeAiUsable === true.
          // Whenever the banner shows (feedNotConfirmed), the badge MUST NOT be
          // allowed to claim Clean/AI.
          if (state.feedNotConfirmed) {
            expect(state.badgeAiUsable).not.toBe(true);
            expect(state.verdict).toBe("not_confirmed");
          }
          // And the inverse: a confirmed badge can never coexist with the banner.
          if (state.badgeAiUsable === true) {
            expect(state.feedNotConfirmed).toBe(false);
          }
        }
      }
    }
  });

  it("makes the screenshot combo (badge clean+AI + banner not-confirmed + body cannot-verify) unrepresentable", () => {
    // The body's "cannot verify" gated section renders only when read.gated.
    for (const level of LEVELS) {
      for (const aiUsableProp of AI_PROPS) {
        const gatedRead: RubyReadServerState = {
          gated: true,
          dataQuality: "insufficient",
          blockedReason: SERVER_BLOCK_REASON,
        };
        const state = resolveRubyReadPanelState({
          truthLevel: level,
          truthReason: level === "full" ? FULL_REASON : DOWNGRADE_REASON,
          aiUsableProp,
          read: gatedRead,
        });
        // A gated/cannot-verify body forces not-confirmed → badge can never be
        // clean+AI. The three-way contradiction is structurally impossible.
        expect(state.verdict).toBe("not_confirmed");
        expect(state.feedNotConfirmed).toBe(true);
        expect(state.badgeAiUsable).not.toBe(true);
      }
    }
  });

  it("never pairs a not-confirmed header with a positive 'valid for a live read' reason", () => {
    for (const level of LEVELS) {
      for (const aiUsableProp of AI_PROPS) {
        for (const read of READ_STATES) {
          const state = resolveRubyReadPanelState({
            truthLevel: level,
            truthReason: level === "full" ? FULL_REASON : DOWNGRADE_REASON,
            aiUsableProp,
            read,
          });
          if (state.feedNotConfirmed && state.reason) {
            // The banner reason describes the dimension that drove the downgrade,
            // so it can never be the full-level "valid for a live read" string.
            expect(state.reason).not.toContain("valid for a live read");
          }
        }
      }
    }
  });

  it("uses the truth reason when the truth itself is downgraded", () => {
    const state = resolveRubyReadPanelState({
      truthLevel: "historical_only",
      truthReason: DOWNGRADE_REASON,
      aiUsableProp: undefined,
      read: null,
    });
    expect(state.verdict).toBe("not_confirmed");
    expect(state.reason).toBe(DOWNGRADE_REASON);
  });

  it("uses the server reason when truth is full but the server couldn't verify", () => {
    // The W1-style case: truth resolves full, but the server gates the read.
    const state = resolveRubyReadPanelState({
      truthLevel: "full",
      truthReason: FULL_REASON,
      aiUsableProp: undefined,
      read: {
        gated: true,
        dataQuality: "insufficient",
        blockedReason: SERVER_BLOCK_REASON,
      },
    });
    expect(state.verdict).toBe("not_confirmed");
    expect(state.reason).toBe(SERVER_BLOCK_REASON);
    expect(state.badgeAiUsable).toBe(false);
  });

  it("confirms only when truth is full AND the server read is sufficient", () => {
    const state = resolveRubyReadPanelState({
      truthLevel: "full",
      truthReason: FULL_REASON,
      aiUsableProp: undefined,
      read: { gated: false, dataQuality: "ok" },
    });
    expect(state.verdict).toBe("confirmed");
    expect(state.feedNotConfirmed).toBe(false);
    expect(state.badgeAiUsable).toBe(true);
    expect(state.reason).toBeNull();
  });

  it("stays unknown (quiet) while the truth is unresolved and no read has run", () => {
    const state = resolveRubyReadPanelState({
      truthLevel: null,
      truthReason: null,
      aiUsableProp: undefined,
      read: null,
    });
    expect(state.verdict).toBe("unknown");
    expect(state.feedNotConfirmed).toBe(false);
    expect(state.badgeAiUsable).toBeNull();
    expect(state.reportedAiUsable).toBeUndefined();
  });
});

// ── Header/panel Ruby cell reconciliation cap (Task #600) ─────────────────────
//
// The header strip's Ruby cell and the Ruby Chart Read panel call the SAME pure
// `resolveCappedRubyReadStatus(base, read, override)` so the header can never
// claim a fuller read than the panel actually produced. The cap is monotonic:
// it may only LOWER the read (FULL_READ → LIMITED_READ → NO_READ), never raise
// it. We enumerate the matrix and pin downgrade-only behaviour + reason honesty.

const RUBY_BASES: RubyReadStatus[] = ["FULL_READ", "LIMITED_READ", "NO_READ"];
const RANK: Record<RubyReadStatus, number> = {
  NO_READ: 0,
  LIMITED_READ: 1,
  FULL_READ: 2,
};
const CAP_READ_STATES: (RubyReadServerState | null)[] = [
  null,
  { gated: false, dataQuality: "ok" },
  { gated: true, dataQuality: "insufficient", blockedReason: SERVER_BLOCK_REASON },
  { gated: false, dataQuality: "insufficient" },
];
const CAP_OVERRIDES: (boolean | undefined)[] = [undefined, true, false];

describe("resolveCappedRubyReadStatus — header/panel downgrade-only cap", () => {
  it("never raises the read above the base (monotonic / downgrade-only)", () => {
    for (const base of RUBY_BASES) {
      for (const read of CAP_READ_STATES) {
        for (const override of CAP_OVERRIDES) {
          const capped = resolveCappedRubyReadStatus(base, read, override);
          expect(RANK[capped.status]).toBeLessThanOrEqual(RANK[base]);
        }
      }
    }
  });

  it("keeps NO_READ as NO_READ regardless of read/override", () => {
    for (const read of CAP_READ_STATES) {
      for (const override of CAP_OVERRIDES) {
        const capped = resolveCappedRubyReadStatus("NO_READ", read, override);
        expect(capped.status).toBe("NO_READ");
        expect(capped.reason).toBeNull();
      }
    }
  });

  it("leaves a FULL_READ at full when the server read is sufficient and not overridden", () => {
    const capped = resolveCappedRubyReadStatus(
      "FULL_READ",
      { gated: false, dataQuality: "ok" },
      undefined,
    );
    expect(capped.status).toBe("FULL_READ");
    expect(capped.reason).toBeNull();
  });

  it("caps a FULL_READ to LIMITED_READ when the server gated/insufficient, surfacing the server reason", () => {
    const capped = resolveCappedRubyReadStatus("FULL_READ", {
      gated: true,
      dataQuality: "insufficient",
      blockedReason: SERVER_BLOCK_REASON,
    });
    expect(capped.status).toBe("LIMITED_READ");
    expect(capped.reason).toBe(SERVER_BLOCK_REASON);
  });

  it("caps a FULL_READ to LIMITED_READ when the aiUsable override is false", () => {
    const capped = resolveCappedRubyReadStatus("FULL_READ", null, false);
    expect(capped.status).toBe("LIMITED_READ");
    expect(capped.reason).toBeTruthy();
  });

  it("keeps a LIMITED_READ limited and surfaces the server reason when present", () => {
    const withReason = resolveCappedRubyReadStatus("LIMITED_READ", {
      gated: false,
      dataQuality: "insufficient",
      blockedReason: SERVER_BLOCK_REASON,
    });
    expect(withReason.status).toBe("LIMITED_READ");
    expect(withReason.reason).toBe(SERVER_BLOCK_REASON);

    const noRead = resolveCappedRubyReadStatus("LIMITED_READ", null);
    expect(noRead.status).toBe("LIMITED_READ");
    expect(noRead.reason).toBeNull();
  });
});

// ── Task #602: STRUCTURAL_ONLY read is its OWN derived verdict ────────────────
//
// A structural read IS available (enough closed history) but the exact live
// setup is withheld because the feed isn't confirmed. This must be a distinct,
// more-honest verdict — never a bare "feed not confirmed" block and never a
// "confirmed" badge — and it takes precedence over both.
describe("RubyChartRead — STRUCTURAL_ONLY verdict (Task #602)", () => {
  const STRUCT_REASON = "Exact live setup withheld until the feed confirms.";

  it("resolves to verdict 'structural_only' with the badge never claiming clean/AI", () => {
    const panel = resolveRubyReadPanelState({
      truthLevel: "historical_only",
      truthReason: "Historical only",
      aiUsableProp: undefined,
      read: {
        readLayer: "STRUCTURAL_ONLY",
        liveSetupWithheld: true,
        blockedReason: STRUCT_REASON,
      },
    });
    expect(panel.verdict).toBe("structural_only");
    // It is NOT the hard "feed not confirmed" banner — the structure is real.
    expect(panel.feedNotConfirmed).toBe(false);
    // The badge must never read clean/AI while the live setup is withheld.
    expect(panel.badgeAiUsable).toBe(false);
    // The reason carried is the shared withheld-setup reason, not a bare literal.
    expect(panel.reason).toBe(STRUCT_REASON);
  });

  it("takes precedence over a 'confirmed' truth (full feed cannot un-withhold the setup)", () => {
    const panel = resolveRubyReadPanelState({
      truthLevel: "full",
      truthReason: "Live data — valid for a live read",
      aiUsableProp: true,
      read: { readLayer: "STRUCTURAL_ONLY", liveSetupWithheld: true },
    });
    // Even with a full/confirmed truth + override, a STRUCTURAL_ONLY server read
    // downgrades the panel — direction readable, exact setup still withheld.
    expect(panel.verdict).toBe("structural_only");
    expect(panel.badgeAiUsable).toBe(false);
  });

  it("falls back to the headline when no blockedReason is supplied", () => {
    const panel = resolveRubyReadPanelState({
      truthLevel: "historical_only",
      truthReason: "Historical only",
      aiUsableProp: undefined,
      read: { readLayer: "STRUCTURAL_ONLY", headline: "Structural read available" },
    });
    expect(panel.verdict).toBe("structural_only");
    expect(panel.reason).toBe("Structural read available");
  });

  it("caps a FULL_READ base to LIMITED_READ on a STRUCTURAL_ONLY read (setup withheld)", () => {
    const capped = resolveCappedRubyReadStatus("FULL_READ", {
      gated: false,
      dataQuality: "ok",
      readLayer: "STRUCTURAL_ONLY",
      blockedReason: STRUCT_REASON,
    });
    // gated:false + dataQuality:"ok" would normally stay FULL_READ — the layer
    // alone must still downgrade it.
    expect(capped.status).toBe("LIMITED_READ");
    expect(capped.reason).toBe(STRUCT_REASON);
  });

  it("renders the structural-read notice (not a 'feed not confirmed' block) and a real body", () => {
    mockUseScannerTruth.mockReturnValue(hookState({ truth: truthAt("historical_only") }));
    mockStoredRead = {
      readLayer: "STRUCTURAL_ONLY",
      liveSetupWithheld: true,
      gated: false,
      dataQuality: "ok",
      blockedReason: STRUCT_REASON,
      bias: "Bullish",
    } as RubyReadServerState;

    render(<RubyChartRead symbol="V75" timeframe="H1" draft={null} />);

    // The distinct structural notice is shown…
    expect(screen.getByTestId("ruby-chart-read-structural-notice")).toBeTruthy();
    // …and NOT the hard feed-not-confirmed block (the structure is real).
    expect(screen.queryByTestId("ruby-chart-read-feed-warning")).toBeNull();
    // The directional body still renders (a structural read is NOT a no-read).
    expect(screen.getByTestId("ruby-chart-read-body")).toBeTruthy();
  });

  it("clicking 'Read this chart' on a structural read surfaces the structural notice", async () => {
    mockUseScannerTruth.mockReturnValue(hookState({ truth: truthAt("historical_only") }));
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        new Response(
          JSON.stringify({
            chartRead: {
              readLayer: "STRUCTURAL_ONLY",
              liveSetupWithheld: true,
              gated: false,
              dataQuality: "ok",
              blockedReason: STRUCT_REASON,
              bias: "Bullish",
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );

    render(<RubyChartRead symbol="V75" timeframe="H1" draft={null} />);
    fireEvent.click(screen.getByTestId("ruby-chart-read-ask"));

    expect(await screen.findByTestId("ruby-chart-read-structural-notice")).toBeTruthy();
    expect(screen.queryByTestId("ruby-chart-read-feed-warning")).toBeNull();
    fetchSpy.mockRestore();
  });
});

// ── Trust-label honesty regression: never a live/verified label on a degraded ─
//    feed even when a read exists ───────────────────────────────────────────────
//
// Display-honesty lock for the Scanner. The Ruby Chart Read panel surfaces a
// REAL directional read (a server read body, a gated read, or a STRUCTURAL_ONLY
// read) WHILE the ONE shared verdict for this exact symbol/timeframe says the
// feed is historical-only or not live-confirmed. In that contradiction the panel
// must NEVER tell its trust chip the feed is live/AI-confirmed, and must NEVER
// render any affirmative live/verified/execution-ready trust label — only the
// honest degraded wording. The chip's single trust input is `aiUsableResolved`
// (= the resolved `panel.badgeAiUsable`), so we pin it both at the prop the
// surface feeds the chip AND at the rendered DOM (the faithful stub only emits
// the affirmative trust tokens when fed `true`).
//
// HARD BOUNDARY: this is a TEST-ONLY regression — it asserts existing behaviour
// and changes no shared contract, resolver, ticket, or safety/execution gate.
const FORBIDDEN_TRUST_TOKENS = [
  "Live feed",
  "Verified",
  "AACI verified",
  "Live-confirmed",
  "Execution-ready",
];

describe("RubyChartRead — never a live/verified trust label on a degraded feed", () => {
  it("historical-only feed with a real read present: chip fed not-confirmed, honest wording shown, no live/verified token", () => {
    mockUseScannerTruth.mockReturnValue(
      hookState({ truth: truthAt("historical_only", "Latest candle is frozen.") }),
    );
    // A real (non-gated) directional read body IS present — read data exists.
    mockStoredRead = {
      gated: false,
      dataQuality: "ok",
      bias: "Bullish",
    } as RubyReadServerState;

    const { container } = render(
      <RubyChartRead symbol="EURUSD" timeframe="M5" draft={null} />,
    );

    // The read body renders (read/history data exists)…
    expect(screen.getByTestId("ruby-chart-read-body")).toBeTruthy();
    // …but the trust chip is fed a NON-confirmed verdict (never `true`).
    expect(mockFeedBadgeProps.aiUsableResolved).not.toBe(true);
    expect(mockFeedBadgeProps.aiUsableResolved).toBe(false);
    expect(
      screen.getByTestId("feed-confidence-badge").getAttribute("data-ai-usable"),
    ).not.toBe("true");
    // …and the honest degraded wording IS rendered.
    expect(
      screen.getByTestId("ruby-chart-read-feed-warning").textContent,
    ).toContain("Feed not confirmed");
    // …with NO affirmative live/verified/execution-ready trust token anywhere.
    for (const token of FORBIDDEN_TRUST_TOKENS) {
      expect(container.textContent).not.toContain(token);
    }
  });

  it("feed-unconfirmed via a server-gated read (truth resolves full): chip stays not-confirmed, no live/verified token", () => {
    // The shared truth resolves FULL, but the server could not verify the read —
    // the panel must still degrade the trust chip, never claim a live feed.
    mockUseScannerTruth.mockReturnValue(hookState({ truth: truthAt("full") }));
    mockStoredRead = {
      gated: true,
      dataQuality: "insufficient",
      blockedReason: "Chart intelligence unavailable — cannot verify chart data.",
    } as RubyReadServerState;

    const { container } = render(
      <RubyChartRead symbol="EURUSD" timeframe="M5" draft={null} />,
    );

    // The honestly-gated read body renders (read data exists, surfaced as gated)…
    expect(screen.getByTestId("ruby-chart-read-gated")).toBeTruthy();
    // …and the trust chip is never told the feed is confirmed.
    expect(mockFeedBadgeProps.aiUsableResolved).toBe(false);
    expect(
      screen.getByTestId("feed-confidence-badge").getAttribute("data-ai-usable"),
    ).not.toBe("true");
    expect(
      screen.getByTestId("ruby-chart-read-feed-warning").textContent,
    ).toContain("Feed not confirmed");
    for (const token of FORBIDDEN_TRUST_TOKENS) {
      expect(container.textContent).not.toContain(token);
    }
  });

  it("structural-only read: directional structure shows but the chip never claims a live/AI-confirmed feed", () => {
    mockUseScannerTruth.mockReturnValue(hookState({ truth: truthAt("historical_only") }));
    mockStoredRead = {
      readLayer: "STRUCTURAL_ONLY",
      liveSetupWithheld: true,
      gated: false,
      dataQuality: "ok",
      blockedReason: "Exact live setup withheld until the feed confirms.",
      bias: "Bullish",
    } as RubyReadServerState;

    const { container } = render(
      <RubyChartRead symbol="V75" timeframe="H1" draft={null} />,
    );

    // The directional structural body renders…
    expect(screen.getByTestId("ruby-chart-read-body")).toBeTruthy();
    // …with the honest structural notice (NOT the hard not-confirmed block)…
    expect(
      screen.getByTestId("ruby-chart-read-structural-notice").textContent,
    ).toContain("Structural read available");
    expect(screen.queryByTestId("ruby-chart-read-feed-warning")).toBeNull();
    // …and the trust chip still never claims a live/AI-confirmed feed.
    expect(mockFeedBadgeProps.aiUsableResolved).toBe(false);
    expect(
      screen.getByTestId("feed-confidence-badge").getAttribute("data-ai-usable"),
    ).not.toBe("true");
    for (const token of FORBIDDEN_TRUST_TOKENS) {
      expect(container.textContent).not.toContain(token);
    }
  });
});

// ── Task #609 — survives a truthy-but-partial (half-loaded) read payload ──────
//
// Sibling hardening to SelectedMarketPanel (Task #608): a server read that is
// present (truthy) but only partly populated — a non-gated body missing every
// field (bias / why / buyCondition / cautions / …) or a gated read missing its
// headline / blockedReason / disclaimer — must NOT throw the panel into the
// route error boundary. Every body field is read with a `?? "—"` / guarded
// fallback, so a half-formed read degrades to its honest dashes and still
// renders. Pure render proofs (the truth hook + read store are mocked); no
// displayed value changes for a well-formed read (covered by the suites above).
describe("Task #609 — RubyChartRead survives a half-loaded read payload", () => {
  it("renders the read body for a non-gated read missing every field, without crashing", () => {
    mockUseScannerTruth.mockReturnValue(hookState({ truth: truthAt("full") }));
    // A truthy, non-gated read with NO body fields at all.
    mockStoredRead = { gated: false } as RubyReadServerState;
    expect(() =>
      render(<RubyChartRead symbol="EURUSD" timeframe="M5" draft={null} />),
    ).not.toThrow();
    expect(screen.getByTestId("ruby-chart-read")).toBeTruthy();
    expect(screen.getByTestId("ruby-chart-read-body")).toBeTruthy();
  });

  it("renders the gated block for a gated read missing headline/reason/disclaimer", () => {
    mockUseScannerTruth.mockReturnValue(hookState({ truth: truthAt("historical_only") }));
    // A truthy, gated read with none of the optional prose fields.
    mockStoredRead = { gated: true } as RubyReadServerState;
    expect(() =>
      render(<RubyChartRead symbol="EURUSD" timeframe="M5" draft={null} />),
    ).not.toThrow();
    expect(screen.getByTestId("ruby-chart-read")).toBeTruthy();
  });

  it("does not crash when the fetch resolves a payload with a null/partial chartRead", async () => {
    mockUseScannerTruth.mockReturnValue(hookState({ truth: truthAt("full") }));
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ chartRead: { gated: false } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    render(<RubyChartRead symbol="EURUSD" timeframe="M5" draft={null} />);
    fireEvent.click(screen.getByTestId("ruby-chart-read-ask"));
    expect(await screen.findByTestId("ruby-chart-read-body")).toBeTruthy();
    fetchSpy.mockRestore();
  });
});

// ── Owner screenshot 2026-10-27 (V75 1m, Deriv public data) ───────────────────
//
// The server's STRUCTURAL_ONLY read reached the client with `readLayer: ""` and
// `tradeHealthFreshness: ""` (blanked by the user-copy scrubber), so the panel
// treated it as a full read: Feed/Data "Live read on V75 1m.", S/R "… Mind room
// into these levels." and Pattern/Trendline "No specific … named" — while the
// SAME read's Risk line said "Exact entry, stop, and target levels withheld —
// Live feed is delayed …". The server now keeps the enum; the client also reads
// the transparency booleans (which always survived) and the cautions, so either
// wire shape renders the withheld state. Downgrade-only.
describe("owner screenshot 2026-10-27 — STRUCTURAL_ONLY read never renders as a live read", () => {
  const WITHHELD_REASON =
    "Live feed is delayed — read uses the last confirmed bars, not the current candle.";
  function serverStructuralRead(readLayer: string, tradeHealthFreshness: string): RubyReadServerState {
    return {
      symbol: "V75",
      timeframe: "M1",
      bias: "Mixed",
      htfBias: "No clear edge",
      confidence: "Low",
      why: "Higher-timeframe bias is unclear. On this timeframe the trend structure leans up, with momentum cooling; price is trading up near resistance.",
      supportZone: "33250.6 – 33273.2",
      resistanceZone: "33639.4 – 33662.0",
      cautions: [
        `Exact entry, stop, and target levels withheld — ${WITHHELD_REASON}`,
        "Read is from closed candles only — current-candle/entry confirmation pending.",
      ],
      gated: false,
      dataQuality: "ok",
      readLayer,
      liveSetupWithheld: true,
      canReadStructure: true,
      canShowLiveTradeSetup: false,
      tradeHealthFreshness,
      tradeHealthLabel: "Historical read only",
      tradeHealthTrustLine:
        "Historical/closed-candle M1 structural read — feed not confirmed for live entry.",
      basis: "VERIFIED",
      blockedReason: WITHHELD_REASON,
      // Fresh data time (newest closed candle) so the read is not expired.
      observedAt: new Date(Date.now() - 10_000).toISOString(),
    } as unknown as RubyReadServerState;
  }

  for (const [label, read] of [
    ["fixed server wire (readLayer STRUCTURAL_ONLY)", () => serverStructuralRead("STRUCTURAL_ONLY", "HISTORICAL_ONLY")],
    ["pre-fix scrubbed wire (readLayer \"\")", () => serverStructuralRead("", "")],
  ] as const) {
    it(`${label}: Feed/Data, S/R, notice and header cap all say the setup is withheld`, () => {
      mockUseScannerTruth.mockReturnValue(hookState({ truth: truthAt("full", "Live data — valid for a live read") }));
      mockStoredRead = read();
      render(<RubyChartRead symbol="V75" timeframe="1m" draft={null} />);

      const feedData = screen.getByTestId("ruby-chart-read-reasoning-evidence-feedData").textContent ?? "";
      expect(feedData).not.toContain("Live read on");
      expect(feedData).toContain("Structural read only on V75 1m — exact entry/stop/target withheld:");
      expect(feedData).not.toContain("until V75 1m confirms");
      expect(feedData).toContain(WITHHELD_REASON);
      const sr = screen.getByTestId("ruby-chart-read-reasoning-evidence-supportResistance").textContent ?? "";
      expect(sr).toContain("Exact entry/stop/target withheld");
      expect(sr).not.toContain("Mind room into these levels");
      expect(screen.getByTestId("ruby-chart-read-reasoning-evidence-pattern").textContent).not.toContain("No specific chart pattern named");
      expect(screen.getByTestId("ruby-chart-read-structural-notice")).toBeTruthy();
      expect(mockFeedBadgeProps.aiUsableResolved).toBe(false);

      const capped = resolveCappedRubyReadStatus("FULL_READ", mockStoredRead);
      expect(capped.status).toBe("LIMITED_READ");
      expect(capped.reason).toBe(WITHHELD_REASON);
    });
  }

  it("contradiction guard: cautions that withhold levels never pair with 'Live read on'", () => {
    // Even a read whose panel verdict was not structural (no layer, no
    // transparency booleans) may not claim a live read while its own cautions
    // say the exact levels are withheld.
    mockUseScannerTruth.mockReturnValue(hookState({ truth: truthAt("full") }));
    mockStoredRead = {
      gated: false,
      dataQuality: "ok",
      bias: "Bullish",
      supportZone: "1",
      resistanceZone: "2",
      cautions: ["Exact entry, stop, and target levels withheld — Live feed is delayed."],
    } as RubyReadServerState;
    render(<RubyChartRead symbol="V75" timeframe="1m" draft={null} />);
    const feedData = screen.getByTestId("ruby-chart-read-reasoning-evidence-feedData").textContent ?? "";
    expect(feedData).not.toContain("Live read on");
    expect(
      screen.getByTestId("ruby-chart-read-reasoning-evidence-supportResistance").textContent,
    ).not.toContain("Mind room into these levels");
  });

  it("a genuine FULL read with no withheld signals still renders the live read (no over-downgrade)", () => {
    mockUseScannerTruth.mockReturnValue(hookState({ truth: truthAt("full") }));
    mockStoredRead = {
      gated: false,
      dataQuality: "ok",
      readLayer: "FULL",
      liveSetupWithheld: false,
      canShowLiveTradeSetup: true,
      bias: "Bullish",
      supportZone: "1",
      resistanceZone: "2",
      cautions: [],
      observedAt: new Date(Date.now() - 10_000).toISOString(),
    } as RubyReadServerState;
    render(<RubyChartRead symbol="V75" timeframe="1m" draft={null} />);
    expect(screen.getByTestId("ruby-chart-read-reasoning-evidence-feedData").textContent).toBe("Live read on V75 1m.");
    expect(screen.queryByTestId("ruby-chart-read-structural-notice")).toBeNull();
  });
});

// ── levels-withheld-vs-shown (owner's V75 1m screenshot [F]) ──────────────────
//
// The read-chart service used to scrub its WHOLE payload through the user-copy
// scrubber, which deletes SCREAMING_SNAKE tokens: "STRUCTURAL_ONLY" reached the
// wire as "". The panel then compared `readLayer === "STRUCTURAL_ONLY"` → false,
// fell to "confirmed" on a full shared truth, and rendered "WAIT — no confirmed
// direction" / "Live read on V75 1m." / "Mind room into these levels." beside
// the server's own caution "Exact entry, stop, and target levels withheld — …".
// The withheld-setup flags that survived the scrubber must be enough to keep the
// panel structural (downgrade-only), and the route's top-level readLayer may only
// lower the payload's.
describe("RubyChartRead — a withheld structural read never renders as a live read (owner's [F])", () => {
  const BLOCKED = "Live feed is delayed — read uses the last confirmed bars, not the current candle.";
  const OWNER_WIRE = {
    gated: false,
    readLayer: "",
    liveSetupWithheld: true,
    canReadStructure: true,
    canShowLiveTradeSetup: false,
    dataQuality: undefined,
    // Fresh data time (newest closed candle 10s ago) so this pins the
    // structural copy, not the expiry downgrade covered below.
    observedAt: new Date(Date.now() - 10_000).toISOString(),
    bias: "Mixed",
    confidence: "Low",
    htfBias: "No clear edge",
    why: "Higher-timeframe bias is unclear. On this timeframe the trend structure leans up, with momentum cooling; price is trading up near resistance.",
    supportZone: "33250.6 – 33273.2",
    resistanceZone: "33639.4 – 33662.0",
    blockedReason: BLOCKED,
    cautions: [
      `Exact entry, stop, and target levels withheld — ${BLOCKED}`,
      "Read is from closed candles only — current-candle/entry confirmation pending.",
    ],
  } as unknown as RubyReadServerState;

  it("resolver: liveSetupWithheld without a readLayer resolves structural_only (badge never Clean/AI)", () => {
    const panel = resolveRubyReadPanelState({
      truthLevel: "full",
      truthReason: "Live data — valid for a live read",
      aiUsableProp: undefined,
      read: OWNER_WIRE,
    });
    expect(panel.verdict).toBe("structural_only");
    expect(panel.badgeAiUsable).toBe(false);
    expect(panel.reason).toBe(BLOCKED);
    expect(resolveCappedRubyReadStatus("FULL_READ", OWNER_WIRE).status).toBe("LIMITED_READ");
  });

  it("resolver: an INSUFFICIENT-shaped read (also liveSetupWithheld) stays not_confirmed, not structural_only", () => {
    const panel = resolveRubyReadPanelState({
      truthLevel: "full",
      truthReason: "Live data — valid for a live read",
      aiUsableProp: undefined,
      read: {
        gated: true,
        readLayer: "INSUFFICIENT",
        liveSetupWithheld: true,
        canReadStructure: false,
        canShowLiveTradeSetup: false,
        dataQuality: "insufficient",
        blockedReason: "Not enough closed candles yet (5/150).",
      },
    });
    expect(panel.verdict).toBe("not_confirmed");
  });

  it("resolver: a FULL read with the live setup allowed stays confirmed on a full truth", () => {
    const panel = resolveRubyReadPanelState({
      truthLevel: "full",
      truthReason: "Live data — valid for a live read",
      aiUsableProp: undefined,
      read: { gated: false, readLayer: "FULL", liveSetupWithheld: false, canReadStructure: true, canShowLiveTradeSetup: true },
    });
    expect(panel.verdict).toBe("confirmed");
  });

  it("withRouteReadLayer is downgrade-only", () => {
    expect(withRouteReadLayer({ readLayer: "" } as unknown as RubyReadServerState, "STRUCTURAL_ONLY")?.readLayer).toBe("STRUCTURAL_ONLY");
    expect(withRouteReadLayer({} as RubyReadServerState, "FULL")?.readLayer).toBeUndefined();
    expect(withRouteReadLayer({ readLayer: "FULL" }, "STRUCTURAL_ONLY")?.readLayer).toBe("STRUCTURAL_ONLY");
    expect(withRouteReadLayer({ readLayer: "STRUCTURAL_ONLY" }, "FULL")?.readLayer).toBe("STRUCTURAL_ONLY");
    expect(withRouteReadLayer(null, "FULL")).toBeNull();
  });

  it("render: the owner's wire payload shows the structural notice, cites the server reason, and never says 'Live read on'", () => {
    mockUseScannerTruth.mockReturnValue(hookState({ truth: truthAt("full", "Live data — valid for a live read") }));
    mockStoredRead = OWNER_WIRE;
    const { container } = render(<RubyChartRead symbol="V75" timeframe="1m" draft={null} />);

    const notice = screen.getByTestId("ruby-chart-read-structural-notice");
    expect(notice.textContent).toContain(BLOCKED);
    expect(screen.queryByTestId("ruby-chart-read-feed-warning")).toBeNull();
    const text = container.textContent ?? "";
    expect(text).not.toContain("Live read on");
    expect(text).not.toContain("WAIT — no confirmed direction");
    expect(text).not.toContain("Mind room into these levels");
    expect(text).toContain("WAIT — structure only");
    expect(text).toContain(`Exact entry/stop/target withheld — ${BLOCKED}`);
    expect(text).not.toMatch(/Mark support .* on V75; watch which one price tests first/);
    expect(mockFeedBadgeProps.aiUsableResolved).toBe(false);
    for (const token of FORBIDDEN_TRUST_TOKENS) {
      expect(screen.getByTestId("feed-confidence-badge").textContent).not.toContain(token);
    }
  });

  it("render: the route's top-level readLayer restores STRUCTURAL_ONLY when chartRead.readLayer is blank", async () => {
    mockUseScannerTruth.mockReturnValue(hookState({ truth: truthAt("full") }));
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          chartRead: { gated: false, readLayer: "", blockedReason: BLOCKED, bias: "Mixed" },
          readLayer: "STRUCTURAL_ONLY",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    render(<RubyChartRead symbol="V75" timeframe="1m" draft={null} />);
    fireEvent.click(screen.getByTestId("ruby-chart-read-ask"));
    expect(await screen.findByTestId("ruby-chart-read-structural-notice")).toBeTruthy();
    fetchSpy.mockRestore();
  });
});

// ── Read data time + expiry (levels-withheld-vs-shown RC4) ────────────────────
//
// A chart read is a one-shot snapshot kept in the page store. Its caution
// ("… withheld — <reason>") described the feed at READ time, but nothing on the
// panel said when that was, so a minutes-old read sat under a live page as if
// current. The server now ships `observedAt` (newest CLOSED candle close); the
// panel shows it and, past the timeframe's candle budget (or with no time at
// all), downgrades the read — never upgrades it.
describe("RubyChartRead — read data time and expiry", () => {
  const FRESH = () => new Date(Date.now() - 10_000).toISOString();
  const OLD = () => new Date(Date.now() - 10 * 60_000).toISOString();

  it("chartReadExpiresAtMs: gated → null, missing time → NaN (fail-closed), else observedAt + budget", () => {
    expect(chartReadExpiresAtMs({ gated: true }, 90_000)).toBeNull();
    expect(Number.isNaN(chartReadExpiresAtMs({ gated: false }, 90_000))).toBe(true);
    expect(Number.isNaN(chartReadExpiresAtMs({ gated: false, observedAt: "not-a-time" }, 90_000))).toBe(true);
    expect(chartReadExpiresAtMs({ gated: false, observedAt: "2026-10-27T16:03:00.000Z" }, 90_000)).toBe(
      Date.parse("2026-10-27T16:03:00.000Z") + 90_000,
    );
  });

  it("resolver: an expired read never lets the badge claim clean/AI, even on a confirmed FULL read", () => {
    const panel = resolveRubyReadPanelState({
      truthLevel: "full",
      truthReason: "Live data — valid for a live read",
      aiUsableProp: undefined,
      read: { gated: false, readLayer: "FULL", canShowLiveTradeSetup: true },
      readExpired: true,
    });
    expect(panel.readExpired).toBe(true);
    expect(panel.badgeAiUsable).toBe(false);
  });

  it("render: a fresh FULL read shows its newest-closed-candle time and is not expired", () => {
    mockUseScannerTruth.mockReturnValue(hookState({ truth: truthAt("full") }));
    mockStoredRead = { gated: false, readLayer: "FULL", canShowLiveTradeSetup: true, observedAt: FRESH(), bias: "Bullish" } as RubyReadServerState;
    render(<RubyChartRead symbol="V75" timeframe="1m" draft={null} />);
    const asOf = screen.getByTestId("ruby-chart-read-asof").textContent ?? "";
    expect(asOf).toMatch(/newest closed candle \d\d:\d\d UTC/);
    expect(asOf).not.toContain("expired");
    expect(mockFeedBadgeProps.aiUsableResolved).toBe(true);
  });

  it("render: a read older than the 1m candle budget is labelled expired and the reasoning says so", () => {
    mockUseScannerTruth.mockReturnValue(hookState({ truth: truthAt("full") }));
    mockStoredRead = { gated: false, readLayer: "FULL", canShowLiveTradeSetup: true, observedAt: OLD(), bias: "Bullish" } as RubyReadServerState;
    const { container } = render(<RubyChartRead symbol="V75" timeframe="1m" draft={null} />);
    expect(screen.getByTestId("ruby-chart-read-asof").textContent).toContain("expired");
    const text = container.textContent ?? "";
    expect(text).toContain("WAIT — this read has expired");
    expect(text).not.toContain("Live read on");
    expect(mockFeedBadgeProps.aiUsableResolved).toBe(false);
  });

  it("render: the same age is still current on 1h (budget follows the timeframe, normalised from H1)", () => {
    mockUseScannerTruth.mockReturnValue(hookState({ truth: truthAt("full") }));
    mockStoredRead = { gated: false, readLayer: "FULL", canShowLiveTradeSetup: true, observedAt: OLD(), bias: "Bullish" } as RubyReadServerState;
    render(<RubyChartRead symbol="EURUSD" timeframe="H1" draft={null} />);
    expect(screen.getByTestId("ruby-chart-read-asof").textContent).not.toContain("expired");
  });

  // The read stops describing the chart when the next candle closes (its
  // newest closed candle + one interval) — the shared trailing-interval rule
  // the server's evidence matching uses — not after a 1.2–1.5× budget.
  it("render: an H1 read whose newest closed candle is 65 min old is expired (a newer H1 candle has closed)", () => {
    mockUseScannerTruth.mockReturnValue(hookState({ truth: truthAt("full") }));
    const observedAt = new Date(Date.now() - 65 * 60_000).toISOString();
    mockStoredRead = { gated: false, readLayer: "FULL", canShowLiveTradeSetup: true, observedAt, bias: "Bullish" } as RubyReadServerState;
    render(<RubyChartRead symbol="EURUSD" timeframe="H1" draft={null} />);
    expect(screen.getByTestId("ruby-chart-read-asof").textContent).toContain("expired");
    expect(mockFeedBadgeProps.aiUsableResolved).toBe(false);
  });

  it("render: a non-gated read with no data time is treated as expired (fail-closed)", () => {
    mockUseScannerTruth.mockReturnValue(hookState({ truth: truthAt("full") }));
    mockStoredRead = { gated: false, readLayer: "FULL", canShowLiveTradeSetup: true, bias: "Bullish" } as RubyReadServerState;
    render(<RubyChartRead symbol="V75" timeframe="1m" draft={null} />);
    const asOf = screen.getByTestId("ruby-chart-read-asof").textContent ?? "";
    expect(asOf).toContain("Read time unknown");
    expect(asOf).toContain("expired");
    expect(mockFeedBadgeProps.aiUsableResolved).toBe(false);
  });
});

// ── Owner screenshot 2026-10-27 — the HTF was never read ──────────────────────
//
// The chart read printed "Higher-timeframe bias No clear edge; Mixed on 1m." and
// an "HTF Bias: No clear edge" tile, but the server had never fetched HTF candles
// (higherTimeframeOf("M1") → null). The server now sends htfBias null +
// htfTimeframe; the client renders "not read" (and treats the legacy sentinel the
// same way), and names the HTF timeframe only from the server's field.
describe("owner screenshot 2026-10-27 — HTF bias is stated only when it was read", () => {
  function fullRead(extra: Record<string, unknown>): RubyReadServerState {
    return {
      gated: false,
      dataQuality: "ok",
      readLayer: "FULL",
      liveSetupWithheld: false,
      canShowLiveTradeSetup: true,
      bias: "Mixed",
      confidence: "Low",
      supportZone: "1",
      resistanceZone: "2",
      cautions: [],
      ...extra,
    } as unknown as RubyReadServerState;
  }

  it("htfBias null + htfTimeframe M15 → 'Higher-timeframe (15m) bias not read' and an em-dash tile", () => {
    mockUseScannerTruth.mockReturnValue(hookState({ truth: truthAt("full") }));
    mockStoredRead = fullRead({ htfBias: null, htfTimeframe: "M15" });
    render(<RubyChartRead symbol="V75" timeframe="1m" draft={null} />);
    expect(screen.getByTestId("ruby-chart-read-reasoning-evidence-structure").textContent).toBe(
      "Higher-timeframe (15m) bias not read; Mixed on 1m. Structure-read confidence: Low (structure scale: Low / Medium / High).",
    );
    const tile = screen.getByTestId("ruby-chart-read-htf-bias");
    expect(tile.textContent).toBe("—");
    expect(screen.getByText("HTF (15m) bias")).toBeTruthy();
  });

  it("legacy sentinel 'No clear edge' with no htfTimeframe is 'not read', never a bias", () => {
    mockUseScannerTruth.mockReturnValue(hookState({ truth: truthAt("full") }));
    mockStoredRead = fullRead({ htfBias: "No clear edge" });
    render(<RubyChartRead symbol="V75" timeframe="1m" draft={null} />);
    const structure = screen.getByTestId("ruby-chart-read-reasoning-evidence-structure").textContent ?? "";
    expect(structure).toBe("Higher-timeframe bias not read; Mixed on 1m. Structure-read confidence: Low (structure scale: Low / Medium / High).");
    expect(structure).not.toContain("No clear edge");
    expect(screen.getByTestId("ruby-chart-read-htf-bias").textContent).toBe("—");
  });

  it("a read 15m bias is named with its timeframe", () => {
    mockUseScannerTruth.mockReturnValue(hookState({ truth: truthAt("full") }));
    mockStoredRead = fullRead({ htfBias: "Bullish", htfTimeframe: "M15" });
    render(<RubyChartRead symbol="V75" timeframe="1m" draft={null} />);
    expect(screen.getByTestId("ruby-chart-read-reasoning-evidence-structure").textContent).toBe(
      "Higher timeframe (15m) leans bullish; Mixed on 1m. Structure-read confidence: Low (structure scale: Low / Medium / High).",
    );
    expect(screen.getByTestId("ruby-chart-read-htf-bias").textContent).toBe("Bullish");
  });
});

// ── Owner screenshot 2026-10-27 — trendline drawn on the chart, "none named" in the read ──
describe("owner screenshot 2026-10-27 — the chart read's Trendline row is the server's detector note", () => {
  it("a STRUCTURAL_ONLY payload with trendlineRead renders the note, not 'No specific trendline named.'", () => {
    mockUseScannerTruth.mockReturnValue(hookState({ truth: truthAt("full") }));
    const note =
      "Rising support trendline (bullish) has broken on a decisive close. Feed is not live-confirmed, so treat this trendline as context only.";
    mockStoredRead = {
      gated: false,
      dataQuality: "ok",
      readLayer: "STRUCTURAL_ONLY",
      liveSetupWithheld: true,
      canShowLiveTradeSetup: false,
      bias: "Mixed",
      supportZone: "1",
      resistanceZone: "2",
      cautions: ["Exact entry, stop, and target levels withheld — Live feed is delayed."],
      trendlineRead: { trendlineNote: note, trendlineStatus: "broken", trendlineContextOnly: true, trendlineDetection: "detected" },
    } as unknown as RubyReadServerState;
    render(<RubyChartRead symbol="V75" timeframe="1m" draft={null} />);
    const row = screen.getByTestId("ruby-chart-read-reasoning-evidence-trendline").textContent ?? "";
    expect(row).toBe(note);
    expect(row).not.toContain("No specific trendline named.");
    expect(row).not.toContain("Trendline read withheld");
  });
});

// Owner screenshot 2026-10-27 [F]: the chart read's Risk row said "News/calendar
// unavailable — event risk not assessed." on every read, although the
// read-chart endpoint consults no calendar and the market-read card on the same
// page printed the truth read's own calendar label.
describe("RubyChartRead — Risk row states event risk exactly as checked", () => {
  function fullRead(): RubyReadServerState {
    return {
      gated: false, dataQuality: "ok", readLayer: "FULL", liveSetupWithheld: false, canShowLiveTradeSetup: true,
      bias: "Bullish", supportZone: "1", resistanceZone: "2", cautions: [],
    } as RubyReadServerState;
  }
  it("mirrors the page's truth-read event-risk line verbatim", () => {
    mockUseScannerTruth.mockReturnValue(hookState({ truth: truthAt("full") }));
    mockStoredRead = fullRead();
    render(<RubyChartRead symbol="V75" timeframe="1m" draft={null} newsRiskLabel="No event calendar is connected." />);
    const risk = screen.getByTestId("ruby-chart-read-reasoning-evidence-risk").textContent ?? "";
    expect(risk).toContain("No event calendar is connected.");
    expect(risk).not.toContain("News/calendar unavailable");
  });
  it("with no page line, says only that this read did not assess event risk", () => {
    mockUseScannerTruth.mockReturnValue(hookState({ truth: truthAt("full") }));
    mockStoredRead = fullRead();
    render(<RubyChartRead symbol="V75" timeframe="1m" draft={null} />);
    const risk = screen.getByTestId("ruby-chart-read-reasoning-evidence-risk").textContent ?? "";
    expect(risk).toContain("Event risk not assessed in this read.");
    expect(risk).not.toMatch(/unavailable/i);
  });
});

// Owner screenshot 2026-10-27: the header Action cell said "Feed limited" while
// the Eleanor tile said "Full read" and the panel's chip could still read
// Clean/AI. The page's canonical action verdict now caps both, downgrade-only.
describe("feed-limited action verdict caps the Eleanor read (header + panel agree)", () => {
  it("pure: FEED_LIMITED / ANALYSIS_ONLY cap a FULL_READ; CHECK_FAILED does not", async () => {
    const { isFeedLimitedAction } = await import("@/lib/rubyReadPanelState");
    expect(isFeedLimitedAction("FEED_LIMITED")).toBe(true);
    expect(isFeedLimitedAction("ANALYSIS_ONLY")).toBe(true);
    expect(isFeedLimitedAction("CHECK_FAILED")).toBe(false);
    expect(isFeedLimitedAction("WAIT_FOR_CONFIRMATION")).toBe(false);
    expect(isFeedLimitedAction("PENDING")).toBe(false);
    const full: RubyReadServerState = { gated: false, dataQuality: "ok", readLayer: "FULL" };
    expect(resolveCappedRubyReadStatus("FULL_READ", full, undefined, "Eleanor", true)).toEqual({
      status: "LIMITED_READ",
      reason: "The live feed isn't fully confirmed — Eleanor reads with caution.",
    });
    expect(resolveCappedRubyReadStatus("FULL_READ", full, undefined, "Eleanor", false).status).toBe("FULL_READ");
    // never raises
    expect(resolveCappedRubyReadStatus("NO_READ", full, undefined, "Eleanor", true).status).toBe("NO_READ");
  });

  it("pure: panel verdict is not_confirmed and the badge can't claim Clean/AI; the endpoint report is unchanged", () => {
    const s = resolveRubyReadPanelState({
      truthLevel: "full",
      truthReason: "Live data — valid for a live read",
      aiUsableProp: undefined,
      read: { gated: false, dataQuality: "ok", readLayer: "FULL" },
      actionFeedLimited: true,
      assistantName: "Eleanor",
    });
    expect(s.verdict).toBe("not_confirmed");
    expect(s.badgeAiUsable).toBe(false);
    expect(s.reason).toBe("The live feed isn't fully confirmed — Eleanor reads with caution.");
    expect(s.reportedAiUsable).toBe(true);
  });

  it("render: a FULL read under a FEED_LIMITED canonical action never feeds the chip a confirmed verdict", () => {
    mockUseScannerTruth.mockReturnValue(hookState({ truth: truthAt("full") }));
    mockStoredRead = { gated: false, dataQuality: "ok", readLayer: "FULL", bias: "Bullish" } as RubyReadServerState;
    render(<RubyChartRead symbol="V75" timeframe="1m" draft={null} canonicalAction="FEED_LIMITED" />);
    expect(mockFeedBadgeProps.aiUsableResolved).toBe(false);
    expect(screen.getByTestId("ruby-chart-read-feed-warning").textContent).toContain(
      "isn't fully confirmed",
    );
  });

  it("render: a FULL read under WAIT_FOR_CONFIRMATION keeps the confirmed chip (no over-downgrade)", () => {
    mockUseScannerTruth.mockReturnValue(hookState({ truth: truthAt("full") }));
    mockStoredRead = {
      gated: false, dataQuality: "ok", readLayer: "FULL", bias: "Bullish",
      // Fresh data time: a read with none is treated as expired (fail-closed).
      observedAt: new Date(Date.now() - 10_000).toISOString(),
    } as RubyReadServerState;
    render(<RubyChartRead symbol="V75" timeframe="1m" draft={null} canonicalAction="WAIT_FOR_CONFIRMATION" />);
    expect(mockFeedBadgeProps.aiUsableResolved).toBe(true);
    expect(screen.queryByTestId("ruby-chart-read-feed-warning")).toBeNull();
  });
});

// Owner screenshot 2026-10-27: TRADING "Blocked — Trading is restricted on your
// account" and the chart footer "Manual trading is currently blocked for your
// account." while the Eleanor read panel offered "Prepare Trade" (dimmed, with a
// FEED tooltip) — and would have offered an enabled link on READY_NOW.
describe("Prepare Trade CTA honours the account's trading block (separate authority)", () => {
  function truthWithTrading(
    tradingStatus: "ENABLED" | "BLOCKED" | "DISABLED" | "REVIEW_REQUIRED",
    detail: string,
  ): ScannerTruth {
    return {
      analysis: { level: "full", reason: "Live data — valid for a live read" },
      consolidated: { tradingStatus },
      strip: { trading: { detail } },
    } as unknown as ScannerTruth;
  }
  const FULL = { gated: false, dataQuality: "ok", readLayer: "FULL", bias: "Bullish" } as RubyReadServerState;
  const RESTRICTED = "Trading is restricted on your account. Contact support.";

  it("(a) BLOCKED + READY_NOW BUY: disabled button (no link), tooltip names the restriction, inline note, neutral label", () => {
    mockUseScannerTruth.mockReturnValue(hookState({ truth: truthWithTrading("BLOCKED", RESTRICTED) }));
    mockStoredRead = FULL;
    render(<RubyChartRead symbol="V75" timeframe="1m" draft={null} canonicalAction="READY_NOW" canonicalDirection="BUY" />);
    const cta = screen.getByTestId("ruby-chart-prepare-trade");
    expect(cta.tagName).toBe("BUTTON");
    expect(cta.getAttribute("href")).toBeNull();
    expect((cta as HTMLButtonElement).disabled).toBe(true);
    expect(cta.getAttribute("title")).toBe(RESTRICTED);
    expect(cta.textContent).toContain("Prepare Trade");
    expect(cta.textContent).not.toContain("Prepare Buy");
    expect(screen.getByTestId("ruby-chart-trading-blocked").textContent).toBe(
      "Trading is blocked on your account — this read is for information only.",
    );
  });

  it("(b) ENABLED + READY_NOW: the link to the trade room renders (existing behaviour)", () => {
    mockUseScannerTruth.mockReturnValue(hookState({ truth: truthWithTrading("ENABLED", "You can place demo trades.") }));
    mockStoredRead = FULL;
    render(<RubyChartRead symbol="V75" timeframe="1m" draft={null} canonicalAction="READY_NOW" canonicalDirection="BUY" />);
    const cta = screen.getByTestId("ruby-chart-prepare-trade");
    expect(cta.tagName).toBe("A");
    expect(cta.getAttribute("href")).toContain("/trade-command-room");
    expect(cta.textContent).toContain("Prepare Buy");
    expect(screen.queryByTestId("ruby-chart-trading-blocked")).toBeNull();
  });

  it("(c) BLOCKED + FEED_LIMITED (the screenshot state): tooltip names the trading block, not the feed", () => {
    mockUseScannerTruth.mockReturnValue(hookState({ truth: truthWithTrading("BLOCKED", RESTRICTED) }));
    mockStoredRead = FULL;
    render(<RubyChartRead symbol="V75" timeframe="1m" draft={null} canonicalAction="FEED_LIMITED" />);
    const title = screen.getByTestId("ruby-chart-prepare-trade").getAttribute("title") ?? "";
    expect(title).toBe(RESTRICTED);
    expect(title).not.toContain("live feed");
  });

  it("(d) truth unresolved + READY_NOW: disabled with the pending copy, never a 'blocked' claim", () => {
    mockUseScannerTruth.mockReturnValue(hookState({ truth: null }));
    mockStoredRead = FULL;
    render(<RubyChartRead symbol="V75" timeframe="1m" draft={null} canonicalAction="READY_NOW" canonicalDirection="BUY" />);
    const cta = screen.getByTestId("ruby-chart-prepare-trade");
    expect(cta.tagName).toBe("BUTTON");
    expect(cta.getAttribute("title") ?? "").not.toMatch(/blocked|restricted/i);
    expect(screen.queryByTestId("ruby-chart-trading-blocked")).toBeNull();
  });

  it("(e) DISABLED (read-only mode): the tile's own detail, verbatim — not 'blocked'", () => {
    const RO = "Read-only — trading isn't available from the scanner in this mode.";
    mockUseScannerTruth.mockReturnValue(hookState({ truth: truthWithTrading("DISABLED", RO) }));
    mockStoredRead = FULL;
    render(<RubyChartRead symbol="V75" timeframe="1m" draft={null} canonicalAction="READY_NOW" />);
    expect(screen.getByTestId("ruby-chart-prepare-trade").tagName).toBe("BUTTON");
    expect(screen.getByTestId("ruby-chart-trading-blocked").textContent).toBe(RO);
  });
});
