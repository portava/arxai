// Deterministic offline network guard for in-process app tests.
//
// WHY THIS EXISTS
//   Some read paths (e.g. the Ruby chart read) fan out to many third-party
//   market/news providers (TwelveData, Polygon, Finnhub, AlphaVantage, NewsAPI,
//   …) for enrichment. Those calls are rate-limited GLOBALLY per API key, so in
//   a batch run the quota is already drained by the live workflow and other
//   lanes. A provider then returns a NON-deterministic mix of 200s and 429s, and
//   two reads taken milliseconds apart can receive DIFFERENT enrichment data —
//   which silently breaks byte-for-byte parity assertions. The test passes in
//   isolation (fresh quota → both reads succeed identically) but flakes in batch.
//
// WHAT IT DOES
//   Replaces `globalThis.fetch` so that ONLY the in-process harness
//   (127.0.0.1 / localhost / relative URLs) is reachable. Every external host is
//   intercepted and answered with a SINGLE, deterministic "provider unavailable"
//   response (HTTP 503, empty JSON) WITHOUT touching the network. The read path's
//   existing fail-soft handling (it already tolerates a 429/non-ok by degrading
//   to an honest empty result) then produces the SAME offline result on every
//   run — identical across both surfaces under test, identical in isolation and
//   in batch, and never dependent on a live provider's rate limit.
//
//   The real (original) fetch is NEVER invoked for an external host. A caller
//   proves offline-ness POSITIVELY by asserting the guard was actually exercised
//   — `attemptCount() > 0` with a non-empty `blockedHosts()` — which means the
//   read path's enrichment fanout was intercepted here instead of hitting the
//   network. (If a deterministic fixture such as an in-memory candle push is
//   missing, the read degrades to an honest INSUFFICIENT state — surfacing as a
//   clear, deterministic assertion failure, never a provider/rate-limit error.)
//
//   SCOPE LIMIT (important): this guard only observes `globalThis.fetch`. It
//   cannot detect — and does NOT claim to detect — a call that bypasses it via a
//   captured pre-install fetch reference or a non-fetch transport (node:http,
//   undici). Proving that NOTHING at all reached the real network is a separate
//   concern, done out-of-band with a pass-through fetch logger preloaded via
//   NODE_OPTIONS. Do not add an "escapedCount()"-style API here that pretends to
//   measure real network egress from inside the fetch wrapper — it would be
//   structurally vacuous (the wrapper never forwards external requests).
//
// SAFETY: test-only. Never imported by application code. Affects only the calling
// test process and is fully reversible via `restore()`.

export interface NetworkGuardHandle {
  /** External hosts the guard intercepted (deduped, sorted) — for reporting. */
  blockedHosts(): string[];
  /** Total external fetch attempts the guard intercepted. */
  attemptCount(): number;
  /** Restore the original global fetch. Idempotent. */
  restore(): void;
}

// 127.0.0.1, ::1, and localhost (any port) are the in-process harness — allowed.
const LOCAL_HOST_RE = /^(127\.0\.0\.1|localhost|\[?::1\]?)(:\d+)?$/i;

function extractUrl(input: unknown): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  if (input && typeof input === "object" && "url" in input) {
    return String((input as { url: unknown }).url);
  }
  return String(input);
}

/**
 * Install the offline guard over `globalThis.fetch`. Call BEFORE exercising any
 * provider-backed read, and `restore()` when done (ideally in a `finally`).
 */
export function installNoExternalNetworkGuard(): NetworkGuardHandle {
  const originalFetch = globalThis.fetch;
  const blocked = new Set<string>();
  let attempts = 0;
  let active = true;

  const guarded = (async (input: unknown, init?: unknown): Promise<Response> => {
    const url = extractUrl(input);
    type FetchArgs = Parameters<typeof originalFetch>;
    let host = "";
    try {
      host = new URL(url).host;
    } catch {
      // Relative URL → resolved against the in-process server; allow it.
      return originalFetch(input as FetchArgs[0], init as FetchArgs[1]);
    }
    if (LOCAL_HOST_RE.test(host)) {
      return originalFetch(input as FetchArgs[0], init as FetchArgs[1]);
    }
    // External host: never reaches the network. Answer deterministically with a
    // provider-unavailable response the read path already degrades on.
    attempts++;
    blocked.add(host);
    return new Response(
      JSON.stringify({ status: "error", reason: "OFFLINE_GUARD_BLOCKED", values: [] }),
      { status: 503, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;

  globalThis.fetch = guarded;

  return {
    blockedHosts: () => Array.from(blocked).sort(),
    attemptCount: () => attempts,
    restore: () => {
      if (!active) return;
      active = false;
      globalThis.fetch = originalFetch;
    },
  };
}
