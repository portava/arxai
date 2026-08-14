/**
 * Shared user-facing label mapper.
 *
 * Normal users must never see raw internal identifiers — function names,
 * route names, DB column names, internal feature-flag keys, stack traces,
 * or JSON payloads — in the UI. This helper maps an internal `key` to a
 * short, plain-English phrase the user can actually understand.
 *
 * Admin/dev surfaces are allowed to render raw identifiers inside a
 * clearly-labeled "Developer details" drawer (collapsed by default).
 * Outside of that, all production UI should funnel through this helper.
 *
 * The mapping is intentionally additive — unknown keys fall back to a
 * neutral "Working on it…" string so a never-before-seen identifier
 * cannot leak through. The corresponding CI guard
 * (`check-no-internal-names-user-ui`) blocks the most common leak shapes
 * (raw camelCase tool names, `/api/` paths in copy, `JSON.stringify(...)`
 * in user-facing JSX) so this helper plus the guard together keep the
 * surface honest over time.
 */

import { DEFAULT_ASSISTANT_NAME } from "@workspace/domain/assistant-name";

// The two name-bearing entries (`aiInstantTradeCommandsEnabled`) are built from
// the resolved per-user assistant name threaded in by the caller, so a user's
// custom name is honoured here exactly like everywhere else. The name defaults
// to the shared default (Eleanor) when no custom name is supplied.
const buildLabels = (assistantName: string = DEFAULT_ASSISTANT_NAME): Record<string, string> => ({
  // Ruby tools / assistant actions
  getMyPerformanceSummary:      "Reviewing your performance",
  getMarketRead:                "Checking this market",
  getOpenPositions:             "Reviewing your open trades",
  getTradeLogs:                 "Reviewing your trade history",
  getScannerSnapshot:           "Reading the scanner",
  fetchScannerData:             "Loading scanner data",
  getMarketQuote:               "Checking the latest price",
  getRiskState:                 "Checking your risk limits",
  getMentorMemory:              "Checking your notes",
  getBridgeStatus:              "Checking your connection",
  getAlerts:                    "Checking your alerts",
  validateLiveTrade:            "Checking trade readiness",
  executeTradeIntent:           "Sending your trade",
  prepareOrder:                 "Preparing the trade plan",

  // Live-trading flags (frequently surfaced as blocker reasons)
  serverLiveExecutionEnabled:   "Live trading dispatch",
  oneClickLiveTradingEnabled:   "One-click trading",
  aiInstantTradeCommandsEnabled:`${assistantName} trade commands`,
  liveSharedApproved:           "Live trading approval",
  liveBrokerExecutionEnabled:   "Live trading dispatch",
  killSwitchActive:             "Kill switch",
  brokerServerConfirm:          "Broker confirmation",
  confirmedAccountNumber:       "Confirmed account number",
  confirmedBrokerName:          "Confirmed broker",
  confirmedServerName:          "Confirmed server",

  // Generic operational verbs
  loadingMarketData:            "Loading market data",
  checkingAccountStatus:        "Checking account status",
  updatingPositions:            "Updating positions",
  syncingChart:                 "Syncing chart",
});

/**
 * Friendly user-facing line for a single live-trading blocker reason
 * (typically a flag key with a boolean value).
 */
const buildBlockerLines = (assistantName: string = DEFAULT_ASSISTANT_NAME): Record<string, string> => ({
  "serverLiveExecutionEnabled=false": "Live trading is not armed yet.",
  "oneClickLiveTradingEnabled=false": "One-click trading is turned off.",
  "aiInstantTradeCommandsEnabled=false": `${assistantName} is not allowed to place trades yet.`,
  "liveSharedApproved=false":         "Your account is not approved for live shared trading.",
  "killSwitchActive=true":            "Kill switch is on — new trades are blocked.",
  "confirmedAccountNumber=missing":   "Account confirmation is missing.",
  "confirmedBrokerName=mismatch":     "Broker confirmation does not match.",
  "confirmedServerName=mismatch":     "Trading server confirmation does not match.",
});

/**
 * Map an internal key (function name, flag name, field name) to a short
 * user-facing label. Unknown keys fall back to "Working on it…" so a
 * never-seen identifier cannot leak straight through to the UI.
 */
export function getFriendlySystemLabel(
  internalKey: string | null | undefined,
  assistantName: string = DEFAULT_ASSISTANT_NAME,
): string {
  if (!internalKey) return "Working on it";
  const direct = buildLabels(assistantName)[internalKey];
  if (direct) return direct;
  // Heuristic fallbacks for unmapped camelCase verbs.
  if (/^get[A-Z]/.test(internalKey))      return "Checking";
  if (/^fetch[A-Z]/.test(internalKey))    return "Loading";
  if (/^validate[A-Z]/.test(internalKey)) return "Checking readiness";
  if (/^execute[A-Z]/.test(internalKey))  return "Sending";
  if (/^sync[A-Z]/.test(internalKey))     return "Syncing";
  return "Working on it";
}

/**
 * Map a structured blocker key (e.g. `serverLiveExecutionEnabled=false`)
 * to a full user-facing sentence explaining what to do. Falls back to a
 * neutral sentence containing the friendly label only — never the raw
 * key — when the exact combination is unknown.
 */
export function getFriendlyBlockerLine(
  blockerKey: string,
  assistantName: string = DEFAULT_ASSISTANT_NAME,
): string {
  const exact = buildBlockerLines(assistantName)[blockerKey];
  if (exact) return exact;
  const [keyOnly] = blockerKey.split("=");
  const label = getFriendlySystemLabel(keyOnly, assistantName);
  return `${label} is not ready yet.`;
}

/**
 * Map a backend error (Error, fetch failure, or unknown thrown value)
 * to a friendly, non-technical sentence. Strips stack traces, JSON
 * payloads, and route names — those belong in a Developer details
 * drawer, never in the user's chat or toast.
 */
/**
 * Convert a raw broker/internal reason string into something a regular
 * user can read. Handles three shapes:
 *   - UPPER_SNAKE_CASE  -> "Upper snake case"
 *   - camelCase / PascalCase -> "Camel case"
 *   - already-prose strings -> returned unchanged
 *   - null/empty -> "Working on it"
 * Never leaks raw identifiers, route names, or JSON blobs to the user.
 */
export function humanizeReason(raw: string | null | undefined): string {
  if (!raw) return "Working on it";
  const trimmed = raw.trim();
  if (!trimmed) return "Working on it";
  // Strip route names / JSON blobs / stack frames — those should never
  // reach normal users.
  if (/\/api\//.test(trimmed) || /^\s*[{\[]/.test(trimmed) || /\bat\s+[A-Za-z_$][\w$]*\s*\(/.test(trimmed)) {
    return "Working on it";
  }
  // UPPER_SNAKE_CASE — convert to sentence case.
  if (/^[A-Z][A-Z0-9_]+$/.test(trimmed)) {
    const spaced = trimmed.replace(/_/g, " ").toLowerCase();
    return spaced.charAt(0).toUpperCase() + spaced.slice(1);
  }
  // camelCase / PascalCase — split on capital letters.
  if (/^[a-zA-Z]+([A-Z][a-z]+)+$/.test(trimmed)) {
    const spaced = trimmed.replace(/([A-Z])/g, " $1").trim().toLowerCase();
    return spaced.charAt(0).toUpperCase() + spaced.slice(1);
  }
  // Already looks like prose — leave as-is.
  return trimmed;
}

export function getFriendlyErrorMessage(err: unknown, fallback = "That request didn't go through. Please try again."): string {
  if (!err) return fallback;
  const raw = err instanceof Error ? err.message : typeof err === "string" ? err : "";
  if (!raw) return fallback;
  const looksTechnical =
    /\bat\s+[A-Za-z_$][\w$]*\s*\(/.test(raw)  // stack frame
    || /\/api\//.test(raw)                     // route name
    || /^\s*[{\[]/.test(raw)                   // JSON-ish blob
    || /HTTP\s+\d{3}/.test(raw)                // status code
    || /TypeError|ReferenceError|SyntaxError/.test(raw);
  if (looksTechnical) return fallback;
  return raw;
}
