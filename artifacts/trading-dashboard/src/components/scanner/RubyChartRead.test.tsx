import { describe, it, expect, afterEach, vi, beforeEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import type { ScannerTruth } from "@/lib/scannerTruth";
import {
  resolveRubyReadPanelState,
  resolveCappedRubyReadStatus,
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
