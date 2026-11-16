// What GET /api/live-intent/queue lets the client say about how many live
// intents exist.
//
// The route counts only the rows it returns: the newest `limit` intents
// (default 100). `hasMore` says whether older intents exist beyond that
// window, so `counts.total` is the whole queue only when hasMore is false (or
// the window was not full). Otherwise it is a lower bound ("100+").
//
// A non-admin caller gets an empty answer with a scope note and no
// `adminScope` flag: the queue is admin-only operator data, so its zero counts
// are "not shown to you", never "0 intents".
//
// A failed or malformed answer is "could not be loaded", never 0.

export type IntentQueueCount =
  | { kind: "error" }
  | { kind: "not_shown"; note: string }
  | { kind: "exact"; total: number }
  | { kind: "at_least"; total: number };

export function readIntentQueueCount(body: unknown): IntentQueueCount {
  if (!body || typeof body !== "object") return { kind: "error" };
  const b = body as Record<string, unknown>;
  // The server's admin-only answer: a scope note instead of the admin scope.
  if (b.adminScope !== true && typeof b.scopeNote === "string" && b.scopeNote) {
    return { kind: "not_shown", note: b.scopeNote };
  }
  const counts = b.counts as Record<string, unknown> | undefined;
  const total = counts?.total;
  if (typeof total !== "number" || !Number.isFinite(total) || total < 0) return { kind: "error" };
  const limit = typeof b.limit === "number" && Number.isFinite(b.limit) ? b.limit : null;
  // An empty newest window is an empty queue; a window that was not full, or
  // hasMore=false, holds every intent.
  if (total === 0 || b.hasMore === false || (limit !== null && total < limit)) return { kind: "exact", total };
  return { kind: "at_least", total };
}

/** "350" / "100+" — the number as far as the queue answer supports it. */
export function intentCountNumber(c: Extract<IntentQueueCount, { kind: "exact" | "at_least" }>): string {
  return c.kind === "at_least" ? `${c.total}+` : String(c.total);
}
