# COMMAND — SCAN CHANGE: CLOSE THE THREE RESIDUALS (UX honesty + real smoke + leak audit)

Read this entire command before changing anything. The "Scan for all users" change is merged and the core data-leak question on `/scan` is closed (the per-viewer projection masks sim rows for non-admins, proven at the HTTP layer; spoofing is closed in prod). This command closes the three residuals that verification left open. Parts A and C may need code; Part B is verification. Do not mark complete until the COMPLETION STANDARD passes with pasted evidence.

## PART A — NON-ADMIN SCAN UX: make it visibly honest (the original "button does nothing" complaint)

PROBLEM (verified in source): in `pages/market-scanner.tsx` (~L473), when a scan returns no opportunities the UI shows the PRE-scan prompt: "No scan results yet for <universe> — click \"Scan\" or \"Start Auto Scan\" above." So after a regular user actually clicks Scan and it genuinely finds nothing, the app tells them to click Scan again — indistinguishable from the click doing nothing. Plus the 7s rate-limit (`SCAN_RATE_LIMITED` / 429) needs an honest surfaced message.

Fix:
1. Distinguish NEVER-SCANNED from SCANNED-EMPTY. After a scan completes with zero results, show a distinct post-scan empty state, e.g. "Scan complete — no clean setups right now. Try another universe or scan again in a moment." (Keep the existing pre-scan prompt only for the genuine never-run state.) Track whether a scan has been run this session (a flag set in `scan()`), so the two states are separable.
2. SUCCESS FEEDBACK: when a scan runs and returns rows, the refreshed results are obviously the result of the click (they already render — just ensure the busy→done transition reads as "scan ran", not a silent swap). A brief "Scanned <universe> · <n> setups · <time>" line is enough (the page already has a last-scan line — confirm it updates on a manual user scan, not only on the engine loop).
3. RATE-LIMIT HONESTY: when `/scan` returns 429 `{ ok:false, reason:"SCAN_RATE_LIMITED", retryAfterMs }`, show a brief "Scanning too fast — try again in a few seconds" (use retryAfterMs if easy), via the existing `reportErr`/safe-read path — never a raw error, never a silent no-op.
4. Do NOT change the `Start Auto Scan` button (stays operator-only/disabled for non-admins) or the `disabled={busy || !universeAvailable}` logic.

## PART B — REAL COOKIE-AUTHENTICATED NON-ADMIN SMOKE (close the runtime residual)

The route test proves projection hermetically (it mocks the session lookup and selects role via the dev `x-security-role` header). The one thing not yet demonstrated at runtime is a REAL cookie-authenticated non-admin Scan. Close it:

1. Mint a real NON-ADMIN user session (the established session-minting recipe — a regular TESTER/user row, NOT owner/admin), as a genuine signed session cookie.
2. With that cookie, call `POST /api/market-scanner/scan` over HTTP against the running server (no dev header — prove the cookie alone authorizes and sets the role).
3. Assert at runtime: status 200; the response masks simulator rows for this non-admin (sim row scored 0 / `WAIT_FOR_CONFIRMATION`, factors zeroed) while any genuinely-live row keeps its real value; and `/start` + `/stop` with the same cookie return 403.
4. Clean up the ephemeral session afterward; confirm no residue.
5. If the screenshot/browser tool can't carry the cookie, the authenticated curl with the real cookie is the required evidence — paste the sanitized response showing the masked sim row for the real non-admin session.

This is the real-login version of what the test proved hermetically; it removes the "mocked session lookup" caveat.

## PART C — LEAK AUDIT: every opportunity-emitting surface, not just /scan (the important one)

The masking is currently one helper (`projectOpportunitiesForViewer` + `readRoleFromRequest`) applied on the two scanner routes (`scanner.ts:84` status, `:171` scan). But OTHER user-reachable (`requireUser`) routes emit raw scored rows and may NOT project. Audit and fix.

KNOWN CANDIDATES (verify each — these emit `confidenceScore`/scored rows on non-admin-reachable routes and were NOT seen calling the projection):
- `routes/edgeDiscovery.ts` — selects `edgeDiscoveryReportsTable` ordered by `confidenceScore` (L243/L291); is this route `requireUser`? Does a non-admin see raw `confidenceScore`/sim-derived values?
- `routes/aiMentor.ts` — pulls edge reports by `confidenceScore` (L56); non-admin exposure?
- `routes/tradeDecision.ts` — exposes `confidenceScore` in warnings (L397-399) on a `requireUser` path; does it leak sim-derived scores to non-admins?
- `routes/meMarketContext.ts`, `routes/meAssistant.ts` (market-status), `routes/meMarketData.ts` — do any surface scored opportunity/sim rows to non-admins without projection?

Audit method:
1. For EACH of the 25 opportunity/sim-emitting route files, determine: (a) is it reachable by a non-admin (`requireUser` or unauthenticated), and (b) does its response carry raw simulator-derived scored values (confidenceScore, opportunity score, HOT_SETUP-style badges, sim entry/stop/TP)?
2. A route is a LEAK if both are true AND it does not pass results through the viewer projection (or an equivalent role-gated mask). List every route as: ADMIN-ONLY (safe) / NON-OPPORTUNITY (safe) / PROJECTED (safe) / **LEAK (must fix)**.
3. For each LEAK: apply the SAME role-gated masking pattern — non-admin/owner viewers get the honest non-privileged view (no raw sim scores), admins/owners unchanged. Reuse `projectOpportunitiesForViewer` if the shape matches, or the same `viewerSeesSimulatorDetail(readRoleFromRequest(req))` gate adapted to that route's payload. Do NOT invent a second role source — use `readRoleFromRequest` (signed-cookie based, spoof-safe in prod) everywhere.
4. Do NOT over-reach: genuinely-live (non-simulator) data is not privileged and must NOT be masked. Only simulator-derived scored values are owner/admin-only. Keep the live data visible.

## TESTS

- PART A: a render-state test that the SCANNED-EMPTY state differs from NEVER-SCANNED; and that a 429 surfaces the rate-limit copy (not a raw error).
- PART B: the real-cookie smoke result captured (script or documented run) — masked sim row for a real non-admin session.
- PART C: for each route fixed, a test asserting a non-admin gets the masked/non-privileged view and an owner gets the raw view (mirror the `scannerManualScanAccess` pattern). Plus a guard-style assertion (or a documented audit table) that every opportunity-emitting `requireUser` route projects.
- All existing scanner/projection/Focus/synthetic-floor/SL/superset tests stay green.

## VERIFY + QA

Run for real, paste outputs: typecheck (per the OOM workaround — and if the standing typecheck:ci fix has landed, use it), `pnpm run ci:guards`, all new + existing tests.

Authenticated QA as a NON-ADMIN: click Scan with results present (see honest "scanned" feedback), with no results (see the SCANNED-EMPTY state, not the pre-scan prompt), and rapidly (see the rate-limit message). For any Part C leak fixed, hit that endpoint as a non-admin and confirm masked sim values. Screenshot the non-admin scanned-empty state and one fixed leak endpoint's masked response.

## FINAL REPORT

PART A: the never-scanned vs scanned-empty fix + success feedback + rate-limit copy; screenshots.
PART B: the real cookie-auth non-admin smoke result (masked sim row), session cleaned up.
PART C: the full audit table (every opportunity/sim route classified ADMIN-ONLY / NON-OPPORTUNITY / PROJECTED / LEAK), each LEAK fixed with the role-gated mask, tests; confirmation live data was NOT over-masked.
Plus: confirmation no gate/trading-path/owner-admin-relaxation changed, `readRoleFromRequest` is the sole role source (spoof-safe), and no second masking mechanism was introduced.

## COMPLETION STANDARD — all must be true

- A non-admin Scan shows honest feedback: results-present reads as "scanned", results-empty shows a distinct post-scan state (not "click Scan again"), and rate-limited shows an honest message — no silent no-op.
- A REAL cookie-authenticated non-admin Scan is demonstrated at runtime returning the masked view (sim rows stripped, live rows intact); ephemeral session cleaned up.
- Every non-admin-reachable opportunity/sim-emitting route is classified; every LEAK now applies the role-gated mask via `readRoleFromRequest`; genuinely-live data is not masked; no second role source introduced.
- All new + existing tests pass (scanner/projection/Focus/synthetic-floor/SL/superset green); ci:guards green; typecheck run (or honestly noted if the OOM fix isn't in yet) — outputs pasted.
- No gate, trading path, or owner/admin relaxation modified.
```
