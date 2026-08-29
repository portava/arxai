# COMMAND — DATA-SUFFICIENCY TRUTH · PHASE 2 (trade-ticket + backtest, block-only)

Read this entire command before changing anything. Phase 1 (the shared `evaluateMarketDataSufficiency` engine, consumed by scanner/Ruby/chart) is merged and verified. Phase 2 extends the SAME verdict to two surfaces that touch the live/historical paths: the trade-ticket/entry flow and backtesting. **The verdict can ONLY block or downgrade — it can NEVER grant trade-eligibility or execution.** **Read LIVE source** — the archive predates Phase 1. Do not mark complete until the COMPLETION STANDARD passes with pasted evidence.

## THE ONE PRINCIPLE (everything else follows from this)

The sufficiency verdict is a DATA-QUALITY gate, not a trade-permission engine. In Phase 2 it gains the power to STOP a trade from being placed when data is insufficient/partial/stale/blocked — but it gains NO power to allow one. A `sufficient` / `canShowTradeSetup: true` result means ONLY "data is good enough to proceed to the existing gates"; the existing live gates then decide, with final authority, whether the trade can actually be placed.

## NON-NEGOTIABLE RULES

1. **ADD a gate; remove/weaken NONE.** The sufficiency check is ANDed in FRONT of the entire existing live chain — the 23-gate evaluator, `evaluateSyntheticLiveFloor`, SL policy (`requireStopLoss`/`MISSING_STOP_LOSS`), caps, kill switch, master-live access, the per-symbol live-confirmation, Focus lock. Every one of those still runs and still has final say. If sufficiency passes, NOTHING downstream changes. If sufficiency fails, the trade is blocked BEFORE reaching them.
2. **NEVER grant.** There is no code path where the sufficiency verdict causes a trade to be allowed that the existing gates would have blocked. It can only add a block. Prove this.
3. **`canShowTradeSetup` / `tradeSetupAllowed` is NOT execution permission.** Do not read it as authorization to dispatch. The trade ticket may use it to decide whether to SHOW the setup / enable the build affordance; the actual placement still goes through the full gate chain regardless.
4. **Lockstep at preflight AND dispatch.** Like the synthetic floor, the sufficiency block must be evaluated at BOTH the preflight (`createLiveDraft`) and dispatch (`dispatchLiveCommand`) stages on the row's own symbol+timeframe — so a draft that was sufficient at build time but goes insufficient before dispatch is re-blocked at dispatch (no TOCTOU hole). Mirror exactly how `evaluateSyntheticLiveFloor` is wired at both stages.
5. **Position management is exempt.** Closing/modifying/cancelling an existing position is NEVER blocked by sufficiency — only NEW entries (`PLACE_LIVE_MARKET_ORDER` / `PLACE_LIVE_PENDING_ORDER`). A close/modify/cancel must work even on insufficient data (you must be able to exit a position when data is thin). Verify the command type before applying the block.
6. **Compose, don't re-derive.** Phase 2 calls the EXISTING Phase-1 engine. It must NOT introduce a second sufficiency computation. One engine, now consumed by trade-ticket and backtest too.
7. **Backtest is display-only.** The backtest change adds a reliability/quality badge driven by the verdict — it does NOT block running a backtest, and it does NOT touch live execution. It must not present a backtest on thin/stale/insufficient historical data as reliable.

## PART A — TRADE-TICKET / LIVE ENTRY (block-only, lockstep)

### A1. Backend gate (the real protection)
In `liveCommandPipeline.ts`, for NEW-ENTRY command types only, add a sufficiency check at BOTH chokepoints, alongside where `evaluateSyntheticLiveFloor` is called:
- Preflight (`createLiveDraft` path, ~where the synthetic floor preflight check lives): compute the Phase-1 verdict for the order's symbol+timeframe. If `sufficiencyStatus` is `insufficient` / `partial` / `blocked` (i.e. `canShowTradeSetup` false), REFUSE the draft with a NEW reason `INSUFFICIENT_DATA_FOR_ENTRY` (TECHNICAL / not-broker-enforced), carrying the verdict's `humanReason`, no broker send.
- Dispatch (`dispatchLiveCommand` path, ~where the synthetic floor dispatch re-check lives): re-evaluate the same verdict on the row's symbol+timeframe and re-block with the same reason if it's no longer sufficient. This closes the build-time-sufficient → dispatch-time-insufficient TOCTOU window.
- Consider routing both through one tiny shared check (as the synthetic floor does via its shared contract) so preflight and dispatch cannot drift.
- The check is ADDITIVE and runs BEFORE/ALONGSIDE the existing gates — it does not replace the synthetic floor, SL, or any gate. If sufficiency passes, the existing chain runs unchanged.

### A2. Trade-ticket UI
The trade-ticket / one-click entry UI (`meOneClick`/`instantTrade`/`meLive` surfaces and their frontend): when the verdict for the selected symbol+timeframe is not `sufficient`, the entry affordance (Buy/Sell/Build) is disabled or shows the honest reason ("Not enough closed candles" / "Live feed delayed" / "Waiting for live feed" / "Not on approved list") — using the SAME `humanReason` the scanner/Ruby show. Do NOT show an armed, clickable Buy/Sell on insufficient data. (This is UX; the backend gate in A1 is the actual enforcement — both must be present.)

### A3. The naming guard holds
`canShowTradeSetup` controls whether the SETUP is shown — it is not consulted as execution permission. Execution permission remains the result of the existing gate chain only. Add/keep the test asserting no sufficiency field is treated as trade authorization.

## PART B — BACKTEST (display badge only, no blocking, no execution)

In the backtest surface (`validationPipeline.ts` / `paperTrading.ts` and the backtest UI): when presenting results, compute/attach the sufficiency verdict for the tested symbol+timeframe and show a reliability badge (Ready / Partial data / Stale data / Not enough candles / Blocked) so a backtest run on thin/stale/insufficient data is not presented as trustworthy. This does NOT block running the backtest and touches NO live path. If the historical data was insufficient, the report must say so honestly rather than implying a reliable result.

## TESTS

1. ENTRY BLOCKED ON INSUFFICIENT: a NEW-entry draft for a symbol with `insufficient` data (<5 closed bars) → refused at preflight with `INSUFFICIENT_DATA_FOR_ENTRY`, no broker send. Same for `partial`/`stale` and `blocked` (unapproved).
2. DISPATCH RE-BLOCK (TOCTOU): a draft sufficient at preflight but insufficient at dispatch → re-blocked at dispatch with the same reason. (Mirror the synthetic-floor stale-between-stages test.)
3. SUFFICIENT PASSES THROUGH UNCHANGED: a `sufficient` entry is NOT blocked by the sufficiency gate and proceeds to the existing chain — and the existing chain (synthetic floor, SL, gates) STILL runs and STILL has final say (e.g. a sufficient-but-no-stop-loss order is still blocked by `MISSING_STOP_LOSS`; a sufficient-but-delayed-synthetic is still blocked by the synthetic floor). Prove sufficiency did not bypass anything.
3b. NEVER-GRANT: there is no input where adding the sufficiency gate causes a trade to be ALLOWED that the existing gates would have blocked. Assert the gate is block-only.
4. POSITION-MGMT EXEMPT: a close/modify/cancel command on an insufficient-data symbol is NOT blocked by sufficiency.
5. NAMING: no field named `tradeSignalAllowed`/`tradeExecutionAllowed`/`canTrade` is emitted or read as execution permission; `canShowTradeSetup` is display-only.
6. BACKTEST BADGE: a backtest on insufficient/stale historical data shows the honest reliability badge and is not marked reliable; running the backtest is NOT blocked.
7. LIVE-PATH REGRESSION: the existing synthetic-floor, SL tripwire, dispatch, and gate-evaluator tests ALL still pass unchanged.
8. Phase-1 sufficiency + freshness + Focus tests stay green.

## VERIFY + QA

Run for real, paste outputs: `typecheck:ci`, `pnpm run ci:guards`, all new + existing tests (especially the live-path suites — synthetic floor, SL, dispatch).

Authenticated QA (mint a temp session; do NOT place a real order — stop at the block or the confirm boundary):
- For a symbol with insufficient data (thin closed bars), attempt a NEW entry → confirm it is BLOCKED with `INSUFFICIENT_DATA_FOR_ENTRY` at preflight, and the trade-ticket UI shows the honest disabled state with the shared reason. Screenshot the blocked state.
- For a sufficient symbol, confirm the entry proceeds to the existing confirm/gate flow (stop at the confirm boundary — do NOT dispatch a live order) and that the existing gates still apply (e.g. no-SL still blocks).
- Confirm a close/modify on an insufficient-data symbol is NOT blocked.
- Show a backtest on thin/stale data rendering the honest reliability badge.

## FINAL REPORT

The preflight + dispatch sufficiency checks (side by side, same condition, lockstep); the new `INSUFFICIENT_DATA_FOR_ENTRY` reason; proof it's ADDITIVE (sufficient still runs the full existing chain; no-SL/synthetic-floor still block) and BLOCK-ONLY (never grants); the position-management exemption; the trade-ticket UI disabled state; the backtest reliability badge; the naming guard; tests + results (live-path suites green); the blocked-entry QA screenshot; and explicit confirmation that NO existing gate, the synthetic floor, SL policy, kill switch, or owner/admin relaxation was modified or weakened, and the engine was not re-derived.

## COMPLETION STANDARD — all must be true

- The sufficiency verdict blocks NEW live entries on insufficient/partial/stale/blocked data at BOTH preflight and dispatch (lockstep, `INSUFFICIENT_DATA_FOR_ENTRY`), and the trade-ticket UI shows the honest disabled state — never an armed Buy/Sell on insufficient data.
- The gate is ADDITIVE and BLOCK-ONLY: a `sufficient` order still passes through the full existing chain (synthetic floor + SL + 23 gates) which retains final authority; there is no path where sufficiency GRANTS a trade the gates would block.
- Position management (close/modify/cancel) is NOT blocked by sufficiency.
- Backtest shows an honest reliability badge driven by the same verdict; it does not block runs and does not touch live execution.
- The engine is the Phase-1 one (not re-derived); no field reads as execution permission.
- `typecheck:ci` green; `ci:guards` green; all new + existing tests pass — including the unchanged synthetic-floor / SL / dispatch / gate suites — outputs pasted.
- No existing gate, synthetic floor, SL policy, kill switch, or owner/admin relaxation was modified or weakened.
