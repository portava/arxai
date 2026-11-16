# COMMAND — RUNTIME VERIFICATION OF THE AUDIT'S UNRESOLVED ITEMS (the half static analysis can't prove)

Read this entire command before doing anything. The source-of-truth audit is complete and CLEAN on everything provable from source: no live-OPEN bypass, all command-writers accounted for, Eleanor draft-only, scanner/market-data honesty confirmed. What remains are items that are **runtime facts** — they cannot be proven by reading code, only by observing the running app and the live DB/bridge state. This task closes those. It is **mostly read-only / observational**: do NOT change production code, gates, env, or workflows to make a check pass. If a check FAILS, report it with evidence and STOP for owner decision — do not fix inline. Mint a temporary session for authenticated checks; respect the operator boundary (do not place a real live broker trade, do not set QA flags that would dispatch a live order).

## GROUND RULES
- Observational/verification task. The only acceptable "writes" are: minting a temp test session, and (where a check requires it) placing a **DEMO/SIMULATED** position — never a live broker order.
- Do NOT set `MT5_BRIDGE_TOKEN`, do NOT set QA_ALLOW_* flags that bypass default-deny, do NOT touch the kill switch in a way that affects real users.
- Every finding needs evidence: the actual response/DB row/UI state observed, with timestamps. Mark anything you cannot observe as Unresolved — do not assume.
- If any check reveals a P0/P1 (stale shown as live, executed-before-confirmation, phantom position, NAV on unconfirmed PnL), report it at the top and STOP — do not remediate without owner sign-off.

## CHECK 1 — POSITIONS / BALANCE / PnL FRESHNESS (Flow F) — highest priority
The question source can't answer: do the dashboards show LIVE bridge/MT5 truth, or can a STALE DB snapshot render as live equity/positions?
- With a DEMO (or live-if-already-open, observe-only) position open, load the dashboard and confirm open positions, balance, equity, and PnL reflect current bridge state.
- Force/observe a staleness condition: when the bridge heartbeat is old or the snapshot is stale, does the UI mark it stale/delayed, or does it present old numbers as live? (The audit confirmed scanner/chart/Eleanor have a freshness ladder; dashboards are the unverified surface.)
- Close a position and confirm it disappears/updates — no PHANTOM position lingering from a stale cache.
- Report: the data source the dashboard actually reads at runtime (endpoint + whether it carries a freshness/asOf field), and whether stale state is visibly honest.

## CHECK 2 — BROKER-CONFIRMATION-BEFORE-EXECUTED (Flow E runtime) — highest priority
The question: is "executed" state ever set BEFORE the broker/EA confirms, or only after?
- Trace a DEMO order through its lifecycle and observe the status transitions: draft → queued → pending → sent → executed/failed. Confirm `executed` is set ONLY after EA/broker confirmation, never on queue/send.
- Confirm the audit log (`tradeCommandAuditLogTable`) honestly distinguishes requested / sent / executed / confirmed — i.e. a queued-but-unconfirmed command is not logged or displayed as "executed."
- Report: the exact status values and the transition that sets `executed`, with the confirming event.

## CHECK 3 — KILL SWITCH BEHAVIOR (Flow E/Risk runtime)
- Confirm the kill switch blocks NEW live opens (observe a blocked attempt's reason — do not place a real live order; a DEMO/SIMULATED attempt or the gate's dry evaluation is sufficient).
- Document the ACTUAL behavior for close / modify / admin-emergency-close while the kill switch is engaged (allowed or blocked) — report what the code does at runtime, not what policy desires. The audit flagged this as a known owner-decision item.

## CHECK 4 — ADMIN APPROVAL / MASTER BRIDGE ATTACHMENT (Flow G)
- Confirm an approved user is auto-attached to the shared/master bridge (no stuck half-approved state where `liveApproved` is set but bridge attachment isn't).
- Confirm the user-facing live status matches the admin-side status for the same user (no divergence where the user sees "live" but admin shows not-attached, or vice-versa).
- Confirm execution checks the SAME approval/bridge truth the dashboards display (one source, read at both surfaces).
- Report: where `liveApproved` / full-activation / bridge-attachment are read at runtime and whether the two surfaces agree for a test user.

## CHECK 5 — INVESTOR / NAV TRUTH (Flow H) — if the investor portal is present
- Locate the investor portal/NAV system (confirm whether it's live in this build or dormant).
- If present: confirm NAV is derived from CONFIRMED live PnL/equity, not estimated/indicative/unconfirmed values; confirm the display separates INDICATIVE vs FINALIZED/withdrawable; confirm it shares the same account-equity/PnL truth as the trading dashboards (not a parallel number).
- Report the exact current split/allocation constants from code/DB (ARX / trader / investor) as the audit requested — read-only, report verbatim.
- If dormant/not-built: say so clearly (don't infer behavior).

## CHECK 6 — TEST SUITE (exact counts, sequential — OOM-safe)
Run, one heavy process at a time, and report exact pass/fail counts (note known pre-existing reds vs new):
- `typecheck:ci`
- `ci:guards` (confirm the chokepoint guards still green: `admin-trading-no-live-bypass`, `assistant-no-direct-execution`, `chart-trade-no-direct-execution`, the data-truth guards)
- scanner-truth + the thin/stale-feed downgrade suites
- synthetic-floor + SL + dispatch + live-broker-resolver suites
- `safety-integration`
(The full DB-backed integration lane may exceed a short timeout; run its key members individually if so, as in prior tasks.)

## WHAT TO PRODUCE
A runtime verification report, mirroring the audit's structure, that converts each Unresolved-runtime item to PASS / FAIL / still-Unresolved with OBSERVED evidence (responses, DB rows, UI states, timestamps):
- Check 1 freshness: dashboards honest about stale vs live? phantom positions? (PASS/FAIL + the source endpoint + freshness field)
- Check 2 confirmation gate: executed only after broker confirm? audit log honest? (PASS/FAIL + the transition)
- Check 3 kill switch: blocks new opens? actual close/modify/emergency behavior documented.
- Check 4 approval/bridge: auto-attach works? user==admin status? same truth at execution + dashboard?
- Check 5 NAV: confirmed-PnL-based? indicative vs finalized separated? split constants (verbatim). Or: dormant.
- Check 6: exact test counts; any new red vs known pre-existing.
- Top of report: any P0/P1 found (stale-as-live, executed-before-confirm, phantom, NAV-on-unconfirmed) — if none, say "no P0/P1; runtime items confirmed honest."

## COMPLETION STANDARD
- Each of Checks 1–5 is PASS / FAIL / still-Unresolved with OBSERVED runtime evidence — not inferred from source (source was already audited; this task is specifically the runtime half).
- Any FAIL is reported with evidence and LEFT for owner decision (no inline fix).
- Test suite run with exact counts; chokepoint guards confirmed green; known pre-existing reds distinguished from new.
- No production code / gate / env / workflow changed to pass a check; no live broker order placed; operator boundary respected.
- Net statement: whether the runtime surfaces (dashboards, confirmation gate, kill switch, bridge attachment, NAV) are honest and consistent with the source-of-truth the static audit verified — or where they diverge.
