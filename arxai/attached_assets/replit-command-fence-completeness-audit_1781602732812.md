# COMMAND — FENCE COMPLETENESS AUDIT (the display-contract import boundary may have holes)

Read this entire command before changing anything. The `display-contract-import-boundary` guard (`scripts/src/ci/check-display-contract-import-boundary.ts`) was hardened extensively against exotic IMPORT SYNTAX, but its `FENCED_DIRS` list may be INCOMPLETE — there are execution/safety-adjacent directories that are NOT fenced, meaning a file in one of them could import the `mayShow*` display flags and the guard would never inspect it. A perfect lock on 14 doors is worthless if other doors have no lock. **Audit the fence for completeness, then close the real gaps.** Read LIVE source. Investigate before editing.

## THE GAP (verified)

`FENCED_DIRS` currently fences: `safety-contracts`, `kill-switch`, `order-execution`, `execution-gate`, `risk-governor` (domain); `live`, `liveTrading`, `mt5`, `broker`, `brokerReadOnly`, `governance`, `risk`, `riskGovernor`, `paperExecution` (api-server) + 4 root files.

But these execution/safety-adjacent dirs are NOT fenced and EXIST:
- **api-server/lib:** `execution/` (NOT fenced — only `paperExecution` is!), `selfTrade/`, `tradeAction/`, `tradeManagement/`, `safety/`, `safetyCore.ts`, `bridgeV2/`, `bridgeAllocations.ts`, `autopilot.ts`, `paperAutopilot/`, `adminTrading/`, `fundbook/`, `tradingviewWebhook.ts`
- **domain/src:** `conditional-execution`, `execution-ai`, `execution-intelligence`, `execution-microstructure`, `execution-preview`, `execution-pyramid`, `execution-realism`, `execution-safety`, `confidence-gate`, `safety-permission`, `trade-court`, `live-position`, `live-inputs`, `portfolio-risk`, `news-risk`, `self-trade`, `trade`, `trade-plan`, `trade-advisor`

## STEP 1 — CLASSIFY EVERY UNFENCED CANDIDATE (read-only, report before fencing)

For EACH directory/file listed above (and any other execution/safety/trade dir you find under `artifacts/api-server/src/lib/` and `lib/domain/src/`), determine its actual role and classify:

- **MUST FENCE (class X):** the module can GATE, SIZE, ROUTE, AUTHORIZE, PRICE, or otherwise DECIDE whether a real or paper order is placed/queued/modified/closed — i.e. it is part of the execution or trade-safety decision path. Display readability flags must never enter these.
- **DISPLAY/READ-ONLY (class D):** the module only reads/records/presents (history, previews, advice, coaching, analytics) and never decides order placement. Fencing is unnecessary (and these may legitimately consume the display contract).
- **UNCLEAR (class U):** can't tell from a quick read — needs the deeper look in step 2.

For each, report: dir/file, one-line role, whether it imports or transitively reaches order-placement/gate logic, and the classification. Use grep for the tells: does it import the live pipeline / `dispatchLiveCommand` / `createLiveDraft` / the MT5 command path / order-queue / sizing / the 18-gate / `tradeSignalAllowed` / arming, or write to the live/demo command tables?

## STEP 2 — RESOLVE THE UNCLEAR ONES + CHECK FOR EXISTING LEAKS

- For class U, read enough of the module to decide X vs D. When genuinely ambiguous, default to **FENCE** (a false fence on a display-only module is harmless noise; a missing fence on an execution module is a real hole).
- CRITICAL: for every dir you classify as MUST-FENCE, grep it RIGHT NOW for existing imports of the display contract / `mayShow*` flags / the `@workspace/domain/market` barrel. If any MUST-FENCE module ALREADY imports them, that is a REAL CURRENT LEAK (the guard never caught it because the dir wasn't fenced) — report it prominently. It must be decoupled (the execution module should depend on its own gate logic / `canShowTradeSetup`-style eligibility, never the display flags).

## STEP 3 — REPORT AND (only after the classification is clear) FENCE

Report the full classification table FIRST. Then:
- Add every class-X dir/file to `FENCED_DIRS` / `FENCED_FILES` in the guard.
- If any existing leak was found in step 2, fix that import (decouple the execution module from the display contract) — this is the one behavior change; keep it minimal and do NOT alter execution logic, only the offending import/typing.
- Re-run `pnpm run ci:guards` and confirm it still passes (newly-fenced dirs should be clean unless step 2 found a leak you just fixed). Report the new fenced-file count.

## STEP 4 — (OPTIONAL, ONLY IF TIME) NOTE THE GUARD'S DEAD WEIGHT — DO NOT REMOVE YET

While in the file, you may NOTE (in the report, not by editing) which detectors are redundant given the specifier-position rule + the `require` presence-ban: the namespace/`export *`/dynamic-import/bracket-`require`/tagged-template detectors defend against syntax not present in the codebase. Do NOT delete them in this task — the guard passes and is correct; removing detectors is a separate, deliberate cleanup. Just record which are load-bearing (forbidden-symbol direct + barrel import, specifier-position, `require` presence-ban, and a COMPLETE `FENCED_DIRS`) vs redundant, so a future cleanup has the map.

## NON-NEGOTIABLE

- This task is about the FENCE (which dirs are guarded), not the detection syntax. The only code change beyond `FENCED_DIRS`/`FENCED_FILES` is fixing a real leak if step 2 finds one.
- Do NOT change any execution/order/gate/risk/sizing logic. Do NOT weaken the guard. Do NOT remove detectors in this task.
- When unsure whether a dir decides order placement, FENCE it (safe default).

## REPORT

The full classification table (every execution/safety/trade dir → X/D/U → role → reaches-order-logic?); any EXISTING leak found in a previously-unfenced MUST-FENCE dir (and the minimal decoupling fix); the dirs/files added to the fence; the new fenced-file count; `ci:guards` result; and the noted load-bearing-vs-redundant detector map (no detector removed).

## COMPLETION STANDARD

- Every directory/file that can gate/size/route/authorize/price an order (real or paper) is in `FENCED_DIRS`/`FENCED_FILES`.
- Any existing display-contract leak in a previously-unfenced execution module is found and decoupled (minimal import fix, no logic change).
- `ci:guards` passes with the expanded fence; the new fenced-file count is reported and is meaningfully higher than 105.
- No execution logic changed; no detector removed; the guard is not weakened.
- The report classifies every candidate dir and names which detectors are load-bearing vs redundant (for a future cleanup, not done here).
