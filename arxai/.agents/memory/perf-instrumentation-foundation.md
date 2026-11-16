---
name: Perf instrumentation foundation (PART A)
description: Cross-stack timing rules — admin-only transport, route-label redaction, slow-only flush
---

The perf instrumentation foundation has three invariants that future
changes must not break:

**1. Client-side transport is admin-gated, default OFF.**

`artifacts/trading-dashboard/src/lib/perf.ts` keeps `transportEnabled = false`
at module init. Local timing (markActionStart/End, dev console.warn) always
works, but the 5s flush to `/api/admin/performance/client-action` is
suppressed. Only the admin diagnostics page flips it on (and back off on
unmount). Do NOT call `setPerfTransportEnabled(true)` from any
user-facing surface — non-admin tabs MUST never generate telemetry
traffic, not even traffic the server rejects with 403.

**Why:** Architect-flagged in PART A review. The earlier design relied on
the server 403 to gate non-admins, but that still burns a request per
slow action per non-admin session. Replit traffic is metered and the
audit explicitly forbids "hiding failures behind spinners or background
chatter".

**How to apply:** When wiring perf to a new action, just call
`markActionStart/End` — never check or flip the transport flag.

**2. Only "slow" rows flush; ring buffer is in-memory only.**

Frontend: rows under `SLOW_THRESHOLD_MS` (1000) are dropped after
local timing; only slow rows enter `pendingFlush`. Backend: the ring
buffer is 1024 rows, no persistence. This is intentional — perf data is
a live operator signal; for historical analysis use the structured
`perf:slow` log lines (logger.warn emitted by `recordPerf`).

**Why:** Bound both wire and memory cost. 1024 × ~200 B ≈ 200 KB.

**3. Unmatched-route labels MUST be redacted before they enter the ring buffer or slow-log.**

`artifacts/api-server/src/middlewares/perfTimer.ts` calls
`redactDynamicSegments()` on the raw `req.path` fallback (used when no
Express route matched, e.g. 404). Digit-only, long hex/uuid-like, and
>32-char segments collapse to `:x`, and the label is suffixed
`[unmatched]`. Matched routes use `req.route.path` directly (already a
template like `/positions/:ticket/close`) and skip redaction.

**Why:** Architect-flagged. Raw 404 paths can contain user-supplied
identifiers/tokens and would otherwise show up verbatim in
`logger.warn({perfAction})` slow-log lines, which are shipped to
deployment logs.

**How to apply:** If you change `routeLabel`, never let an unredacted
`req.path` reach `recordPerf`. If you add new sensitive segment shapes,
extend `redactDynamicSegments`, not the call sites.

**Per-action slow thresholds** live in `SLOW_THRESHOLDS` in
`perfRecorder.ts` and mirror the PRD targets in `replit.md` — keep
them in sync when targets move.
