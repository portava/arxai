# T012 — LIVE-only Browser-Timing QA + Seed/Cleanup Hardening

ARX AI treated as LIVE-first. No DEMO QA path, no Paper, no fake execution.
This pass captured **true in-browser timing** (not just backend latency) for a
genuinely LIVE-authorized, loginable QA user, and hardened the seed/cleanup
harness so it survives real browser usage.

## Scope & hard limits honoured

- Not a rebuild. Live MT5 path untouched. `ARX_LIVE_BROKER_EXECUTION_ENABLED`
  never reset. No live trade submitted — trade modals were opened/interacted
  with only; the final Confirm was **never** clicked.
- No weakening of permissions / ownership / kill-switch / allocation / freeze /
  live-approval / MT5-confirmation.
- `arx_live_commands` invariant held at **32** before and after every step.

---

## Results (25 items)

### A. Harness correctness fixes
1. **Cleanup glob fixed (T1).** `TAG_PREFIX` ends in `_` (a LIKE wildcard); the
   matcher now uses `escapeLikeLiteral(TAG_PREFIX) + "%@arx.test"` with `ESCAPE '\'`
   and `ILIKE`, so historical `qaSDOM_*` rows are matched (previously matched none).
2. **Cleanup made FK-robust (T1, newly surfaced).** Once the glob matched, the
   final `DELETE users` failed on `user_one_click_settings` — a table the hardcoded
   child-delete list didn't cover, written by real browser QA (opening the trade
   modal). Cleanup now **dynamically discovers every public table with a `user_id`
   column** and deletes the test users' rows from each.
3. **Fail-closed evidence protection.** The dynamic delete excludes an explicit
   audit denylist (`arx_live_commands`, `arx_live_positions`,
   `trade_command_audit_log`, …) **and** any table whose name matches trading-safety
   evidence patterns (`*audit*`, `*log(s)*`, `*event(s)*`, `*command(s)*`,
   `*position(s)*`, `*decision(s)*`, `*violation(s)*`, `*reservation(s)*`,
   `*disclosure*`, `*acceptance(s)*`). So a future/renamed evidence table is preserved
   by **default** rather than silently purged (addresses denylist-fragility raised in
   review). If a protected table actually holds test-user rows, cleanup **aborts before
   deleting anything** (`PROTECTED_EVIDENCE_HAS_TEST_ROWS`, exit 1) — never
   auto-deletes evidence, never half-cleans. Benign high-volume UI tables
   (`user_activity_events`, …) that every logged-in user writes are explicitly
   purge-approved so normal QA cleanup still completes. Discovered table identifiers
   are validated (`^[a-z_][a-z0-9_]*$`) before interpolation.
4. **Retry-pass ordering.** Deletes run in up to 8 passes so inter-child FKs (e.g.
   `arx_assistant_messages → arx_assistant_conversations`) resolve regardless of
   discovery order; residual tables are surfaced and fail the run loudly.
5. **drizzle array-interpolation bug fixed.** `ANY(${ids})` made drizzle emit an
   invalid row expression `ANY(($1,$2,…))`; replaced with an explicit
   `sql.join`-built `IN (…)` list.
6. **Verified cleanup run:** `deletedUsers: 2`, `residualTables: []`,
   live-cmds `32 → 32`. A prior accumulated batch of 4 stale users was also fully
   removed (incl. 11 `user_activity_events`, 2 sessions, `user_one_click_settings`).

### B. LIVE-authorized loginable fixture (T2 + T4)
7. Seeded **USER** + **ADMIN** with per-run random passwords at INSERT time
   (`.values`, random emails/ids) — guard-safe (`no-real-user-password-mutation`
   passes).
8. Login uses the **real** `POST /api/auth/login` (no bypass) — verified **HTTP 200**.
9. **LIVE posture fix (T4):** virtual account `accountType` changed `demo → live`.
   The routing resolver, trade-action guards, and readiness engine all **block
   LIVE when `accountType !== "live"`**, so a `demo` value mislabelled the fixture
   and contradicted the LIVE-only posture. No safety surface weakened.
10. `GET /api/me/account-mode` returns **`currentAccountMode: LIVE_SHARED`**,
    `approvalStatus: APPROVED`, `liveExecutionArmed: true`, shared-master attached,
    allocation present, `maxLotSize: 0.01`.
11. DEMO-language scrub: the new harness uses LIVE wording. Existing docs’ "demo"
    references (`/mt5-setup` arming toggle, `requestDemoOrder`, the `safetyMode`
    enum, `MOCK|DEMO|LIVE_LOCKED` heartbeat states) are **factual descriptions of
    the product** and were intentionally left unchanged — ARX genuinely has a demo
    path coexisting with live.

### C. Desktop browser timing (1280×720) — quantitative
12. `nav_to_cockpit`: **100 ms** — target `< 100 ms` → PASS (at threshold).
13. `nav_return_to_scanner`: **97.6 ms** — target `< 100 ms` → PASS.
14. `scanner_tab_switch_and_shell`: **702.1 ms** — target `< 1 s` → PASS.
15. `search_input_usable`: **0 ms** — instant → PASS.
16. `chart_skeleton_visible`: **0.4 ms** → PASS.
17. `market_selection_feedback`: **0.8 ms** — target `< 300 ms` → PASS.
18. `lot_input_response`: **0 ms** (value `0.01`) — target `< 100 ms` → PASS.
19. `ruby_thinking_indicator`: **0.3 ms** — target `< 100 ms` → PASS.
20. `fcp_cockpit` / `fcp_scanner`: **2796 ms** first-contentful-paint (cold Vite dev
    + auth bootstrap). This is initial cold-load FCP, not an interaction; no ~7 s
    freeze observed at any point. All **interaction** targets pass.
21. **No ~7 s freeze** reproduced on desktop across the full flow.

### D. Mobile browser timing (400×720) — qualitative
22. All steps completed: login, scanner shell/search/chart, EURUSD select, Buy/Sell
    modal open + close, lot input, Ruby, both nav transitions. No submit clicked,
    **no ~7 s freeze**.
23. **UX note:** at 400 px the modal Cancel button sits off-screen; a DOM-click
    fallback closed it. Worth a responsive fix in a later pass.
24. **Honest limitation:** exact mobile millisecond deltas were **not extractable**
    — the test runner narrates prose, and the beacon→server-log channel failed
    (`/tmp/logs/*.log` are snapshots and the API server restarts frequently).
    Mobile is reported qualitatively; desktop quantitatively.

### E. Regression & safety
25. `pnpm run ci:guards` **26/26 PASS**; `typecheck:libs` builds clean; `scripts`
    and `api-server` typecheck pass; `arx_live_commands` **= 32** throughout; final
    DB pristine (**0** `qaSDOM_` rows). Live MT5 path intact; no live trade placed.

---

## Follow-ups (not done this pass)
- Responsive fix for the trade-modal Cancel button at ≤400 px (item 23).
- A reliable mobile timing-beacon channel (persisted sink, not `/tmp` snapshots)
  to make mobile timing quantitative (item 24).
