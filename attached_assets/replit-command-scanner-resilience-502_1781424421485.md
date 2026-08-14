# COMMAND — SCANNER/HEALTH RESILIENCE: NO RAW JSON PARSE, FIND THE 502

Read this entire command before changing anything. Two parts: (A) make every scanner / trade-health / smart-layer fetch fail gracefully instead of throwing raw parser/HTTP errors at the user, and (B) find and fix why that endpoint is 502-ing. Part A is the user-facing bug and must ship even if Part B needs a follow-up. Do not mark complete until the COMPLETION STANDARD passes.

## THE PROBLEM (verified on live screenshots, Jun 13, 11:47 AM)

On /market-scanner (Broad Scan), with the backend degraded:

1. "Scanner error — SyntaxError: Failed to execute 'json' on 'Response': Unexpected end of JSON input" — a raw JS parser exception shown to the user. Cause: a fetch site calls `response.json()` on an EMPTY body (a 502/empty response), so `JSON.parse("")` throws.
2. "HTTP 502" rendered as the Recent Scanner Trades content. Cause: a raw fetch site throws `new Error(`HTTP ${r.status}`)` and the component prints the raw message.
3. "Trade-health is momentarily unavailable" + "Smart layers are momentarily unavailable" at the same moment, same symbol — same degraded backend.

ROOT CAUSE OF THE UGLY TEXT (already traced in source — do not re-litigate):
- The generated Orval mutator `lib/api-client-react/src/custom-fetch.ts` is ALREADY correct: it checks `response.ok`, parses empty bodies safely (returns null on `""`), and throws typed `ApiError` / `ResponseParseError` with clean messages — never a bare `SyntaxError`.
- BUT the scanner surfaces bypass it with raw `fetch().json()`. Confirmed example: `components/scanner/RecentScannerTrades.tsx` lines ~50–52:
  `const r = await fetch(`${BASE}/api/me/demo-commands?limit=100`, …); if (!r.ok) throw new Error(`HTTP ${r.status}`); const j = await r.json();`
  That raw pattern is the source of both the "HTTP 502" text and (at the scanner's own raw fetch) the "Unexpected end of JSON input".

So this is NOT a truth-architecture regression — the honesty layer worked (V75 correctly showed LAST-KNOWN / Historical only / Limited read). It is raw fetch sites + a flaky backend route.

## NON-NEGOTIABLE RULES

- Read-side / resilience only. Do not change live execution, gates, the truth brain, EA, bridge, attribution, or permissions.
- Do not weaken any error reporting that matters operationally — admins still need real diagnostics; this is about not throwing raw parser/HTTP strings into the USER-facing card.
- No fabricated data on failure. A failed scanner/health fetch shows an honest "temporarily unavailable" state, never invented results, never a stale value styled as fresh.
- No internal strings, stack traces, or raw `JSON.parse` exceptions in user-facing text.

## PART A — KILL RAW JSON PARSING ON SCANNER/HEALTH/SMART-LAYER FETCHES

### A1. Inventory the raw fetch sites
Find every `fetch(`/`response.json()` call (NOT going through `customFetch`/the generated hooks) under the scanner, trade-health, and smart-layer surfaces. Start here and expand by grep:
- `components/scanner/RecentScannerTrades.tsx`
- `pages/market-scanner.tsx` (the scan + scanner-error path that prints "Unexpected end of JSON input")
- any scanner component doing its own `fetch().json()`
- the trade-health and smart-layer fetch paths (`useAiChartOverlays.ts`, anything feeding "Trade Health" / "Smart layers")
Grep patterns: `fetch(` with a following `.json()`, and `.json()` calls in `components/scanner`, `hooks`, and `lib` that are not the generated client. Produce a short list of each site (file + line + endpoint).

### A2. Route them through a safe reader
For each raw site, replace the hand-rolled `fetch(...).then(r => r.json())` with one of:
- PREFERRED: the generated Orval hook/function for that endpoint if one exists (it already uses the hardened mutator). E.g. if `/api/me/demo-commands` has a generated hook, use it.
- ELSE: a single shared safe-reader helper (create `lib/api/safeJson.ts` if none exists) that:
  - awaits `res.text()` first, returns a typed result `{ ok: true, data } | { ok: false, status, kind: "http" | "empty" | "parse" | "network", message }`,
  - treats empty body as `kind:"empty"` (NOT a parse throw),
  - only `JSON.parse`s non-empty text, catching parse errors as `kind:"parse"`,
  - never throws for control flow — callers branch on the result.
  Mirror the semantics the mutator already uses (`stripBom`, empty-as-null, `res.ok` first) so behavior is consistent app-wide.

### A3. Honest degraded UI on each surface
Each affected component renders a clean state when the read fails:
- Scanner error card: instead of the raw exception, show e.g. "Scanner is temporarily unavailable — retrying." with the existing retry/refresh affordance. Keep the real error in `console.debug`/the perf observer for operators, NOT in the visible card.
- Recent Scanner Trades: on failure show "Couldn't load recent scanner trades — try again", not "HTTP 502".
- Trade Health / Smart layers already show "momentarily unavailable — your positions and trading are unaffected" (that wording is good and truthful) — confirm it triggers on the typed-failure result, not on a thrown raw error, and that it never blanks the surrounding chart.
- All retriable: a refresh/auto-retry path exists and works once the backend recovers.

### A4. Cosmetic-truth residual (from the same screenshots)
- "Overlays: verified" must not render while smart-layers/overlay data is in the unavailable state. When the layer data is degraded, the overlay badge shows a degraded/neutral state (e.g. "Overlays: unavailable" or hidden), so a human never sees "verified" directly above "Smart layers are momentarily unavailable." This is the overlay handshake vs layer-data split — make the badge defer to the degraded state.
- Opportunity-map precision: a symbol in the "No live data" state must not be folded into a "Nothing tradeable right now" verdict as if it were evaluated and rejected. It should read as not-yet-readable (awaiting data), distinct from "evaluated, no clean setup". Fix the aggregation label only — no data/verdict change.

## PART B — ROOT-CAUSE THE 502

The empty/502 response is the actual backend fault. Investigate and fix the most likely cause:

### B1. Identify the failing route(s)
From the surfaces above, the suspect endpoints are the scanner scan route (`routes/scanner.ts`) and the recent-trades/health routes (`routes/meTradeHealth.ts`, `routes/meChartSmartLayers.ts`, `routes/meScalp.ts`, `/api/me/demo-commands`). Reproduce: hit each unauthenticated (expect 401, proving wired) and authenticated (mint a temp session per the established QA recipe) and capture which returns 502 / empty / non-JSON.

### B2. Prime suspect: process memory pressure
The api-server has repeatedly OOM'd in this environment (full typechecks OOM at 8 GB; guard runs flag memory pressure). A 502 with an empty body is consistent with the node process being killed/restarted mid-request by the platform. Check:
- Does the scanner/health handler do anything unbounded per request (loading all candles for all 8 universe symbols, large in-memory joins, synchronous heavy compute)? If so, bound it (limit rows, stream, cache, or chunk).
- Is there an uncaught async rejection or a throw inside the handler that crashes the worker instead of returning a 5xx JSON envelope? Wrap handlers so they ALWAYS return a JSON error envelope (`{ ok:false, error }`) with the right status — never a dropped/empty response. A crashing handler that returns an empty body is what makes the client's raw `.json()` throw.
- Confirm there is a process-level guard (error middleware + unhandledRejection handler) so one bad request can't take down the worker for the others (which is what the simultaneous scanner + trade-health + smart-layer failure suggests).

### B3. Fix and prove
Apply the minimal fix that makes the route return a proper JSON response (success or structured error) under the failing condition, and stop the worker crash if there is one. If the true fix is infra (memory ceiling) rather than code, say so explicitly and implement the code-side mitigation (bounded work + always-JSON error envelope + retry-friendly status) so the UI degrades cleanly regardless.

## PART C — TESTS

Add tests (follow the repo's node:test / vitest conventions):
1. SAFE READER: empty body ⇒ `kind:"empty"` (no throw); non-JSON body ⇒ `kind:"parse"`; 502 ⇒ `kind:"http"` with status; valid JSON ⇒ `ok:true`.
2. SCANNER CARD STATE (pure render-state helper, like the selected-market view helper): a failed-read result ⇒ "temporarily unavailable" state, never the raw error string; success ⇒ results.
3. RECENT TRADES STATE: failed-read ⇒ friendly message, not "HTTP nnn".
4. OVERLAY BADGE: layer-data degraded ⇒ badge is NOT "verified".
5. OPPORTUNITY MAP: a "no live data" symbol ⇒ labeled awaiting-data, not "nothing tradeable".
6. BACKEND HANDLER (if a crash/throw path was found): the handler returns a JSON error envelope (status 5xx with body) for the failing input — never an empty body.

## PART D — VERIFY + QA

Run for real and paste outputs: lib typecheck, api-server typecheck (scoped if it OOMs, per precedent), frontend typecheck, `pnpm run ci:guards`, plus the new tests.

Runtime QA on /market-scanner: (a) force/observe the degraded state and confirm NO raw "SyntaxError"/"Unexpected end of JSON input"/"HTTP 502" text appears — only clean "temporarily unavailable" copy; (b) confirm the surrounding chart and other panels stay intact; (c) confirm recovery on retry once the backend responds; (d) confirm "Overlays: verified" is gone while layers are degraded; (e) screenshot the degraded scanner with clean copy.

Also: the pre-existing `no-console-in-server` guard failure (a forming-tick test from Task #496) has now polluted several guard runs — clean that one line so guards return 42/42 and real regressions stand out. (Only if trivial; do not expand scope.)

## FINAL REPORT

Report: the raw-fetch-site inventory (file/line/endpoint) and how each was routed through the safe reader/hook; the safe-reader contract; the degraded-state copy per surface; the overlay-badge + opportunity-map fixes; the 502 root cause with evidence (which route, why — code crash vs memory) and the fix/mitigation; test names with real pass/fail; the QA screenshot; and confirmation that execution/gates/brain/permissions are untouched.

## COMPLETION STANDARD — all must be true

- No scanner/health/smart-layer surface calls raw `fetch().json()` anymore; all go through the hardened mutator/hook or the safe reader.
- The user NEVER sees a raw `SyntaxError`, `Unexpected end of JSON input`, or bare `HTTP 502` from these surfaces — only honest "temporarily unavailable" states that recover on retry.
- The 502 root cause is identified with evidence and fixed, OR the handler is made to always return a JSON error envelope (no empty body) plus the code-side mitigation, with any remaining infra cause stated explicitly.
- "Overlays: verified" cannot show while layer data is degraded; "no live data" symbols are not labeled "nothing tradeable".
- typechecks, guards, and new tests pass for real (outputs pasted). No execution/gate/brain/permission change.
