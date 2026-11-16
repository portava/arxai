// Follow-up for a Eleanor chat command that the server dispatched to the broker.
//
// The command route answers ok:true + commandId once the order is DISPATCHED,
// not filled ("I'll confirm here as soon as it's filled"). This polls the same
// /api/me/live/command-status/:commandId endpoint the live trade ticket and
// the scanner chart use, with the same honest rules: "filled" only on a
// LIVE_FILLED carrying a real broker ticket (or LIVE_CLOSED), a CLOSE only
// counts as closed when the server's closeConfirmed verdict is true, and no
// terminal answer inside the window stays "pending" — never a fake fill.

export type LiveCommandStatus = {
  status?: string | null;
  commandType?: string | null;
  brokerTicket?: string | null;
  fillPrice?: number | string | null;
  mt5Retcode?: number | null;
  brokerMessage?: string | null;
  rejectionReason?: string | null;
  closeConfirmed?: boolean | null;
};

export type EleanorCommandOutcome =
  | { phase: "filled"; brokerTicket: string | null; fillPrice: number | string | null; isClose: boolean }
  | { phase: "rejected"; status: string; reason: string | null }
  | { phase: "pending" };

const REJECTED = new Set(["LIVE_REJECTED", "LIVE_FAILED", "LIVE_EXPIRED"]);

/** Classify one status row; null means "not terminal yet, keep waiting". */
export function classifyCommandStatus(s: LiveCommandStatus | null): EleanorCommandOutcome | null {
  if (!s || !s.status) return null;
  const isClose = s.commandType === "CLOSE_LIVE_POSITION";
  if (REJECTED.has(s.status)) {
    return { phase: "rejected", status: s.status, reason: s.brokerMessage ?? s.rejectionReason ?? null };
  }
  if (isClose) {
    if (s.closeConfirmed === true) {
      return { phase: "filled", brokerTicket: s.brokerTicket ?? null, fillPrice: s.fillPrice ?? null, isClose: true };
    }
    return null; // a LIVE_FILLED close without closeConfirmed is not proof yet
  }
  if ((s.status === "LIVE_FILLED" && s.brokerTicket) || s.status === "LIVE_CLOSED") {
    return { phase: "filled", brokerTicket: s.brokerTicket ?? null, fillPrice: s.fillPrice ?? null, isClose: false };
  }
  return null;
}

export async function pollEleanorCommandOutcome(
  commandId: string,
  opts: {
    fetchImpl?: typeof fetch;
    sleep?: (ms: number) => Promise<void>;
    now?: () => number;
    windowMs?: number;
    isCancelled?: () => boolean;
  } = {},
): Promise<EleanorCommandOutcome | null> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = opts.now ?? Date.now;
  const deadline = now() + (opts.windowMs ?? 20_000);
  let delay = 700;
  while (now() < deadline) {
    await sleep(delay);
    delay = Math.min(delay + 400, 2500);
    if (opts.isCancelled?.()) return null;
    let s: LiveCommandStatus | null = null;
    try {
      const resp = await fetchImpl(`/api/me/live/command-status/${encodeURIComponent(commandId)}`, { credentials: "include" });
      if (resp.ok) s = (await resp.json()) as LiveCommandStatus;
    } catch {
      // transient — keep polling until the deadline
    }
    if (opts.isCancelled?.()) return null;
    const outcome = classifyCommandStatus(s);
    if (outcome) return outcome;
  }
  return { phase: "pending" };
}

export function eleanorCommandOutcomeText(o: EleanorCommandOutcome): string {
  if (o.phase === "filled") {
    if (o.isClose) return `Closed${o.brokerTicket ? ` — ticket ${o.brokerTicket}` : ""}${o.fillPrice != null ? ` at ${o.fillPrice}` : ""}.`;
    return `Filled${o.fillPrice != null ? ` at ${o.fillPrice}` : ""}${o.brokerTicket ? ` — ticket ${o.brokerTicket}` : ""}.`;
  }
  if (o.phase === "rejected") {
    return `The broker didn't take it (${o.status.replace(/^LIVE_/, "").toLowerCase()})${o.reason ? `: ${o.reason}` : ""}. Nothing was opened or changed.`;
  }
  return "No broker confirmation yet — it's still pending. Check Open Positions for the final result.";
}
