# Replit command — R3: risk-kernel gaps (the 24-check spec vs the 23 gates)

**Prerequisite:** R1 merged (R2 can run in parallel on its own branch). **Risk class:** live-execution risk controls — branch + owner merge.

Companion report: `audit-reports/audit-risk.md` (per-check mapping table of all 24 spec-§11 checks, with slices and red-fail tests).

Instruction for Claude Code in the Replit shell:

---

Implement the risk-kernel gap series from `audit-risk.md` on branch `feat/risk-kernel-gaps`, one slice per commit:

1. **Weekly drawdown enforcement** — `arx_live_user_settings.weeklyDrawdownCeilingPct` is stored and capped but never read by any gate. Thread it into the dispatch pre-gate stack next to the daily-loss check. (Smallest slice, do first.)
2. **risk_locks on the live path** — cooldown/consecutive-loss/revenge locks are enforced only on paper routes. Consult active `risk_locks` rows in the live dispatch pre-gates; an active lock refuses with its lock type as the reason.
3. **Per-user reservation atomicity** — `reconcileAllocationsReservedRisk` hard-codes reserved=0 and the preflight headroom check runs unlocked, so parallel same-user dispatches can both pass. Implement real per-intent reservations (reserve → dispatch → release on terminal state) under an advisory lock, mirroring the master-pool advisory-lock pattern that already exists. Give master reservations an `expires_at` and make cap=0 mean ZERO, not unlimited (verify no live config relies on 0-as-unlimited before flipping; if it does, add an explicit `unlimited` boolean instead).
4. **Server-side price collar** — the server passes `requestedPrice: null` and delegates slippage entirely to the EA (fail-open). Resolve a reference price from the broker-confirmed feed at dispatch and refuse when the deviation exceeds a per-symbol cap (`DEVIATION_TOO_LARGE` logic already exists in `preTradeBrokerGuard.ts` — wire it, fail-closed when no reference price is resolvable).
5. **Signal-age bound** — carry `signalTimestamp` on live drafts and refuse dispatch when older than a per-user/system cap (spec check 12).
6. **Correlation/concentration guard** — the largest genuinely-new build: conservative static risk-family groupings first (synthetics vs FX vs metals vs indices from `lib/markets` asset classes), cluster exposure cap in the pre-gates; dynamic correlation later. Unknown correlation must NOT create capacity.
7. **Failure-streak breaker** — N consecutive `LIVE_FAILED`/rejected dispatches for a user/symbol opens a cooling-off lock (writes a `risk_locks` row, reusing slice 2's enforcement).

Also: **wire or retire `evaluateRiskGovernor`** — the 6-kill-switch engine in `lib/domain/src/risk-governor/` has zero callers while its docstring claims it is the master pre-trade gate. Either consume it in the live pre-gates (preferred if its checks don't duplicate slices above) or rewrite its docstring to advisory-only truth. No dead code claiming to be a safety authority.

Every slice: red-fail test first, `pnpm run ci` green after, no changes to the pure 23-gate contract file.

---

**Hold point:** after slice 3, report before 4–7.
