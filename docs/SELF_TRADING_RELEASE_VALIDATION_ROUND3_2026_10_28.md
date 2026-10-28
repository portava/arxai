# Self-trading release validation, round 3 — 28 October 2026

> Later evidence: the exact `6f9e364` EAs compiled successfully under Mac/Wine on 28 October at 10:39 a.m. New York time. [Raw result, EX5 files and scope](MT5_MAC_WINE_COMPILE_RESULT_2026_10_28.md). This historical report retains its original commit/run results; terminal and broker validation remain open.

**Verdict: not green.** PR #100 stays a draft. Nothing was deployed, no database outside disposable test clusters was created or migrated, no worker was activated, trading stayed disabled, and no live, demo or network order was sent. `/api/execute-trade` stays retired.

"Merged" here means integration between development branches: the round-3 branches into `claude/self-trading-improvements`, and PR #99's `codex/platform-evidence-integration` into it. Nothing was merged into `main`.

This report supersedes the earlier verdict in `SELF_TRADING_RELEASE_VALIDATION_2026_10_28.md` for the newer commit. That report's counts apply only to `e09875c`.

## Exact commits

| Role | Commit |
| --- | --- |
| Tested code (PR #100 development branch) | `6f9e3641c53e4d9cf316e6c8c380d5455b52d91d` |
| PR #99 head merged into it (unchanged at the time of the run) | `cd44c73cb3392574ff4aa6593232597278db0657` |
| Merge of PR #99 `cd44c73` | `a89c999` |
| Retired-endpoint test rewrite (`claude/self-trading-legacy-r3`) | `432fa6c`, `6775de0`, `121743b`, `9bee563`; merged as `546266f` |
| Cross-process cycle coordination (`claude/self-trading-cycle-r3`) | `fa292c9`, `e805491`, `ed53ce9`, `6c3488f`, `b00df77`, `786457c`, `1f7e6f8`; merged as `a8744c6` |
| Scanner measurement tooling and tab-remount investigation (`claude/self-trading-scanner-r3`) | `3b527d8`, `58582f7`, `c9e8a10`, `2b6e12e`, `d3367fd`; merged as `6f9e364` |
| MetaEditor handoff and compile package tooling | `6860468`, `f626232`, `93c5830` |

Each round-3 branch was implemented, reviewed by two independent reviewers, and fixed before merging. The run used a separate worktree checked out at `6f9e364`, with a clean tree. Any commit after `6f9e364` on the branch changes only this report.

## Results on `6f9e364`

Offline cloud container: 4 CPUs, Node 24.22.1, PostgreSQL 16 (disposable cluster per plan), non-local connections refused. Run started 10:22 UTC; the plans ran one after another.

| Check | Result | Status |
| --- | --- | --- |
| Root `pnpm run ci`, every step, disposable PostgreSQL | 338 steps: 337 pass, 1 fail (`api-server test:release-readiness`, see below) | **fail (1, intermittent)** |
| Backend plan (36 commands) | 35 pass, 1 fail (`test:isolated-server-lane`, see below) | **fail (1)** |
| Isolated server-backed lane (`pnpm --filter @workspace/api-server run test:isolated-server-lane`) | 543 tests: 530 pass, 12 fail, 1 skipped; 0 blocked external connection attempts (server 0, tests 0) | **fail (12)** |
| `pnpm run ci:integration` | 97 suites, 1204 tests: 1190 pass, 0 fail, 14 skipped | pass |
| of which cross-process cycle coordination (PostgreSQL, real OS processes) | 18 / 18 | pass |
| Dashboard vitest | 157 files, 2017 tests: 2008 pass, 9 skipped | pass |
| `pnpm run typecheck`, `ci:guards`, api-server build, dashboard build | 4 / 4 | pass |
| Offline browser scenarios (7) | 6 / 7; `scanner-qa/responsiveness` (dev server, 4×) failed | **fail (1)** |
| Scanner responsiveness, checked-in `measure.mjs` | see section 3: all four groups miss the 100 ms target at 4× | **fail** |
| MT5 EA, extracted-MQL C++ harness | 56 + 105 + 674 checks pass | pass |
| MT5 EA, native MetaEditor compile | **pending**: package sent for a Mac/Wine compile; no logs or EX5 returned yet | **gap** |
| MT5 EA, terminal run | not run, and not part of this step | **gap** |

Logs: `/mnt/project-files/arx/self-trading-2026-10-28/round3-6f9e364/`.

### Root CI failure: `test:release-readiness` (intermittent, not from this branch)

The failing case is `src/lib/startup/__qa__/dependencyReadiness.test.ts`, "a hanging database times out and concurrent probes cannot accumulate". It expected `ready` and got `unavailable`.

- **Not from this branch.** The test and `dependencyReadiness.ts` are unchanged since `cd44c73`: `git diff cd44c73 6f9e364 -- artifacts/api-server/src/lib/startup` is empty. Both come from commit `b498ae8`.
- **Intermittent.**
  - Alone, the file passed 15 of 15 runs idle and 15 of 15 with five busy CPU loops.
  - As the whole script (five test files in parallel), it failed 1 of 20 runs on `6f9e364`.
  - On PR #99's `cd44c73`, it passed 20 of 20 runs. The test file is byte-identical on both commits, so this is a rare event rather than a difference between the heads.
- **Cause (from reading the test).** The final "ready" probe has a 5 ms timeout, and only one `setImmediate` separates starting the probe from resolving it. If the event loop is held for more than 5 ms (a GC pause, or other test files running in parallel), the timeout wins and the probe reports `unavailable`. The production code behaves as designed. The test's timing budget is too small to be deterministic.

Reported to the PR #99 thread, which owns that test. That thread confirmed the cause and fixed it on its side branch (`a895c69`, mocked timers; `dependencyReadiness.ts` unchanged). The fix lands on PR #99 later and is not in `6f9e364`. Here it is recorded as a failure, not waived.

## 1. Retired endpoint and the 16 rewritten tests

`/api/execute-trade` still returns `410 EXECUTE_TRADE_RETIRED`; the route was not restored. The 16 cases are rewritten against the governed replacements:
- PAPER: `POST /api/paper/orders` and the simulator order system `POST /orders/create`.
- DEMO/LIVE: `POST /api/me/trade-actions` plus confirmation.
- History: `GET /api/trades`, plus the Risk Governor decision log.

The requirement mapping, with file:line, is in `docs/TIER1_TRADE_ENGINE_MODES.md`.

**New coverage: `tests/execute-trade-retired.test.mjs`.**
- **Setup:** the Safety Core is put in exactly the state the old route needed to book a trade.
- **Unauthenticated:** PAPER, DEMO and LIVE bodies get 401.
- **Owner and plain trader:** each gets 410, with no trade id and no mode conversion.
- **No side effects:** the row count of every base table in the schema is unchanged, and a supplied confirmation id is not claimed. The tables named in the brief are listed explicitly, so a missing table stops the test.
- **Mutation check:** a handler that wrote one `audit_events` row before answering 410 failed three of the four cases. The handler was restored.

**Remaining failures are real gaps, not test bugs.** Twelve rewritten cases still fail. Each asserts the original safety requirement on a governed path that does not enforce it. Nothing was relaxed:

| Gap | Failing cases |
| --- | --- |
| 1. The PAPER order path books while the Safety Core is in OBSERVE_ONLY, SUGGEST_ONLY or a non-trading state. | CT-2, CT-3, RG-2 |
| 2. Governed trade decisions reach `user_risk_events`, not the vault or `audit_events`. | LOG-2, LOG-5, QUERY-2, QUERY-3, V-QY5 |
| 3. A paper order's vault row is not linked through `linkedTradeId`. | LOG-4, QUERY-7, V-QY6 |
| 4. No AI-confidence floor on the PAPER path or the Trade Action Center (only the simulator order system has one). | RG-1b |

- **Skipped:** LOG-3b, an approved LIVE trade recorded in the vault. It needs an armed trader and live execution, which this lane never enables, and no file on the LIVE path writes the vault.
- **Owner decision (2026-10-28 11:55 UTC):** fix all four gaps. That work comes after `6f9e364`, and these counts do not cover it.
- **Baseline:** at `a89c999` with the earlier runner, the lane gave 537 tests: 521 pass, 16 fail.

**Isolated lane, now checked in** (`artifacts/api-server/scripts/isolated-lane/`):
- **Database:** a throwaway database on a Unix socket only. No credentials are inherited.
- **Workers:** none of the production startup workers start, and the two database workers that start at app import are stopped.
- **Network:** `offline.cjs` refuses TCP/TLS, UDP and DNS to non-loopback hosts and counts every attempt. A child-process self-check runs before every run.
- **Auth:** an owner-session proxy is kept, because the legacy suite predates the auth gate. Production startup in `src/index.ts` is unchanged.
- **Wiring:** the lane is manual-only and is not in root `ci`.

## 2. Autonomous-cycle reliability across API processes

Design and evidence: `docs/SELF_TRADING_DUPLICATE_RECOVERY_AUDIT_2026_10_27.md`, section "Autonomous-cycle coordination and bounded waits".

**Coordination.** A session-level PostgreSQL advisory lock is held on a dedicated connection for the whole cycle.
- A second process gets the existing `409 CYCLE_ALREADY_RUNNING`.
- The lock is re-verified before each decision, each agent's management and the protective drain. A lost lock stops the cycle there (`STOPPED` / `LEASE_LOST`).
- Acquisition records `pg_backend_pid()`, so a transaction-mode pooler's re-entrant grant is refused rather than trusted.

**Bounded waits.**
- The cycle's queries run on their own pool with connection, statement, lock and idle-in-transaction timeouts. These can't be set to unbounded.
- Connections also get a client read timeout and keepalive, so a half-open connection is destroyed rather than reused.

**Honest completion.** The response's `completion` is `COMPLETED` only when:
- no step threw;
- no bounded wait expired;
- no database connection was lost;
- no protective outcome is uncertain.

Otherwise it is `INCOMPLETE` or `STOPPED`, and a thrown cycle answers `500 CYCLE_FAILED` without claiming what was sent. The Run cycle card says "did not finish" instead of "Cycle finished".

**Tests.** The new PostgreSQL suite, 18 cases, runs each API process as a real OS process serving the real route. It covers:
- two simultaneous processes;
- SIGKILL of the lock holder at six points, with no second command, the exposure reservation kept, and nothing marked filled, expired or failed;
- lock and statement timeouts on a held row;
- pool exhaustion;
- lock-session termination;
- silent work and lock connections;
- three pooler routing cases.

The first 11 cases failed against `a89c999`, and the review-round cases failed against `b00df77`.

**Still open (documented):**
- An item already mid-dispatch when the lock drops finishes; its own claims prevent a duplicate.
- The protective drain's 20 s wait is not interrupted by a lost lock.
- Non-database waits are unbounded.
- A client-dropped half-open connection can keep its row locks for up to 60 s.
- Transaction-mode poolers are refused, not supported.
- The real decision engine and the real `dispatchLiveCommand` are not driven under real timeouts.

## 3. Scanner responsiveness

Tooling, now checked in: `scripts/scanner-qa/measure.mjs` and `prod-server.mjs`, documented in `scripts/scanner-qa/README.md`.

**What it keeps:**
- every click sample and per-run p50/p95/p99/max;
- breaches, errors and outliers;
- partial runs of failed iterations;
- the load average at each iteration;
- each bundle's build commit (a stale bundle is refused).

Production and development are reported separately. The target is unchanged: per-run p95 from click to the second animation frame is at most 100 ms, at 1× and 4× CPU throttle.

**Integrated page.** A new scenario measures the real dashboard `/market-scanner` page (Broad Scan tab). Every API call is answered in the browser with fixture data; 8 endpoints the page loads but a row click does not read are answered 503.

Run on `6f9e364`, 5 recorded runs plus 1 warm-up per group, started after a 120 s idle period (1-minute load 0.3 at start). 4 of 24 iterations started with load above 2.0, so timings are noisy.

| Build | Surface | 1× runs within 100 ms (p95 median) | 4× runs within 100 ms (p95 median, range) |
| --- | --- | --- | --- |
| Production | Scanner fixture | 5 / 5 (36.3 ms) | 4 / 5 (90.1 ms, 78.4–109.1) |
| Production | Integrated page | 5 / 5 (60.4 ms) | **0 / 5 (310 ms, 302.9–349.4)** |
| Development | Scanner fixture | 5 / 5 (29.2 ms) | **0 / 5 (151.5 ms, 120.5–166.5)** |
| Development | Integrated page | **0 / 5 (141.5 ms)** | **0 / 5 (818 ms, 788.7–967.8)** |

- **The fixture result does not prove full-app performance.** The real page at 4× in a production build misses the target by about 3×: 220 long tasks across the five 4× runs, median 122 ms, maximum 354 ms.
- **Fixture changed since the earlier round.** It previously passed 15 of 15 production runs. This time one 4× run breached (109.1 ms, at load 1.0).
- **Unexplained page traffic.** The page also fired 210 `POST /api/me/chart/ai-alerts/scan` calls across the runs (blocked by the harness). This has not been investigated.
- **Raw data:** `round3-6f9e364/scanner/` (`results.json`, `summary.md`).

## 4. Tab-remount stalls (separate issue)

`docs/SELF_TRADE_TAB_REMOUNT_STALLS_2026_10_28.md`. Investigated, not fixed.

**Cause.** Switching back to the admin page's Autonomous Execution tab remounts its whole subtree (Radix `TabsContent` unmounts inactive tabs). The remount happens synchronously at mousedown, which costs 73–232 ms of long tasks at 4×. The kill-switch scope `Select` is the largest render cost.

**Ruled out.** Refetching on remount does not occur with the app's `QueryClient` defaults and does not change the stall.

**Options for the owner (not implemented, because each changes behaviour):**
- keep visited tabs mounted, which roughly halved the stall;
- make tab activation a transition;
- use a lighter picker.

## 5. MT5 EAs: native compile, harness and terminal kept separate

- **Native MetaEditor compile: pending.**
  - **Why not here:** the cloud container cannot compile. It has no Windows or Wine, and the network policy refuses the MetaQuotes download hosts (`docs/MT5_NATIVE_COMPILE_HANDOFF_2026_10_28.md`).
  - **Package:** a compile package was built from `6f9e364` with `scripts/mt5-compile-package/build-package.sh`. Zip SHA-256: `c5a57bba05fbec0acc270a63af6f425bfabbe0cbb6859209efde559d42c01594`.
  - **What it holds:** both EAs, all three companion includes, a SHA-256 manifest, the commit record and compile instructions.
  - **EA changes since `cd44c73`:** none (byte-identical).
  - **Who compiles:** the owner's helper will compile it with the existing MetaEditor under the MetaTrader 5 macOS app's Wine (`compile_mac_wine.sh`), which never starts the terminal.
  - **Rule for the result:** it stays pending until the actual compiler logs and newly generated EX5 files are returned. It will be recorded as "MetaEditor under Wine on macOS" with the MetaEditor build and Wine version, never as Windows validation.
- **Extracted-MQL C++ harness:** 56 + 105 + 674 checks pass on `6f9e364`. This is g++ against a fake terminal, not MetaEditor.
- **Terminal run:** not run. Out of scope for this step; no terminal was launched, no EA attached and no account touched.

## Remaining gaps before "green"

1. Twelve isolated-lane failures from four governed-path safety gaps (section 1). The owner chose on 2026-10-28 to fix all four; that work follows this report and is validated separately.
2. `test:release-readiness` fails intermittently in root CI. It is a timing-sensitive test, unchanged from PR #99, and has been reported to that thread.
3. Scanner responsiveness misses the 100 ms target at 4× on the integrated page (production and development) and on the development-server fixture. The production fixture breached once in five runs.
4. Native MetaEditor compile is pending, and a terminal run has not been done.
5. Cycle-coordination limits listed in section 2.
6. The tab-remount stall is unfixed (section 4).
7. Nothing was exercised against a live or demo broker, by design.

No release-readiness, competitor-parity or completion-percentage claim is made.
