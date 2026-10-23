# ARX AI — Take Profit Targets on Every Recommendation (Phase TW)

**Date:** 2026-05-17
**Scope:** Add multi-target Take Profit (TP1 / TP2 / TP3) to every AI trade recommendation surface. No rebuild. No redesign. No new recommendation system. No bypass of any safety lock.

---

## 1. Recommendation files inspected

| File | Role | Existing TP shape |
|---|---|---|
| `artifacts/api-server/src/lib/assistant/liveScanner.ts` | Deterministic real-candle scanner; source of truth for AI recommendations | Single `takeProfit: number` (=2R) |
| `artifacts/api-server/src/lib/assistant/tools.ts` `getMarketScannerOpportunities` | AI tool exposing scanner output | Pass-through of single `takeProfit` |
| `artifacts/api-server/src/lib/assistant/systemPrompt.ts` | AI behavioral contract | No explicit TP1/2/3 guidance |
| `artifacts/api-server/src/lib/paperAutopilot/sniperFilter.ts` | Paper-autopilot sniper scoring (PAPER ONLY, not user-facing) | Single `takeProfit` for RR calc |
| `artifacts/api-server/src/lib/strategyEngine.ts` | Simulated strategy candidates | Single `takeProfit` per signal |
| `artifacts/api-server/src/lib/tradeAction/orderTicketValidation.ts` | Backend trade-ticket validator | TP direction validation **already present** at L195–199 (BUY: TP>entry; SELL: TP<entry) |
| `artifacts/api-server/src/routes/pendingOrderDraft.ts` `PendingDraftSchema` | Draft persistence | `takeProfit: z.number().nullable().optional()` |
| `artifacts/api-server/src/lib/tradeAction/create.ts` | Action-draft creation | Single `takeProfit` |
| `artifacts/api-server/src/routes/opportunityRadar.ts` | Watchlist intelligence route | Pass-through of currentOpportunity from radar engine |
| `artifacts/trading-dashboard/src/components/trading/QuickTradeModal.tsx` | Manual trade ticket UI | Single `tp` input |

## 2. Files changed

| File | Change |
|---|---|
| `artifacts/api-server/src/lib/assistant/liveScanner.ts` | Added `TakeProfitTarget` type. Added `takeProfitTargets[]`, `targetsUnavailableReason`, `bestTargetLabel` to `LiveCandidate`. New `buildTpTargets()` computes TP1/TP2/TP3 from same real candles + ATR projection + swing extremes, direction-validated, honest-fallback on insufficient data. Existing `takeProfit: number` field preserved for backward-compat with sniper/QuickTrade/draft consumers. |
| `artifacts/api-server/src/lib/assistant/tools.ts` | `getMarketScannerOpportunities` now propagates `takeProfitTargets`, `bestTargetLabel`, `targetsUnavailableReason` on every candidate. Tool description updated to teach the new shape and the never-fabricate rule. |
| `artifacts/api-server/src/lib/assistant/systemPrompt.ts` | Appended Phase TW section: required recommendation shape (TP1/TP2/TP3 + reason + RR + data status + confirmation warning), sniper-specific guidance, never-promise-profit / never-bypass-confirmation rules. |

**Not changed (intentional):**
- `sniperFilter.ts` — paper-autopilot only, not a user-facing recommendation surface; consumes single `takeProfit` for RR scoring. Sniper user-facing badges come from `liveScanner.statusBadge="HOT_SETUP"` which now carries `takeProfitTargets` automatically.
- `strategyEngine.ts` — simulator output used internally by paper-autopilot; not surfaced as user recommendations.
- `orderTicketValidation.ts` — TP direction validation already exists; no change needed.
- `pendingOrderDraft.ts` `PendingDraftSchema` — single-TP draft schema unchanged (user selects ONE TP from TP1/2/3 in UI then submits). Backend revalidates via existing `enforceTradeTicketRules`.
- Frontend recommendation cards — see "Limitations" below.

## 3. AI behavior changed

`systemPrompt.ts` now requires that whenever the assistant recommends a trade (sniper / scanner / "what should I trade" / "where to TP"), the response uses the EXACT TP1/TP2/TP3 prices, reasons, and RR values returned by `getMarketScannerOpportunities` — and includes:

- Setup type, direction, entry, stop loss / invalidation
- TP1 (partial — high confidence), TP2 (primary — medium), TP3 (runner — low certainty if applicable)
- Overall RR from the scanner
- Data status (live / preview / delayed / incomplete / bridge disconnected)
- Confirmation warning on every recommendation

Sniper-specific additions: time sensitivity, management plan (partial at TP1, optional BE move per user strategy, hold runner only on momentum confirm), sniper-risk warning when confidence<medium or RR<1.5.

Explicit prohibitions reinforced: no profit promise, no certainty, no fake live data, no auto-place, no auto-edit TP, no confirmation bypass, no risk-governor bypass.

If `targetsUnavailableReason` is set, the assistant must say "Take Profit unavailable — <reason>" and refuse to invent prices.

## 4. Scanner / radar behavior changed

`getMarketScannerOpportunities` now returns each opportunity with:
```
{
  symbol, timeframe, bias, recommendedAction, setupType,
  confidenceScore, riskScore, riskRewardRatio,
  reasonForTrade, reasonToAvoid, statusBadge, opportunityLabel,
  entry, stopLoss, takeProfit,                  // unchanged
  takeProfitTargets: TakeProfitTarget[],         // NEW
  bestTargetLabel: "TP1"|"TP2"|"TP3"|null,       // NEW
  targetsUnavailableReason: string | null,       // NEW (honest fallback)
  generatedAt
}
```

`opportunityRadar.ts` is a pass-through of `liveScanner` output — gains `takeProfitTargets` automatically. No route change required.

Scanner skip behavior unchanged: when provider has no candles or returns <10 bars for a (symbol, TF), that pair is silently skipped — TP targets are NEVER fabricated from missing data.

## 5. Trade ticket prefill behavior

Backend trade-ticket flow unchanged in this slice — user still submits ONE `takeProfit` value per draft (the value they selected from TP1/2/3 in the UI, or a manual override). Backend revalidation:
- `orderTicketValidation.ts:195–199` enforces BUY → tp>entry, SELL → tp<entry (already existed; verified, not modified)
- `enforceTradeTicketRules` runs on `/me/pending-order-draft/:id/submit` already (Phase TV)
- `enforceRiskGovernor` runs in the same chain — unchanged authority

Frontend Quick-Trade modal still uses single `tp` input today. Adding TP1/TP2/TP3 selector chips is a UI-only follow-up (see Limitations).

## 6. TP target model added

```ts
export interface TakeProfitTarget {
  label: "TP1" | "TP2" | "TP3";
  price: number;
  reason: string;
  rr: number;                                  // reward/risk; computed from same stopDist as SL
  distancePoints: number;
  distancePips: number;                        // price-units * 10000 (no JPY adjust yet — see Limitations)
  suggestedAction: "partial" | "full" | "runner";
  confidence: "low" | "medium" | "high";
}
```

Compute logic in `liveScanner.ts` `buildTpTargets()`:
- **TP1** = entry ± 1R · stopDist — partial, high confidence; reason cites swing-extreme liquidity when the prior swing actually sits past TP1, else "1R from entry — conservative"
- **TP2** = entry ± 2R · stopDist — full, medium confidence; "2R primary; balanced reward vs follow-through risk"
- **TP3** = entry ± max(3R, ATR projection) · stopDist — runner, low confidence; reason names actual R multiple when ATR-projected
- Direction guard drops any target that violates BUY→tp>entry or SELL→tp<entry
- If `stopDist` is non-finite or zero → `targets:[]`, `targetsUnavailableReason: "Insufficient market structure to compute take-profit targets — stop distance unavailable."`
- If all candidates fail direction validation → `targets:[]`, honest reason

## 7. Risk/reward calculation status

- RR per target = `|tp − entry| / stopDist` (stopDist is the same value used to set the SL)
- TP1 RR = 1.0, TP2 RR = 2.0, TP3 RR = max(3.0, atrR) rounded to 2 decimals
- Overall `riskRewardRatio` on the candidate still reports 2.0 (= TP2 main target) for backward compat
- If the user submits a draft with SL missing, `orderTicketValidation` already returns "riskRewardRatio: null" — no fabrication

## 8. Tests run

- `pnpm run typecheck` — **PASS** (4 packages)
- `pnpm run ci:guards` — **11/11 PASS** (2.32s) — `paper-autopilot-isolation`, `live-trading-readiness-lock`, `live-order-risk-limits`, etc.
- `pnpm --filter @workspace/api-server run qa:stop-limit` — **8/8 PASS**
- Manual verification (code inspection):
  - BUY direction → all TP prices > entry (filter at L111)
  - SELL direction → all TP prices < entry (filter at L111)
  - stopDist=0 path → `targets:[]` + honest reason (L83)
  - Missing-data path → scanner skips pair upstream; no fabricated targets

## 9. Limitations

- **Frontend recommendation cards** still display a single TP today. `takeProfitTargets[]` now flows through the API; rendering TP1/TP2/TP3 chips on the scanner card + QuickTrade prefill is a small additive UI follow-up — intentionally deferred from this slice ("Do NOT redesign") and ready for the next user-approved frontend slice.
- **Pips conversion** is `price * 10000` — correct for major FX pairs, off by 100x for JPY pairs. Symbol-aware pip sizing requires a symbol-metadata lookup; out of scope here. `distancePoints` is always exact.
- **TP3 ATR projection** uses `avgRange * 4` as a cap heuristic; future Phase could swap in true ATR(14) once added to the candle pipeline.
- **Sniper user-facing surface** today inherits TP targets via the scanner's `HOT_SETUP` badge — there is no separate sniper-only recommendation tool to update.

## 10. Confirmation: no auto-trade / auto-TP without confirmation

CONFIRMED. No new mutation paths added. Recommendation output is pure data — placing or modifying any order still requires the user to confirm in QuickTrade or `/me/pending-order-draft/:id/submit` with `confirmedByUser:true`, which then passes through `enforceTradeTicketRules` + `enforceRiskGovernor` + `queueMt5CommandWithGate` (Phase TV chain). The gate's `BLOCKED` hardcode remains intact — no command reaches the broker under the paper-only lock.

## 11. Confirmation: no fake live market data

CONFIRMED. `liveScanner.ts` skips any `(symbol, timeframe)` pair where the provider returns no candles or <10 bars — exactly as before Phase TW. TP targets are computed from the same real candles used to score the candidate. If `stopDist` is non-finite (i.e. candle data was degenerate), `targets:[]` with `targetsUnavailableReason` — never fabricated. `getMarketScannerOpportunities` returns empty when `liveDataConnected:false`. The assistant is instructed to surface "Take Profit unavailable — <reason>" whenever the tool reports unavailable targets.

## 12. Confirmation: risk governor & confirmation guards still enforced

CONFIRMED. No change to:
- `enforceRiskGovernor`
- `enforceTradeTicketRules`
- `queueMt5CommandWithGate` `BLOCKED` hardcode (`mt5.ts:662`)
- `orderTicketValidation` TP direction enforcement
- `confirmedByUser:true` requirement on submit / cancel-via-bridge / modify-protection routes
- 11/11 CI guards including `paper-autopilot-isolation` and `live-trading-readiness-lock`
