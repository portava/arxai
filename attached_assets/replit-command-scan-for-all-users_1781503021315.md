# COMMAND — LET ALL USERS RUN THE MANUAL SCAN (rate-limited)

Read this entire command before changing anything. Goal: the scanner "Scan" button runs a REAL one-shot scan for every authenticated user, not just admins. The always-on auto-scan engine (Start/Stop) stays operator-only. Scope is exactly: one route guard, one rate-limit, one frontend gate. Do not mark complete until the COMPLETION STANDARD passes with pasted evidence.

## THE PROBLEM (verified in source)

A regular user clicking "Scan" does nothing visible. Two reasons, both confirmed:
- Backend: `POST /api/market-scanner/scan` is guarded by `requireAdmin` (`routes/scanner.ts` ~L128).
- Frontend: `scan()` only calls that endpoint `if (realIsAdmin)`; non-admins just re-run `load()` (`pages/market-scanner.tsx` ~L338-340). So a non-admin "Scan" is a silent no-op refresh — the button looks clickable, gives UI feedback, but triggers no real scan.

(The Scalp scanner works for regular users because its scan path is not admin-gated — that's the proof the engine itself is fine; only the Broad Scan manual trigger is gated.)

## WHY THIS IS SAFE TO OPEN (already true in the code — do not re-architect)

1. The scan handler ALREADY projects results per viewer: `projectOpportunitiesForViewer(decorated, readRoleFromRequest(req))` (`scanner.ts` ~L152) strips simulator-derived/privileged values for non-admin/owner viewers. The data-protection boundary already exists; only the route guard blocks non-admins. Opening the guard does NOT expose admin-only data — but you MUST keep the projection in place and confirm it.
2. The scan cost is ALREADY bounded: `scanOnce` enriches at `ENRICHMENT_CONCURRENCY = 8` through the shared `scannerDataBudget` semaphore. A user scan cannot fan out unbounded. Do not remove or raise this.

## NON-NEGOTIABLE RULES

- Change ONLY the manual one-shot scan path. `POST /market-scanner/start` and `POST /market-scanner/stop` (the always-on engine loop) stay `requireAdmin` — a regular user must not be able to start/stop the operator engine or change its interval.
- Keep `projectOpportunitiesForViewer(... readRoleFromRequest(req))` exactly as-is on the scan response. Non-admin/owner users must still receive the projected (non-privileged) view. Confirm this in the report.
- Do not touch the scan engine internals, the concurrency budget, gates, or any trading path. This is a read-only discovery feature.
- Add per-user rate-limiting so a user cannot spam repeated full scans (cost/abuse protection).

## STEP 1 — BACKEND: open the manual scan to authenticated users, rate-limited

In `routes/scanner.ts`:
1. Change `POST /market-scanner/scan` from `requireAdmin` to `requireUser` (the standard authenticated-user guard used elsewhere in the app). Do NOT change `/start` or `/stop`.
2. Add per-user rate-limiting on this route: a short cooldown (e.g. one manual scan per user per ~5–10s; pick the value consistent with any existing rate-limit pattern in the codebase — grep for the app's existing limiter, e.g. the per-user submit limiter, and reuse that mechanism rather than inventing a new one). On cooldown, return a clean `429` with a JSON envelope (e.g. `{ ok:false, reason:"SCAN_RATE_LIMITED", retryAfterMs }`) — never an empty body (so the frontend's safe reader shows an honest "scanning too fast — try again in a moment", not a raw error).
3. Leave the handler body unchanged otherwise — including the per-viewer projection. The bounded enrichment (`ENRICHMENT_CONCURRENCY`) stays.

## STEP 2 — FRONTEND: actually call the scan for everyone

In `pages/market-scanner.tsx`, `scan()`:
1. Remove the `if (realIsAdmin)` gate around the `POST /api/market-scanner/scan` call so EVERY user triggers the real scan, then `load()` refreshes the view. (Keep the existing `markActionStart`/`markUiFeedback`/`markActionEnd` timing and `setBusy` loading state.)
2. Handle the new `429` rate-limit response honestly: show a brief "Scanning too fast — try again in a moment" (or the retry hint), not a raw error and not a silent no-op. Route it through the existing safe-read/error path (`reportErr` / the degraded-copy pattern), not a thrown raw error.
3. The "Scan" button's `disabled` stays `busy || !universeAvailable` — that's correct (don't let a scan fire when the universe genuinely has no feed). Do NOT change the `Start Auto Scan` button — it stays operator-gated/disabled for non-admins as today.

## STEP 3 — TESTS

Add/extend tests (repo conventions):
1. ROUTE AUTH: `POST /market-scanner/scan` succeeds for a normal authenticated user (was 403/blocked before); `/start` and `/stop` still require admin (a normal user gets 403).
2. PROJECTION HELD: a non-admin scan response is the projected view (no simulator-derived/privileged fields) — assert the projection still applies for the now-allowed non-admin caller.
3. RATE LIMIT: a second manual scan within the cooldown window returns `429` with the JSON envelope (not an empty body); after the window, it succeeds again.
4. Existing scanner/resilience tests stay green.

## STEP 4 — VERIFY + QA

Run for real, paste outputs: typecheck:libs, api-server typecheck (scoped per the OOM workaround), trading-dashboard typecheck, `pnpm run ci:guards`, plus the new tests.

Authenticated QA as a NON-admin user (mint a regular-user session, not owner): click Scan and confirm a real scan runs and results refresh (network shows the POST, not just a status re-read); click Scan rapidly and confirm the honest rate-limit message (no raw error, no silent no-op); confirm "Start Auto Scan" is still disabled/operator-only for this user. Screenshot the non-admin Scan producing results.

## FINAL REPORT

The route guard change (scan → requireUser; start/stop unchanged); the rate-limit mechanism used (and that it reuses the existing limiter pattern) + the 429 envelope; the frontend gate removal + rate-limit handling; confirmation `projectOpportunitiesForViewer` still applies for non-admin callers (privileged data NOT exposed); test names + results; the non-admin QA screenshot; and confirmation that start/stop, the engine internals, the concurrency budget, and all trading paths are untouched.

## COMPLETION STANDARD — all must be true

- A normal authenticated user can trigger a real one-shot scan from the Scan button and see refreshed results (proven by a non-admin QA run, network POST visible).
- `/market-scanner/start` and `/stop` remain admin-only; a normal user cannot control the auto-scan engine.
- Non-admin scan results are still the projected view — no admin/owner-only data is exposed (projection confirmed in code and test).
- Manual scan is per-user rate-limited with an honest `429` JSON envelope; rapid clicks show a clean message, never a raw error or empty-body parse failure.
- The bounded enrichment concurrency and all trading paths are untouched.
- typecheck (libs + both packages) green; ci:guards green; new + existing tests pass — outputs pasted.
