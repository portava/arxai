# Self-trading release validation — 28 October 2026

> Later evidence: the exact `6f9e364` EAs compiled successfully under Mac/Wine on 28 October at 10:39 a.m. New York time. [Raw result, EX5 files and scope](MT5_MAC_WINE_COMPILE_RESULT_2026_10_28.md). This historical report retains its original commit/run results; terminal and broker validation remain open.

**Verdict: not green.** PR #100 stays a draft. Nothing was deployed, no worker was activated and no broker, demo or network order was sent.

"Merged" in this document and in the PR means integration between development branches (slice branches into `claude/self-trading-improvements`, and PR #99's `codex/platform-evidence-integration` into it). Nothing was merged into `main`.

## Exact commits tested

| Role | Commit |
| --- | --- |
| PR #100 head (`claude/self-trading-improvements`) | `e09875c4d1a8521a43c05b69fc827117c71db259` |
| PR #99 head (`codex/platform-evidence-integration`), the comparison baseline and PR #100's base | `49f73dcf76de9ae689a7c12c054b17e0b454e2c9` |

After these runs PR #99 advanced to `cd44c73`: four chart-performance and chart-QA commits (`a122d26`, `3a0393a`, `bc4ba57`, `cd44c73`) that touch no self-trading file. They are **not** merged into PR #100 and **not** covered by the results below. Re-merging them means repeating this run.

Every check below ran in an offline cloud container (4 CPUs, Node 24.22.1, PostgreSQL 16), with non-local network connections blocked. Raw logs and JSON for each check are under `/mnt/project-files/arx/self-trading-2026-10-28/`.

## Results

| Check | PR #100 `e09875c` | PR #99 `49f73dc` | Status |
| --- | --- | --- | --- |
| Root `pnpm run ci` (every step, disposable PostgreSQL) | 337 / 337 pass | 329 / 329 on `11cb10a` (PR #99 thread) | pass |
| `pnpm run ci:integration` | 1186 tests: 1172 pass, 0 fail, 14 skipped | — | pass |
| Backend plan (36 commands) | 35 pass, 1 fail (the server-backed `test` lane when no API is running; run separately below) | — | see below |
| Server-backed `api-server test` against an isolated local API | 537 tests: 521 pass, 16 fail, 0 skipped | 537: 521 pass, 16 fail, 0 skipped (same 16) | **fail (16)** |
| Dashboard vitest | 156 files, 1785 pass, 9 skipped | — | pass |
| `pnpm run typecheck`, `ci:guards` 89/89, api-server build, dashboard build | all pass | — | pass |
| Scanner responsiveness, production build, quiet machine (15 alternating runs per head) | 15 / 15 pass | 15 / 15 pass | pass |
| Scanner responsiveness, dev-server fixture (6 runs per head) | 0 / 6 (4× CPU p95 131–154 ms) | 0 / 6 (4× CPU p95 133–157 ms) | **fail** |
| Offline browser scenarios (7, dev-server fixtures) | 6 / 7 (the dev-server responsiveness check fails) | 6 / 7 | **fail (1)** |
| Protective wait feedback, real Chromium | pass (see section 3) | not applicable | pass |
| MT5 EA: extracted-MQL C++ harness | 56 + 105 + 674 checks pass | the same | pass |
| MT5 EA: native MetaEditor compile | **not run** | **not run** | **gap** |

## 1. Server-backed backend suite

Harness files: `/mnt/project-files/arx/self-trading-2026-10-28/server-lane/` (`run-lane.sh`, `serve.mts`, `auth-proxy.mjs`).

- **Database:** a disposable PostgreSQL 16 cluster with the drizzle schema pushed, destroyed after the run.
- **API:** the API runs from source with the same bootstrap as `src/index.ts` up to `listen`: safety core, owner/admin bootstrap, core-agent seed. It deliberately starts **none** of the background workers, watchdogs, schedulers or keep-alives.
- **Isolation:**
  - `ARX_LIVE_BROKER_EXECUTION_ENABLED=false`.
  - AI providers point at `127.0.0.1:9`.
  - `offline.cjs` makes every non-local socket connection throw. The server log recorded 0 blocked attempts.
- **Authentication:** the suite predates the global auth gate. Unauthenticated, `/api/system/status` returns 401. So a small proxy on `:80` logs in once as a bootstrapped owner account and adds that session to each request.
- **Test-only setting:** `VAULT_OVERRIDE_TOKEN` is set for the server and the tests, as the suite expects.

**Result.** 521 tests pass and 16 fail, identically on both heads. All 16 call `POST /api/execute-trade`, or query rows that only that endpoint would create. The endpoint returns `410 EXECUTE_TRADE_RETIRED` by owner decision 14 (2026-10-25), and the suite's own header notes this:

- `phase1.test.mjs`: CT-2, CT-3, CT-4, RG-1, RG-2, RG-3, KS-1, V-2, V-3.
- `phase2.test.mjs`: LOG-2, LOG-3, LOG-4, LOG-5, QUERY-2, QUERY-3, QUERY-7.

These are recorded as failures, not waived. Making them pass would mean either rewriting those cases against the governed paths that replaced the endpoint, or reversing the retirement. Both are owner decisions.

## 2. Scanner responsiveness

Harness files: `/mnt/project-files/arx/self-trading-2026-10-28/scanner/`.

**Method.**
- **Builds:** each head's `scripts/scanner-qa` fixture is built with `vite build` in production mode, using the same root, aliases and plugins as `scripts/scanner-qa/server.mjs`. It is then served by `vite preview`.
- **Scenario:** the unmodified `scripts/scanner-qa/responsiveness.js` (20 clicks at 1× and at 4× CPU throttle; p95 from click to the second animation frame), with the same 100 ms rule. The only source change is that a p95 breach is recorded instead of thrown, so the measurements of a failing run are kept.
- **Order:** heads alternate PR99, PR100, PR99, … for 3 rounds of 5 runs each, rebuilding each head every round.
- **Conditions:** the run started after the CI job finished and a 60 s idle period (1-minute load average 0.45).

**Production build: 15 / 15 runs pass on each head.**

| Head | 1× p95 median (min–max) | 4× p95 median (min–max) | Breaches over 100 ms |
| --- | --- | --- | --- |
| PR #99 `49f73dc` | 35.0 ms (31.6–39.2) | 77.2 ms (66.4–85.7) | 0 / 30 |
| PR #100 `e09875c` | 35.0 ms (30.2–38.4) | 80.5 ms (54.6–92.6) | 0 / 30 |

**Dev-server fixture** (the fixture used by the 7-scenario browser check): 6 runs per head, alternating. 1× passes, with p95 30–38 ms. 4× fails on every run:
- PR #99: p95 132.8–156.7 ms.
- PR #100: p95 131.8–154.3 ms.

This is the existing browser-check failure. It is retained here as a failure, and the 100 ms target is unchanged. The PR #99 thread measured 78–83 ms at 4× on the same dev-server fixture in its own container, so the result depends on the host. In this 4-CPU container, the dev-server build at 4× throttle does not meet the target on either head. The production build meets it on both.

No scanner or QA-script source differs between the two heads. In the dashboard, `git diff 49f73dc e09875c` touches only the admin self-trade page, its new run-cycle card and test, and one `package.json` script line. The scanner fixture does not import any of those.

## 3. Protective path: the 20-second wait in the interface

The protective path can wait up to 20 s for a fresh EA sweep inside the admin `POST /self-trade-ai/run-autonomous-cycle` request. Code: branch `claude/self-trading-protective-ui`, commits `074284a`, `bd89bbb`, `c22da90`, `d25e3c1`; integrated as `e09875c`.

**What the code did before this branch (checked):**
- **No freeze:** the request was already asynchronous, so the page never froze.
- **Nothing reported closed early:** `positionsClosed` and `positionsModified` count only broker-confirmed results. A protective dispatch was never counted as closed.
- **What was missing:** the only feedback was the label "Running cycle…". Hold and timeout reasons were not shown at all.

**What it does now:**
- **On click:** a status region (`aria-live="polite"`) says "Cycle running". The page explains that a cycle can wait up to 20 s for a fresh broker position snapshot, and an elapsed counter starts.
- **While waiting:** only the Run button is unavailable (`aria-disabled`, and keyboard focus stays on it). The rest of the page keeps working.
- **After 45 s:** the page says the run is taking longer than expected, and that no outcome is known yet.
- **On success:** it shows protective actions considered, "queued in the EA mailbox — awaiting broker confirmation; can still expire or be rejected", held, and "command recorded / outcome unknown". Each hold reason comes with a plain-English explanation. The timeout reads: "Timed out: no broker position snapshot newer than the held one arrived from the EA within the 20 s wait…". It also shows the finish time and the result's age.
- **Never "closed" early:** no protective dispatch is ever labelled closed, completed or filled. The existing tallies are relabelled "broker-confirmed closes" and "broker-confirmed modifications".
- **Errors:**
  - A dropped connection or a 502/503/504 says the cycle may still be running on the server.
  - An offline click is not sent at all, and says so.
  - A second click while a cycle runs gets `409 CYCLE_ALREADY_RUNNING` from the server. The guard is per process. After 10 minutes the refusal says the running cycle may be stuck.
- **Tab switches:** state survives because it is read from the shared mutation cache.

**Tests:**
- 21 card tests: 13 of them fail against the earlier card.
- Route tests for the 409 and for the slot being released.
- Response-shape and accounting tests.
- Lifecycle suite: 103/103.

**Real-browser measurement** (headless Chromium; production build of the real card inside the real page tabs; network stubbed to answer after 20 s; one interaction every 250 ms throughout: typing, clicking, switching tabs):

| | Click to waiting text | Worst frame gap | Long tasks | Wording |
| --- | --- | --- | --- | --- |
| 1× CPU (`d25e3c1`) | 8.4 ms | 42 ms (p95 17.5 ms) | 0 | no "closed/completed" before or after the response |
| 4× CPU (`d25e3c1`) | 61.7 ms | 136 ms (p95 27.7 ms) | 23, max 131 ms; none over 200 ms | the same |

At 4×, the stalls over 100 ms happened when the page remounted the Autonomous Execution tab after a tab switch. That page behaviour predates this change.

**Remaining gaps:**
- The elapsed counter uses the browser's clock. The server does not stream which phase a running cycle is in.
- The overlap guard covers one API process only.
- A cycle that hangs forever keeps the guard held until restart. The real fix is database pool and statement timeouts, which is not in this change.

## 4. MT5 EA validation

- **Native MetaEditor compilation: not run.** This container has no Windows, Wine, MetaEditor or MT5 terminal. No thread in this project has compiled the EAs natively. Native compile, and a run in a real terminal, remain open for every EA change on PR #99. PR #100 changes no `.mq5` or `.mqh` file (`git diff --stat 49f73dc e09875c -- mt5-bridge` is empty).
- **Extracted-MQL harness, a separate kind of evidence:**
  - `mt5-bridge/tests/run_demo_core.py`: 56 checks.
  - `run_management_target.py`: 105 checks.
  - `run_management_target.py --result-evidence`: 674 checks.

  All pass on both heads. This harness extracts the actual handler functions from `ReplitMT5BridgeEA_v131.mq5` and `ARX_AI_Universal_Agent_v154.mq5` and compiles them as C++ (g++ 13.3) against a fake offline terminal. It proves the logic of those functions under that translation. It does not prove that the full EA source compiles in MetaEditor or behaves the same in a terminal.

## Remaining gaps before "green"

1. 16 server-backed tests target the retired `/api/execute-trade`. This needs an owner decision: rewrite those cases against the governed paths, or retire them.
2. Scanner responsiveness on the dev-server fixture fails 4× throttle on both heads in this container. The production build passes on both.
3. No native MetaEditor compile or terminal run of the EAs.
4. Behaviour changes for operators, listed in `docs/SELF_TRADING_IMPROVEMENTS_2026_10_27.md`:
   - Agent entries need broker quotes. v1.31 streams none; v1.52/v1.54 need `CandleSymbols` and a symbol sync.
   - The protective path can add up to one 20 s window per cycle.
5. PR #99 moved to `cd44c73` after this run. PR #100 must re-merge it and repeat these checks before any green verdict.
6. Nothing here was exercised against a live or demo broker, by design.
