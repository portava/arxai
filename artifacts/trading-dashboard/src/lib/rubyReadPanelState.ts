// ── Ruby Chart Read — one derived panel state (Task #506) ────────────────────
//
// The Scanner's Ruby Chart Read panel has three sub-surfaces that USED to each
// read a different verdict off the SAME underlying query and so could render
// mutually contradictory claims at once:
//
//   - badge  → raw feedStatus (socket-level "clean bars are arriving")
//   - banner → resolved scanner-truth level (stricter than raw feed quality)
//   - body   → the server read-chart `basis`/`gated` verdict
//
// Because all three describe the same chart from a different angle, the
// screenshot bug was: badge "Clean · AI" + banner "Feed not confirmed" + body
// "cannot verify chart data" — all true simultaneously, and the banner header
// ("not confirmed") even sat next to a positive reason ("valid for a live read")
// because the level downgrade and the reason text described different things.
//
// This pure resolver folds the shared `useScannerTruth` resolution together with
// the server read-chart response into ONE verdict. Every sub-surface derives
// from this single object, so the contradiction is structurally impossible. It
// is deliberately framework-free so the contradiction matrix can be tested
// exhaustively without rendering.

import type { ReadLevel } from "./scannerTruth";
import type { RubyReadStatus } from "./scannerActionability";
import { DEFAULT_ASSISTANT_NAME } from "@workspace/domain/assistant-name";

export type RubyReadVerdict =
  | "confirmed"
  | "structural_only"
  | "not_confirmed"
  | "unknown";

/** Display-only read tier (Task #602) — never an execution input. */
export type RubyReadLayer = "FULL" | "STRUCTURAL_ONLY" | "INSUFFICIENT";

/** The slice of the server read-chart response this panel reads. */
export interface RubyReadServerState {
  gated?: boolean;
  dataQuality?: "ok" | "insufficient";
  basis?: string;
  headline?: string;
  blockedReason?: string;
  /**
   * Display-only read layer (Task #602). `STRUCTURAL_ONLY` means a directional
   * structural read is available but the exact entry/stop/target are withheld
   * because the live feed isn't confirmed — a DOWNGRADE for the badge/header cap,
   * never a "feed not confirmed" hard block.
   */
  readLayer?: RubyReadLayer;
  /** The exact live trade setup is withheld (true on a STRUCTURAL_ONLY read). */
  liveSetupWithheld?: boolean;
}

/**
 * The full server read-chart response. Extends the honesty slice
 * (`RubyReadServerState`) with the directional read fields the panel body
 * renders. Lives here (not in the component) so the page-level shared read store
 * and the header cap can both type the lifted read without importing a
 * component module.
 */
export interface ChartRead extends RubyReadServerState {
  bias?: string;
  confidence?: string;
  why?: string;
  supportZone?: string;
  resistanceZone?: string;
  buyCondition?: string;
  sellCondition?: string;
  invalidation?: string;
  riskNote?: string;
  htfBias?: string;
  cautions?: string[];
  disclaimer?: string;
  /**
   * Client stamp (ms epoch) of when this read was fetched, set by the panel that
   * performed the fetch. The read is lifted to a page-level store and replayed
   * for as long as the symbol/timeframe stays selected, so surfaces MUST be able
   * to show how old the replayed read is instead of rendering a minutes-old read
   * identically to a fresh one. Absent ⇒ age unknown (never assume "just now").
   */
  receivedAt?: number;
}

/** The Ruby read status capped against the server read + an optional override. */
export interface CappedRubyRead {
  status: RubyReadStatus;
  /** The reason for any downgrade (server-supplied when available). */
  reason: string | null;
}

/**
 * Reconcile the header's Ruby cell with the Ruby Chart Read panel (Task #600).
 *
 * The contract's `consolidated.rubyReadStatus` is the BASE read capability
 * derived from the shared truth (no server read folded in). Once the panel runs
 * a server read — or a parent supplies an `aiUsable` override — the result can
 * only LOWER the read, never raise it. Both the header cell and the panel call
 * this with the SAME (base, read, override) so they can never disagree.
 *
 * Monotonic / downgrade-only:
 *   - NO_READ      → stays NO_READ (no readable data at all).
 *   - FULL_READ    → LIMITED_READ when the server marks the read
 *                    gated/insufficient OR the override says the feed isn't
 *                    usable; otherwise stays FULL_READ.
 *   - LIMITED_READ → stays LIMITED_READ (surfaces the server reason if any).
 */
export function resolveCappedRubyReadStatus(
  base: RubyReadStatus,
  read: RubyReadServerState | null,
  aiUsableOverride?: boolean,
  assistantName: string = DEFAULT_ASSISTANT_NAME,
): CappedRubyRead {
  if (base === "NO_READ") return { status: "NO_READ", reason: null };

  const overrideBlocks = aiUsableOverride === false;
  // A STRUCTURAL_ONLY read is a DOWNGRADE (direction readable, exact setup
  // withheld) — it caps a FULL_READ to LIMITED_READ exactly like a gated /
  // insufficient read, even though `gated` is false and dataQuality is "ok".
  const readDowngraded =
    !!read &&
    (read.gated === true ||
      read.dataQuality === "insufficient" ||
      read.readLayer === "STRUCTURAL_ONLY");
  const serverReason = readDowngraded
    ? read?.blockedReason ?? read?.headline ?? null
    : null;

  if (base === "FULL_READ") {
    if (overrideBlocks || readDowngraded) {
      return {
        status: "LIMITED_READ",
        reason:
          serverReason ??
          `The live feed isn't fully confirmed — ${assistantName} reads with caution.`,
      };
    }
    return { status: "FULL_READ", reason: null };
  }

  // base === "LIMITED_READ"
  return { status: "LIMITED_READ", reason: serverReason };
}

export interface RubyReadPanelInputs {
  /**
   * Resolved shared-truth analysis level (from `useScannerTruth`); `null` while
   * the truth is still unresolved/loading.
   */
  truthLevel: ReadLevel | null;
  /**
   * Shared-truth downgrade reason. Only honest about a NON-full feed — at level
   * "full" it reads "Live data — valid for a live read", so it must never be
   * surfaced under a "not confirmed" header.
   */
  truthReason: string | null;
  /**
   * Optional parent override of the feed verdict (e.g. an ARXNativeChart
   * `onChartContextChange`). `undefined` means no override.
   */
  aiUsableProp: boolean | undefined;
  /** The server read-chart response once a read has run; `null` before. */
  read: RubyReadServerState | null;
}

export interface RubyReadPanelState {
  /** The single panel verdict every sub-surface derives from. */
  verdict: RubyReadVerdict;
  /** The banner renders iff true (verdict === "not_confirmed"). */
  feedNotConfirmed: boolean;
  /**
   * Reason appended to the banner — describes the SAME dimension that drove the
   * downgrade, so the header and reason can never contradict each other.
   */
  reason: string | null;
  /**
   * What the badge may claim: `true` → clean/AI allowed, `false` → never
   * clean/AI, `null` → unknown (verdict not yet resolved).
   */
  badgeAiUsable: boolean | null;
  /**
   * Value forwarded to the read-chart endpoint. `undefined` means "unknown" →
   * the server falls back to its own gate.
   */
  reportedAiUsable: boolean | undefined;
}

export function resolveRubyReadPanelState(
  input: RubyReadPanelInputs,
): RubyReadPanelState {
  const { truthLevel, truthReason, aiUsableProp, read } = input;

  const truthKnown = truthLevel != null;
  // The read is "usable" only when the shared truth is fully actionable. Any
  // downgrade (limited / historical_only / blocked) means feed-not-confirmed.
  const truthActionable = truthLevel === "full";

  // A parent override wins; otherwise use the resolved shared truth. We only
  // know a verdict once the truth is resolved (or a parent supplies one).
  const effectiveAiUsable: boolean | null =
    aiUsableProp != null ? aiUsableProp : truthKnown ? truthActionable : null;

  // Once a read has run, the server marks unconfirmed/gated reads insufficient —
  // this is authoritative for the body, so it must also drive the badge/banner.
  const readInsufficient =
    !!read && (read.gated === true || read.dataQuality === "insufficient");
  // A STRUCTURAL_ONLY read (Task #602) is its OWN verdict: a directional read IS
  // available, but the exact live setup is withheld. It takes precedence over a
  // generic "not confirmed" (it's the more specific, more honest state) and over
  // "confirmed" (the badge must never claim clean/AI while the setup is withheld).
  const structuralOnly = read?.readLayer === "STRUCTURAL_ONLY";

  let verdict: RubyReadVerdict;
  if (structuralOnly) {
    verdict = "structural_only";
  } else if (readInsufficient || effectiveAiUsable === false) {
    verdict = "not_confirmed";
  } else if (effectiveAiUsable === true) {
    verdict = "confirmed";
  } else {
    verdict = "unknown";
  }

  const feedNotConfirmed = verdict === "not_confirmed";

  // The reason MUST describe the same dimension that drove the downgrade so the
  // banner is never self-contradictory ("not confirmed" + "valid for a live
  // read"). Truth's reason is only honest about a non-full feed, so use it ONLY
  // when the truth itself is downgraded; when the truth is full/unknown but the
  // server couldn't verify, the server's own reason is the real driver.
  let reason: string | null = null;
  if (verdict === "structural_only") {
    // The withheld-setup reason the server supplied is the authoritative driver.
    reason = read?.blockedReason ?? read?.headline ?? null;
  } else if (feedNotConfirmed) {
    if (truthKnown && !truthActionable) {
      reason = truthReason;
    } else if (readInsufficient) {
      reason = read?.blockedReason ?? read?.headline ?? null;
    }
  }

  // What we tell the endpoint: prefer an explicit override, else the resolved
  // verdict. This is read-independent (sent before any read has run).
  const reportedAiUsable: boolean | undefined =
    aiUsableProp != null ? aiUsableProp : truthKnown ? truthActionable : undefined;

  // The badge may claim clean/AI only on a fully-confirmed read. A
  // structural-only read is a downgrade → never clean/AI.
  const badgeAiUsable: boolean | null =
    verdict === "confirmed"
      ? true
      : verdict === "not_confirmed" || verdict === "structural_only"
        ? false
        : null;

  return { verdict, feedNotConfirmed, reason, badgeAiUsable, reportedAiUsable };
}

/**
 * The badge verdict for a feed-confidence chip on a NON-read surface — the
 * live-chart header and the trade-decision panels (Trade Command Room, "Trade
 * from chart") — which only have the shared `useScannerTruth` level for the
 * active symbol/timeframe: no server read-chart response and no parent override.
 *
 * It is exactly what RubyChartRead passes as `aiUsableResolved` before any read
 * has run (full ⇒ true, downgraded ⇒ false, unresolved ⇒ null), so these chips
 * can never claim Clean/AI when the resolved truth is downgraded or still
 * unresolved — without each surface re-deriving the cap.
 */
export function resolveFeedBadgeVerdict(
  truthLevel: ReadLevel | null,
): boolean | null {
  return resolveRubyReadPanelState({
    truthLevel,
    truthReason: null,
    aiUsableProp: undefined,
    read: null,
  }).badgeAiUsable;
}
