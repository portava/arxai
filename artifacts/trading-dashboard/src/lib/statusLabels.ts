// Central mapper for user-facing labels of raw status / reason codes.
// Used by Recent Scanner Trades, Trade Tickets, MT5 Setup, and any other
// surface that previously rendered backend constants directly.
//
// Admin/debug surfaces should continue to render the raw value (and may
// call rawStatusLabel only as a fallback for unknown codes).

const STATUS_LABELS: Record<string, string> = {
  // Demo lifecycle
  FILLED_DEMO: "Filled",
  SENT_TO_MT5_DEMO: "Sent to MT5",
  DEMO_APPROVED: "Approved",
  USER_CONFIRMATION_REQUIRED: "Awaiting confirmation",

  // Live lifecycle
  FILLED_LIVE: "Filled",
  SENT_TO_MT5_LIVE: "Sent to broker",
  LIVE_APPROVED: "Approved",
  LIVE_REJECTED: "Rejected by broker",

  // Common terminal
  REJECTED: "Rejected",
  FAILED: "Failed",
  BLOCKED: "Blocked",
  CANCELLED: "Cancelled",

  // Common bridge / EA reasons
  REJECTED_READ_ONLY_MODE_ACTIVE: "Bridge read-only",
  HEARTBEAT_STALE: "Bridge stale",
  NOT_VERIFIED_DEMO: "Demo not verified",
  BRIDGE_NOT_CONNECTED: "Bridge disconnected",
  USER_NOT_CONFIRMED: "User confirmation required",
  MASTER_ACCOUNT_EXPOSURE_LIMIT_REACHED: "Exposure limit reached",
  MASTER_BRIDGE_EA_VERSION_TOO_OLD: "EA needs update",
  MASTER_BRIDGE_NOT_READY: "Bridge not ready",
  LIVE_BROKER_EXECUTION_DISABLED: "Live trading disabled",
  DAILY_LOSS_CAP_REACHED: "Daily loss limit reached",
  SYMBOL_NOT_ALLOWED: "Symbol not in allowlist",
  STOP_LOSS_REQUIRED: "Stop loss required",
  LOT_EXCEEDS_MAX: "Lot exceeds maximum",
  KILL_SWITCH_ACTIVE: "Kill switch active",
  CLOSE_ONLY_MODE: "Close-only mode",
  QUEUE_PAUSED: "Trading paused",
  COOLDOWN_ACTIVE: "Cooldown in effect",
  DUPLICATE_LIVE_IDEMPOTENCY_KEY: "Duplicate order",
};

const TONE_BY_BUCKET: Record<"good" | "pending" | "bad" | "neutral", string> = {
  good: "bg-emerald-500/20 text-emerald-300",
  pending: "bg-sky-500/20 text-sky-300",
  bad: "bg-rose-500/20 text-rose-300",
  neutral: "bg-slate-500/20 text-slate-300",
};

function bucketForStatus(s: string): "good" | "pending" | "bad" | "neutral" {
  if (s.startsWith("FILLED")) return "good";
  if (s.startsWith("SENT_TO_MT5") || s === "DEMO_APPROVED" || s === "LIVE_APPROVED") return "pending";
  if (s === "USER_CONFIRMATION_REQUIRED") return "pending";
  if (s === "REJECTED" || s === "FAILED" || s === "BLOCKED" || s === "CANCELLED" || s === "LIVE_REJECTED") return "bad";
  return "neutral";
}

/** User-facing label. Unknown codes get a Title-Case fallback. */
export function statusLabel(code: string | null | undefined): string {
  if (!code) return "—";
  if (STATUS_LABELS[code]) return STATUS_LABELS[code];
  // Fallback: turn UPPER_SNAKE into Title Case for unknown codes so we
  // never leak a raw constant when the mapper drifts.
  return code
    .toLowerCase()
    .split(/[_\s]+/)
    .map((w) => (w ? w[0]!.toUpperCase() + w.slice(1) : ""))
    .join(" ");
}

/** Friendly tone class for a status badge. */
export function statusTone(code: string | null | undefined): string {
  if (!code) return TONE_BY_BUCKET.neutral;
  return TONE_BY_BUCKET[bucketForStatus(code)];
}

/** Friendly label for a reason/blocker code (same dictionary, same fallback). */
export function reasonLabel(code: string | null | undefined): string {
  return statusLabel(code);
}
