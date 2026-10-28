// Status Command Center "Heartbeat" row. The age comes from the last
// /api/mt5/diagnostic-summary poll (every 12 s) and is not re-counted between
// polls, so it is always stated "as of" that poll's server time, and the row
// says whose EA it describes.
import type { BridgeDiagnosticSummary } from "@/assistant/runtimeContextTypes";

function utcClock(iso: string | null | undefined): string | null {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(t) ? `${new Date(t).toISOString().slice(11, 19)} UTC` : null;
}

export function heartbeatLine(
  bridge: Pick<BridgeDiagnosticSummary, "heartbeatPresent" | "heartbeatAgeSeconds" | "fetchedAt" | "heartbeatScope"> | null | undefined,
): string {
  if (!bridge) return "not checked — bridge summary unavailable";
  const scope = bridge.heartbeatScope === "your_connection" ? "your EA"
    : bridge.heartbeatScope === "platform" ? "platform bridge, not your account"
    : null;
  if (bridge.heartbeatScope === "no_connection") return "none — you have no MT5 EA connection";
  const asOf = utcClock(bridge.fetchedAt);
  const age = bridge.heartbeatAgeSeconds;
  const ageText = age == null ? "age unknown" : `${age}s old`;
  const when = asOf ? ` as of ${asOf}` : "";
  const who = scope ? `, ${scope}` : "";
  return bridge.heartbeatPresent
    ? `present (${ageText}${when}${who})`
    : `absent (${age == null ? "no heartbeat received" : `last ${ageText}`}${when}${who})`;
}
