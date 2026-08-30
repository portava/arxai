# C8 equity-index data feed — runbook

**Branch:** `hold/c8-data-feed` · **Base:** `phase6/guided-mode @ 746e764`
**Status:** machinery built and proven; the evaluation is an **owner press** and has
**not** been run.

The registered turn-of-month transfer-proof experiment
(`TURN_OF_MONTH_EQUITY_INDEX_DRIFT_V1`) sat at `BLOCKED_ON_DATA` because no
equity daily-close series was provisioned. This branch builds the feed, the
integrity gate, the fingerprint, and the strategy wiring, and stops one command
short of the verdict.

---

## 1. What was built

| Piece | Path |
|---|---|
| Types, adapter interface, typed refusals | `lib/markets/src/dailySeries/types.ts` |
| US equity **daily** session calendar (declared NYSE/Nasdaq rule set) | `lib/markets/src/dailySeries/usEquityCalendar.ts` |
| Integrity guard (12 defect classes) | `lib/markets/src/dailySeries/integrity.ts` |
| `dataFingerprint` (the no-respin key) + `provenanceDigest` (the licence gate's tamper-evidence) | `lib/markets/src/dailySeries/fingerprint.ts` |
| One-shot ledger — the only no-respin memory that spans processes | `scripts/src/c8VerdictLedger.ts` |
| CSV/JSON parsing + bot-challenge classification | `lib/markets/src/dailySeries/parse.ts` |
| Snapshot format (self-verifying) | `lib/markets/src/dailySeries/snapshot.ts` |
| Source adapters | `lib/markets/src/dailySeries/sources/{fredCsv,stooqCsv,stockAnalysisJson,fileImport}.ts` |
| Turn-of-month trade generator + harness wiring | `lib/validation/src/turnOfMonth.ts` |
| CLI: probe / ingest / snapshot | `scripts/src/c8DailySeriesIngest.ts` |
| CLI: dry run (fit window only) | `scripts/src/c8TurnOfMonthDryRun.ts` |
| CLI: **the owner's press** | `scripts/src/c8TurnOfMonthEvaluate.ts` |
| Tests | `scripts/src/__qa__/c8DailySeriesIngestion.test.ts`, `scripts/src/__qa__/c8TurnOfMonthWiring.test.ts` |

No schema changes. No secrets. Nothing on the dispatch/gate path.

---

## 2. Source reachability, measured 2026-08-29 from the build sandbox

| Source | Result | What its bars ARE | Terms |
|---|---|---|---|
| **FRED** `fredgraph.csv` | **REACHABLE** | price-only **index levels** — no dividends, not tradable | documented public |
| **stockanalysis.com** history JSON | **REACHABLE** | split **and** dividend adjusted ETF closes, SPY back to 1993 | **UNVERIFIED** |
| **Stooq** daily CSV | **BLOCKED** | — | unverified |
| file import | always available | whatever the importer declares | — |

Details that matter:

* **Stooq answers HTTP 200 with a JavaScript proof-of-work browser check**, on
  both `stooq.com` and `stooq.pl`, for `spy.us` and `^spx`, with and without a
  browser User-Agent. That challenge was **not** solved — bypassing bot
  detection is out of bounds. The adapter classifies the body and returns a
  typed `BOT_CHALLENGE`, because a CSV parser reads that page as *zero rows*
  and would report a blocked host as an empty market.
* **FRED's `SP500` and `DJIA` are licence-truncated to ~10 years** regardless of
  the requested start date, so **neither covers the 2005–2015 fit window**.
  `NASDAQCOM` and `NASDAQ100` carry full history.
* Also probed and unusable without credentials: Yahoo chart API (HTTP 429),
  Alpha Vantage (`demo` key refuses real symbols), FMP, marketdata.app,
  Nasdaq Data Link, EODHD.

### Node ignores the sandbox proxy

This environment routes egress through an HTTP proxy. Node's global `fetch`
does **not** read `HTTPS_PROXY` unless `NODE_USE_ENV_PROXY=1` is set, and the
failure surfaces as `ENOTFOUND` — which reads as "host unreachable" and would
be recorded as a blocked data source. It is not. `nodeFetch` detects the
misconfiguration and names it. **Prefix every network command with
`NODE_USE_ENV_PROXY=1`.**

---

## 3. The integrity guard, and what it caught

A series failing **any** check is refused **whole** — never trimmed to the clean
part, never interpolated, never re-sorted.

Checks: `PROVENANCE_INCOMPLETE`, `ADJUSTMENT_UNKNOWN`, `EMPTY`,
`MALFORMED_DATE`, `NON_POSITIVE_PRICE`, `DUPLICATE_DATE`, `OUT_OF_ORDER`,
`NON_TRADING_DAY_BAR`, `MISSING_TRADING_DAY`, `SUSPICIOUS_JUMP`,
`COVERAGE_SHORT`, `CALENDAR_SPAN_UNSUPPORTED`.

Run against real data on 2026-08-29:

* **SPY via stockanalysis.com, 5,597 bars over 2004-06-01..2026-08-28 → PASS**,
  every check clean. That is also independent verification of the calendar rule
  set: zero missing sessions and zero bars on closed days across 22 years,
  including Good Fridays, the Juneteenth start in 2022, the observed-day shifts,
  Hurricane Sandy, and the Ford / G.H.W. Bush / Carter days of mourning.
* **NDX via FRED, 5,598 bars over the same span → REFUSED**, one
  `NON_TRADING_DAY_BAR`: FRED's `NASDAQ100` publishes **7689.715 on
  2019-04-19**, which was **Good Friday** and had no session. The two series
  differ by exactly that one bar.

  That phantom bar is not cosmetic. Turn-of-month offsets are counted in
  **trading days**, so an extra row shifts every subsequent offset by one and
  would silently move the May-2019 entry and exit to the wrong bars. Caught, not
  absorbed.

---

## 4. The one-shot trap you must know about before pressing anything

The pre-registered pass bar is an **AND over four clauses**, and one of them is
`SHADOW_CI`: at least **6** live-shadow observations whose 95% CI excludes zero
from the positive side.

So calling `harness.verdict()` with zero shadow observations is a **guaranteed
MISS**, and that MISS is terminal — it retires the experiment and charges the
family's FDR exactly as a real failure would, before the strategy was ever
allowed to fail on its merits. `c8TurnOfMonthEvaluate.ts` **refuses** to seek a
verdict without a shadow file of at least that many observations, and says why.

Accruing them is a separate, slower job: shadow the strategy live across at
least six month boundaries, recording each boundary's P&L.

---

## 5. The dry run (already run — proves the plumbing, spends nothing)

```bash
cd scripts
node --import tsx ./src/c8TurnOfMonthDryRun.ts                 # synthetic fixture
node --import tsx ./src/c8TurnOfMonthDryRun.ts --snapshot ../docs/c8-data/SPY.snapshot.json
```

It clips the bars to the fit window **before anything reads them** and asserts
zero holdout bars survive; prints the trades so `close of T−1 → close of T+3`
can be checked by eye; demonstrates the harness refusing an unregistered spec,
refusing fit-window data (`FIT_WINDOW_OVERLAP`), and refusing a zero-cost
evaluation (`GROSS_ONLY`); then runs the full pipe end-to-end under a
**throwaway** spec whose windows are carved out of the fit era.

The synthetic-mode run is green. Its verdict is `MISS`, which is the correct
answer — the fixture is driftless GBM with no turn-of-month effect in it by
construction, so a machine that certified it would be certifying noise.

---

## 6. The owner's press

### Step 1 — provision the data (safe, repeatable)

```bash
cd scripts
NODE_USE_ENV_PROXY=1 node --import tsx ./src/c8DailySeriesIngest.ts --probe --at "$(date -u +%Y-%m-%dT%H:%M:%SZ)"

NODE_USE_ENV_PROXY=1 node --import tsx ./src/c8DailySeriesIngest.ts \
  --source stockanalysis --symbol SPY \
  --from 2004-06-01 --to 2026-08-28 \
  --at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --out ../docs/c8-data/SPY.snapshot.json
```

Or, if you would rather not depend on an undocumented endpoint, download a CSV
in a browser and import it — the adjustment basis is a **required** argument
because only the person who downloaded the file knows what they downloaded:

```bash
NODE_USE_ENV_PROXY=1 node --import tsx ./src/c8DailySeriesIngest.ts \
  --source file --path /abs/path/spy.csv \
  --adjustment split_dividend_adjusted \
  --origin-note "downloaded from <vendor> in a browser on <date>" \
  --symbol SPY --from 2004-06-01 --to 2026-08-28 \
  --at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" --out ../docs/c8-data/SPY.snapshot.json
```

The snapshot is written **only** if the integrity guard passes, and it carries
**two** digests, both re-verified on load:

* `fingerprint` — over the bars. This is the harness's no-respin identity, and
  it deliberately **excludes** the fetch (`fetchedAt`, `source`, `request`), so
  re-downloading the same bars keeps the same identity and the no-respin rule
  cannot be defeated by pressing the button twice.
* `provenanceDigest` — over the **whole provenance block**, licence stamp
  included. Without it, `termsOfUse: "UNVERIFIED"` could be hand-edited to
  `DOCUMENTED_PUBLIC` in a written snapshot and the file would still pass its own
  fingerprint check: the owner gate travelled with the data, but nothing proved
  it arrived unchanged. A snapshot with an edited provenance is now refused with
  `PROVENANCE_MISMATCH`, and one with the digest **deleted** is refused as
  `MALFORMED`.

**Two decisions are yours before this data may back capital, and neither is
made anywhere in this branch:**

1. **The instrument.** The spec pre-registers `ES` and its notes leave the venue
   instrument to you ("ES future or an equivalent index ETF"). SPY-adjusted is
   an equivalent index ETF; a FRED price-only index level is arguably neither,
   since it has no dividends and is not tradable. The evaluate script prints the
   substitution rather than deciding it.
2. **The licence.** stockanalysis.com is an **undocumented site endpoint** and
   every series it produces is stamped `termsOfUse: "UNVERIFIED"`. That stamp is
   an owner gate.

### Step 2 — read the holdout (a threshold, not yet the shot)

```bash
node --import tsx ./src/c8TurnOfMonthEvaluate.ts \
  --phase evaluate --confirm-oos-read \
  --snapshot ../docs/c8-data/SPY.snapshot.json \
  --at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --evidence ../docs/c8-data/SPY.evaluation.json
```

Repeatable and retires nothing — but you cannot unsee the answer, and every
later decision is made by someone who knows it. That is why it has its own flag.

**Read step `2b. PBO PRE-FLIGHT` in the output before going any further.** PBO is
computed from the **fit-stage selection field alone** — the holdout never enters
it — so that clause of the pass bar is decided before the holdout is opened. If
it says the clause `WOULD FAIL`, the verdict is a **MISS in advance whatever the
holdout says**, because the pass bar is an AND. Spending the one shot in that
state retires the experiment and charges FDR for a number that was free an hour
earlier. Step 4 refuses to run in that state; the honest moves are a different
**dataset** or a different pre-registered **search** (a new experiment key, never
a re-pinned hash).

### Step 3 — accrue ≥6 live-shadow month-boundary observations

Write them to `docs/c8-data/SPY.shadow.json` as a JSON array of numbers (or of
`{"pnl": <number>}` objects). A non-finite entry is refused: a NaN observation
is a failed read, not evidence.

### Step 4 — THE ONE SHOT

```bash
node --import tsx ./src/c8TurnOfMonthEvaluate.ts \
  --phase verdict --confirm-one-shot \
  --snapshot ../docs/c8-data/SPY.snapshot.json \
  --shadow ../docs/c8-data/SPY.shadow.json \
  --at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --evidence ../docs/c8-data/SPY.verdict.json
```

`--evidence` is **required** here (it is optional in step 2): the shot may not be
spent without writing down what it produced.

A `MISS` retires the experiment and emits an FDR charge for `lib/discovery`'s
`controlFdr`.

**Where "no second spin" actually lives — stated exactly, because an earlier
version of this runbook overstated it.** `TransferProofHarness` keeps its
retirement memory in private in-memory fields, and the CLI builds a **new**
harness on every invocation, so the harness alone refuses nothing across runs:
re-running the command after a MISS would have produced a clean second verdict.

The durable half is the **one-shot ledger**, `docs/c8-data/verdict-ledger.jsonl`
(`--ledger <path>` to relocate it):

* Step 4 reads it **before** the press and refuses if this spec + this
  `dataFingerprint` already appears.
* It writes a `VERDICT_INTENT` row **before** calling `verdict()` and the outcome
  row after, so a process killed mid-press still leaves the shot spent.
* An unreadable ledger, an unparsable line, or a failed append **refuses**. Not
  being able to read the record of the shot is not permission to re-take it.

The honest limit: it is a file. Deleting it to respin is possible — but it is a
visible act in git history rather than something that happens to someone who
pressed the up arrow. **Commit the ledger after the press.**

Step 4 also refuses when the fit-stage PBO already fails the bar (see step 2).
`--accept-certain-miss` is the deliberate override for an owner who wants to
formally retire an experiment they know cannot pass; it spends the shot and says
so.

---

## 7. Guards that are load-bearing

* **`TURN_OF_MONTH_LOCKED_SPEC_HASH`** pins the spec hash as a literal
  (`019acc35…`). The harness's own mutation check only spans one process; a
  one-shot run months later registers and evaluates in the *same* process and
  would compare a mutated spec against itself. This constant closes that across
  time. Re-pinning it to silence a failure destroys the only evidence the spec
  changed — a genuine change of mind is a **new experiment key**.
* **Window seam.** The January-2016 boundary enters on 2015-12-31, inside the
  fit window. Every bar a trade reads must lie inside its window, so that
  boundary is skipped — **loudly**, with a typed reason and a date. Cost: one
  boundary at each seam. The alternative is a leak.
* **Adjustment is in the fingerprint**, so a losing spec cannot respin by
  switching vendors' adjustment basis. `fetchedAt` and the source are **not**,
  so the no-respin rule cannot be defeated by pressing the button twice — and
  because they are excluded, the provenance gets its **own** digest so the
  licence stamp is tamper-evident too.
* **The PBO pre-flight.** PBO is a property of the fit-stage selection, not of
  the out-of-sample track: `TransferProofHarness.evaluate` computes it from
  `input.selectionField` alone. So it is the second clause after `SHADOW_CI` that
  can be known-failed before the shot, and the press script prints it in step 2b
  and refuses the verdict when it already fails. The wiring suite asserts the
  property directly — inverting every OOS return must move the PBO by exactly
  zero — because a guard against a behaviour nobody verified is decoration.
* **The one-shot ledger** is the only thing that spans processes. The harness's
  `retiredOnData` set does not, and the suite asserts that too: a second harness
  re-registers a spec the first one retired.
* **Adjusted history is restated on every ex-dividend date.** The same request
  a week later is genuinely different numbers. That is why the evaluation reads
  a **snapshot file**, never a live feed.

---

## 8. Verification

```bash
pnpm --filter @workspace/scripts run test:c8-daily-series      # 35 pass
pnpm --filter @workspace/scripts run test:c8-turn-of-month     # 25 pass
pnpm run typecheck
```

Both suites are appended to the end of the root `ci` chain.

**Mutation proof** (a test nobody has watched fail proves nothing) — nine
behaviours were removed one at a time against a compiling tree and each killed
its test:

| Mutation | Test that went red |
|---|---|
| guard stops detecting missing sessions | `guard: MISSING_TRADING_DAY …` |
| fingerprint stops covering the adjustment basis | `fingerprint: stable across price formatting …` |
| bot-challenge classification removed | `HTTP 200 carrying a JavaScript browser check …` |
| trade generator stops window-checking the entry bar | `a boundary whose entry bar sits outside the window …` |
| `parseSnapshot` stops comparing the provenance digest | `snapshot: promoting the UNVERIFIED licence stamp …` + `snapshot: every provenance field is covered …` |
| `findSpentShot` ignores `VERDICT_INTENT` rows | `ledger: an INTENT row with no outcome still spends the shot …` |
| a malformed ledger line is skipped instead of refusing the file | `ledger: round-trips as one JSON line …` |
| the harness's PBO uses a different CSCV block count than the pre-flight | `a fit field whose PBO fails the bar …` |
| `pboPreflight` treats UNMEASURABLE as a pass | `pboPreflight decides the clause the same way the pass bar does …` |

One assertion in the trade-generator test was written wrong by hand and the code
corrected it: April 2015's fourth session is the **7th**, not the 6th, because
Good Friday fell on the 3rd. The literal date is now asserted, so a
calendar-day reading (which lands on Saturday the 4th) and a
forgot-Good-Friday reading (the 6th) both fail.
