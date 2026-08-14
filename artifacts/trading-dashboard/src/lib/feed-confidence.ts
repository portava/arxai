import { type ChartFeedStatus, type ChartFeedStatusQuality } from "@workspace/api-client-react";

// ARX Native Chart — Level 3 feed-confidence helper.
//
// Converts the Level 1 `ChartFeedStatus` (embedded in every /api/chart/candles
// response) into a small, UI-friendly verdict. This is the single source of
// truth for HOW honest the chart should be about its own data:
//   - severity drives colour + how prominent the badge becomes
//   - aiUsable is passed straight through (true ONLY when quality is clean) so
//     Level 5 AI overlays can refuse to draw on an unconfirmed feed
//   - suggestFallback marks the cases where the native feed cannot be trusted
//     and the TradingView reference should be offered instead
//
// HONESTY: we never upgrade the backend's own verdict. quality/aiUsable/stale
// come from the contract; we only translate them into copy + severity.

export type FeedSeverity = "clean" | "caution" | "danger" | "unknown";

export interface FeedConfidence {
  /** Short human label for the current quality (e.g. "Clean", "Stale"). */
  statusLabel: string;
  /** Drives badge colour + prominence. */
  severity: FeedSeverity;
  /** Pass-through of the contract's aiUsable (true only when quality is clean). */
  aiUsable: boolean;
  /** One-line human message (prefers the contract's own message/warning). */
  message: string;
  /** True when the feed can't be trusted and a TradingView fallback should show. */
  suggestFallback: boolean;
}

const QUALITY_LABEL: Record<ChartFeedStatusQuality, string> = {
  clean: "Clean",
  delayed: "Delayed",
  stale: "Stale",
  partial: "Partial",
  invalid: "Invalid",
  empty: "No data",
  unavailable: "Unavailable",
};

export function feedConfidence(
  fs: ChartFeedStatus | null | undefined,
): FeedConfidence {
  if (!fs) {
    return {
      statusLabel: "Unknown",
      severity: "unknown",
      aiUsable: false,
      message: "Feed status is unavailable.",
      suggestFallback: true,
    };
  }

  let severity: FeedSeverity;
  switch (fs.quality) {
    case "clean":
      severity = "clean";
      break;
    case "delayed":
    case "partial":
      severity = "caution";
      break;
    case "stale":
    case "invalid":
      severity = "danger";
      break;
    case "empty":
    case "unavailable":
      severity = "unknown";
      break;
    default:
      severity = "unknown";
  }

  // A stale flag is never compatible with a "clean" verdict — downgrade it so a
  // frozen feed can't masquerade as live.
  if (fs.stale && severity === "clean") severity = "caution";

  const statusLabel = QUALITY_LABEL[fs.quality] ?? "Unknown";

  const message =
    fs.message?.trim() ||
    fs.warning?.trim() ||
    (severity === "clean"
      ? "Live feed looks clean and confirmed."
      : "Feed quality is reduced — read with caution.");

  const suggestFallback =
    fs.stale ||
    fs.quality === "stale" ||
    fs.quality === "invalid" ||
    fs.quality === "empty" ||
    fs.quality === "unavailable";

  return {
    statusLabel,
    severity,
    aiUsable: fs.aiUsable,
    message,
    suggestFallback,
  };
}

// ── Resolved-verdict cap (Task #506) ─────────────────────────────────────────
//
// The raw `feedConfidence` verdict is socket-level ("clean bars are arriving").
// Some surfaces (e.g. the Scanner Ruby Chart Read panel) resolve a STRICTER
// verdict by folding the shared scanner truth + the server read-chart result on
// top of the same feed. This caps the raw confidence by that resolved verdict so
// a badge can never claim Clean/AI when the resolved verdict says otherwise:
//   - resolved === true  → keep the raw verdict (confirmed).
//   - resolved === false → never Clean/AI: severity capped to at most "caution",
//     a "clean" label becomes "Unconfirmed", aiUsable forced false.
//   - resolved === null  → unknown verdict: neutral "Checking…" state.
//   - resolved omitted   → no cap (legacy raw-feed behaviour).
export function capConfidence(
  conf: FeedConfidence,
  resolved: boolean | null | undefined,
): FeedConfidence {
  if (resolved === undefined || resolved === true) return conf;
  if (resolved === null) {
    return {
      ...conf,
      severity: "unknown",
      statusLabel: "Checking…",
      aiUsable: false,
    };
  }
  // resolved === false → not confirmed.
  return {
    ...conf,
    severity: conf.severity === "clean" ? "caution" : conf.severity,
    statusLabel: conf.severity === "clean" ? "Unconfirmed" : conf.statusLabel,
    aiUsable: false,
  };
}

// ── Provider trust tiering ────────────────────────────────────────────────
//
// The backend `source` names which data provider actually served the bars:
//   - "mt5_broker"                  → your MT5 broker bridge (primary, top trust)
//   - "deriv"                       → Deriv synthetic volatility indices
//   - "assistant_real:<provider>"   → a third-party fallback (TwelveData, Polygon,
//                                     AlphaVantage, …) used only when the broker
//                                     feed is unavailable for the symbol
// This helper turns that raw id into an honest, human-friendly label + a trust
// tier (drives icon/colour) + a one-line note about freshness/trust. It NEVER
// upgrades trust: a fallback always reads as a fallback.

export type FeedProviderTier = "broker" | "synthetic" | "thirdParty" | "none";

export interface FeedProviderInfo {
  /** Short, human-friendly provider name for the chip (e.g. "MT5 broker"). */
  label: string;
  /** Trust/category tier — drives the chip's provider icon + colour. */
  tier: FeedProviderTier;
  /** One-line plain-English note: what this source means for freshness/trust. */
  trustNote: string;
}

const THIRD_PARTY_NAMES: Record<string, string> = {
  twelve_data: "TwelveData",
  polygon: "Polygon",
  alpha_vantage: "AlphaVantage",
  finnhub: "Finnhub",
};

// A third-party source id may be a single provider ("twelve_data") or a
// composite descriptor ("composite(twelve_data,polygon,alpha_vantage)"). Resolve
// to a precise name when we can, else a generic "Third-party data".
function prettyThirdParty(raw: string): string {
  const composite = raw.match(/^composite\((.*)\)$/i);
  if (composite) {
    const names = composite[1]
      .split(",")
      .map((s) => THIRD_PARTY_NAMES[s.trim()] ?? s.trim())
      .filter(Boolean);
    return names.length === 1 ? names[0]! : "Third-party data";
  }
  return THIRD_PARTY_NAMES[raw] ?? raw;
}

/** Map a backend feed `source` id to an honest provider label + trust tier. */
export function providerInfo(source: string | null | undefined): FeedProviderInfo {
  if (!source) {
    return {
      label: "No feed",
      tier: "none",
      trustNote: "No market-data source is currently serving this chart.",
    };
  }
  if (source === "mt5_broker") {
    return {
      label: "MT5 broker",
      tier: "broker",
      trustNote:
        "Live bars straight from your MT5 broker bridge — the primary, highest-trust source. Matches the prices your broker fills against.",
    };
  }
  if (source === "deriv") {
    return {
      label: "Deriv",
      tier: "synthetic",
      trustNote:
        "Deriv synthetic feed (algorithmic volatility indices). Real-time, but a synthetic instrument — not your broker's live bars.",
    };
  }
  if (source.startsWith("assistant_real")) {
    const sub = source.includes(":") ? source.slice(source.indexOf(":") + 1) : "";
    const label = sub ? prettyThirdParty(sub) : "Third-party data";
    const named = label !== "Third-party data";
    return {
      label,
      tier: "thirdParty",
      trustNote: named
        ? `${label} is a third-party market-data provider, used as a fallback because MT5 broker bars aren't available for this symbol. Prices may be delayed or differ slightly from your broker.`
        : "Third-party market data used as a fallback because MT5 broker bars aren't available for this symbol. Prices may be delayed or differ slightly from your broker.",
    };
  }
  // Unknown provider id — surface it verbatim, treat as fallback-grade trust.
  return {
    label: source,
    tier: "thirdParty",
    trustNote:
      "Fallback market-data source. Prices may be delayed or differ from your broker's live bars.",
  };
}

// ── Trailing-interval gap (Task #780) ────────────────────────────────────────
//
// Inline, always-visible "missing intervals" fragment for the compact feed
// chips (Scanner header chip, Ruby chat feed chip), reusing the SAME
// `ChartFeedStatus.trailingIntervals` the #778 feed-details popover reads — no
// second source of truth. Returns the text to append next to the chip's state:
//   - `undefined` (caller did not opt in / field absent) → null (render nothing)
//   - `null`      (gap unknown — e.g. no candles)        → "—" (honest)
//   - `<= 1`      (current/fresh — the clean baseline)   → null (chip stays quiet)
//   - `>= 2`      (delayed = 2, stale >= 3)              → "N missing"
// A clean live feed reports a trailing gap of 1, so suppressing <=1 keeps the
// count off clean chips and surfaces it only when the feed is actually lagging.
export function formatTrailingGap(
  trailingIntervals: number | null | undefined,
): string | null {
  if (trailingIntervals === undefined) return null;
  if (trailingIntervals === null) return "—";
  if (trailingIntervals <= 1) return null;
  return `${trailingIntervals} missing`;
}

/** Compact "12s ago" style relative time; honest "—" when missing/invalid. */
export function relativeTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return "—";
  const diffMs = Date.now() - t;
  if (diffMs < 0) return "just now";
  const s = Math.floor(diffMs / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}
