// Watchlist row signal badge. The server scans the latest 1m bars and sends
// signalStatus + signalAsOf; a BUY/SELL/WAIT badge is shown only for a scan of
// current bars (OK, or DELAYED with a "delayed" note). Anything else — no
// data, stale bars, provider error, or a server that sent no status — is said
// plainly and never shown as a signal (the client may only downgrade).
export interface WatchlistSignalFields {
  signal?: string | null;
  confidence?: number | null;
  signalStatus?: string | null;
  signalAsOf?: string | null;
}

export type WatchlistSignalBadge =
  | { kind: "signal"; text: string; direction: string; title: string }
  | { kind: "status"; text: string; title: string };

function utc(iso: string | null | undefined): string | null {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(t) ? `${new Date(t).toISOString().slice(0, 16).replace("T", " ")} UTC` : null;
}

export function watchlistSignalBadge(it: WatchlistSignalFields): WatchlistSignalBadge | null {
  const asOf = utc(it.signalAsOf);
  const status = it.signalStatus ?? null;
  if ((status === "OK" || status === "DELAYED") && it.signal) {
    const conf = it.confidence != null ? ` ${it.confidence}%` : "";
    return {
      kind: "signal", direction: it.signal,
      text: `${it.signal}${conf}${status === "DELAYED" ? " (delayed)" : ""}`,
      title: `Strategy scan of 1m bars${asOf ? ` up to ${asOf}` : ""}${status === "DELAYED" ? " — feed is delayed" : ""}`,
    };
  }
  if (status === "STALE_DATA") {
    return { kind: "status", text: "Stale data", title: `No signal: newest 1m bar is old${asOf ? ` (${asOf})` : ""}` };
  }
  if (status === "NO_DATA") return { kind: "status", text: "No data", title: "No signal: no 1m bars were available to scan" };
  if (status === "UNAVAILABLE") return { kind: "status", text: "Scan unavailable", title: "No signal: market data could not be read" };
  if (it.signal) return { kind: "status", text: "Unverified", title: "Signal age was not reported, so it is not shown" };
  return null;
}
