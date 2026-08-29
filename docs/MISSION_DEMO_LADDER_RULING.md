# Ruling — honest paper/demo fills, and how the automation ladder is earned

Branch `fix/demo-ladder`. This document records the design decision the fix
required and why it was taken. It is a **build ruling**, not an owner ruling;
`docs/OWNER_DECISIONS.md` is untouched.

---

## 1. The defect

Three findings, independently re-verified against the code:

1. **`missionExecution.ts:450-459`** — only `executionMode === "live"` reached the
   executor. Paper and demo went to `recordSimulatedMissionDispatch`
   (`:91-113`), which wrote an audit row and returned. **No code path anywhere
   wrote `pnl` or `closedAt` for a non-live draft.** A paper/demo mission's
   `currentValue` was therefore frozen forever and the mission could never
   complete.
2. **`missionPromotionGate.ts:102-103`** — target level 3+ required
   `demo_performance` (sample ≥ 20 at ≥ 45% win rate), derived by
   `missionPromotionService.readClosedDrafts` (`:97-122`) from closed drafts —
   which demo could never produce. **The promotion ladder was unreachable by
   construction.**
3. **`missionExecutionModeService.ts:113-138`** — demo→live required a
   certificate and the platform live switch but **no performance evidence at
   all**, while earning any auto level required the full checklist. Its own
   comment at `:131-134` admitted the inversion.

Net effect: **the only road to any auto level was real-money trading at level
2.** A user had to risk real money to earn the right not to press every button.

---

## 2. The ruling

**Both halves of the choice offered in the brief were taken, because taking only
one leaves a road open.**

### (a) Simulated evidence DOES satisfy the promotion gate's demo evidence — labelled

The `demo_performance` gate is, by its own name and thresholds, about *demo*
trading. Demo trading is simulated by definition. Refusing simulated evidence at
that gate would not make the gate stricter — it would make it **unsatisfiable
except by real money**, which is the defect, not a fix.

So a paper/demo mission's closed simulated trades now feed
`demoWinRate` / `demoSampleSize`, **and every surface that shows or journals the
decision states what the evidence is**:

- `PromotionEvidence.demoEvidenceBasis` — `SIMULATED` | `BROKER_RECONCILED` |
  `MIXED` | `NONE` | `UNSTATED`.
- The `demo_performance` gate's own `detail` string ends with
  *"SIMULATED evidence — fills modelled from real quotes, not broker-reconciled
  money"*.
- `PromotionDecision.demoEvidenceBasis` + `evidenceNotes` ride every decision,
  approved or refused.
- The applied level is journalled and audited with the basis, and
  `promotionJson.lastGate` persists it.
- A persisted test result carries `evidenceBasis`; an older row with none reads
  `UNSTATED`, which is described as *"not stated — treated as unproven"* and is
  never assumed to be broker truth.

**The bar itself is unchanged.** Sample ≥ 20 and win rate ≥ 45% still apply; a
19-trade or a losing simulated record still fails, and the live-only gates
(explicit enablement, certificate, platform live switch) are untouched.

### (b) AND the demo→live inversion is closed

Simulated evidence unlocking the ladder is only honest if the ladder is the road.
If demo→live stayed free, a user could still skip the ladder to reach real money.
So `applyMissionExecutionMode` now additionally requires, for `demo → live`, the
ladder's **evidence bar** — the gates that first become mandatory at demo-auto
(level 3): `backtest_sample`, `forward_sample`, `demo_performance`,
`max_drawdown`, `agent_reliability`, `risk_rule_compliance`, `no_major_drift`.

`evaluateLadderEvidenceBar` (pure, `missionPromotionGate.ts`) deliberately
**excludes** the live-only gates and the guardrail ceiling: those remain enforced
where they already live, and this must not silently duplicate or relax them. An
unreadable mission or an evidence read that throws returns `passed: false` — an
unreadable proof is not a proof.

**Result: no path reaches an auto level, or real money, without evidence, and
neither road is easier than the other.**

---

## 3. Why the simulator is not fabrication

`lib/domain/src/profit-mission/missionFillSimulation.ts` (pure) +
`artifacts/api-server/src/lib/missionSimulatedFills.ts` (service).

| Requirement | How it is met |
|---|---|
| Real prices only | Every price comes from `routeQuote` — the market-data router's real quote at decision time. There is **no synthetic-price branch anywhere in either file.** A BUY fills at the real ask, a SELL at the real bid. |
| No quote → no fill | `NO_FILL_NO_QUOTE` / `NO_FILL_NO_USABLE_PRICE` / `NO_FILL_NO_DIRECTION` are typed refusals. The dispatch returns `ok:false`, the single-flight claim is **released**, the draft goes back to `approved`, and the refusal is journalled + audited. |
| Tagged at row level | `mission_trade_drafts.simulated = TRUE`, plus a dedicated `sim_*` column family. |
| Accounted separately | A simulated row's `pnl`, `r_multiple`, `closed_at`, `captured_profit`, `missed_profit` and `broker_ticket` stay **NULL forever**. Every consumer of realised money keys off `closed_at`/`pnl`, so a simulated outcome **cannot** reach a live realised total or an economic posting even if a future caller forgets to filter. `simulated = false` predicates on the realised readers are the second lock, not the first. |
| Assumptions on the row | `sim_json.assumptions` records spread crossing (**modelled**) and slippage, partial fills, commission/swap, latency and gap risk (**explicitly NOT modelled**) plus the exact quote — provider, timestamp, bid/ask — the price came from. |
| Exits on the same logic, real quotes | The exit sweep re-reads a real quote and applies stop → target → protective → window-ended, in that order. |

Two modelling choices worth naming:

- **Stop before target.** When one quote sits beyond both levels, the **stop**
  wins. The order in which price visited them is unknowable from a single quote,
  and assuming the favourable one would be a lie in the user's favour.
- **P/L from the mission's own planned risk**, not an invented contract size:
  `pnl = R × riskAmount`, where `R` uses the *actual* simulated fill for the move
  and the *planned* entry-to-stop distance as the unit — so the cost of entering
  away from plan lands in the number instead of vanishing. When either input is
  missing the P/L is **null**, reported as not derivable, never plugged with a
  zero. Unmodelled slippage is recorded as `NONE_MODELLED` rather than given an
  invented value; an invented cost is still an invented price.

A simulated stop may only be **tightened**, never widened
(`simulatedProtectiveLevels`) — AUTO authority may only reduce.

---

## 4. What a user sees

- `serialize` / `serializePulse` carry `accountingBasis`
  (`SIMULATED` | `BROKER_RECONCILED`), `currentValueSimulated`, and a plain
  `accountingLabel`. `live` and only `live` is money; an unknown mode reads
  SIMULATED.
- `progressJson.accounting` publishes **both** series side by side
  (`brokerReconciledProfit` and `simulatedProfit`) with the basis that actually
  drove `currentValue`. They are never summed.
- Milestone, target-lock and completion journal entries say
  *"on SIMULATED outcomes (paper/demo — not money)"* when that is the basis.
- The Battle Room's metric reads **"Current value (SIMULATED)"** for any
  non-live mission.

---

## 5. Schema

`docs/migrations-pending/fix-demo-ladder.sql` — additive, `IF NOT EXISTS`
throughout. Adds `simulated`, `sim_entry_price`, `sim_exit_price`, `sim_pnl`,
`sim_r_multiple`, `sim_mfe`, `sim_mae`, `sim_exit_reason`, `sim_json`,
`sim_opened_at`, `sim_closed_at` to `mission_trade_drafts`, plus two partial
indexes. No destructive statement; `drizzle-kit push` is not used.

---

## 6. Evidence

- `test:mission-demo-ladder-domain` (offline `ci` lane, appended to the end of
  the root chain) — 26 pure tests: no fill without a quote, spread crossing,
  stop-before-target, unknown-P/L-stays-null, the labelled gate, the evidence
  bar, the read-surface label.
- `test:mission-demo-ladder` (integration lane, `runIntegrationCiTests.ts`) —
  the DB-backed lifecycle: fill at the real quote, `NO_FILL_NO_QUOTE` releasing
  the claim, close at the target, **zero** simulated money in
  `resolveMissionRealisedStats` or `economic_postings`, mission progression and
  completion on the SIMULATED basis, the ladder unlocked by simulated evidence,
  and demo→live refused without the evidence bar.
- `check-mission-no-direct-execution` now scans `missionSimulatedFills.ts` too:
  the simulator is held to the same no-direct-execution / no-fabricated-
  randomness bar as every other mission surface.
