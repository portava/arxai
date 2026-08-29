# ARX AI — Algorithm Map

Single source of truth for **what the trading algorithm decides, where each
decision lives, and which behaviors are locked by regression tests**. This is a
preservation/verification document (Task #327): it describes the algorithm as it
is, names the deterministic test that pins each behavior, and records the one
evidence-based surgical patch that was applied.

> **Scope guard.** Nothing here is an execution path. Live broker dispatch is the
> 23-gate Phase B pipeline (`lib/domain/src/safety-contracts/`), which this work
> did **not** touch. The advisory/scanner/scalp/Ruby layers below only rank,
> advise, and explain — they never place or gate a live order.

---

## 1. Flame scalp engine

- **Where:** `artifacts/api-server/src/lib/scalp/scalpEngine.ts` (read),
  `scalpManage.ts` (basket management + add-ons), `flameRead.ts`, `scalpTypes.ts`.
- **What it decides:** the structured *flame read* for a symbol — `scalpStatus`
  (STRONG/POSSIBLE/WEAK/NOT_A_SCALP), `flameStage`, `entryTiming`, `chaseRisk`,
  `runway`, `scalpScore`, and a `blind` honesty flag when the candle window is too
  thin to read. From an open basket it derives an **add-on verdict** (how much, if
  anything, it is sane to scale into on the same side).
- **Honesty invariants:**
  - Thin/absent data ⇒ `blind: true` honest NONE read — never a fabricated flame.
  - Stage splits (IGNITING vs RUN_ON, etc.) key off extension measured in ATR;
    determinism in tests requires a real ATR baseline (flat candles collapse ATR).
- **Add-on tier table (0–3):** `baseAddOnTier()` forces tier **0** for any
  dead stage (EXHAUSTED/REVERSAL_RISK/FAILED), fading stage (WEAKENING/STRETCH),
  `chaseRisk === EXTREME`, `runway === NONE`, blind read, or NOT_A_SCALP. A live
  flame earns 1–3 by strength, softened by late timing / tight runway / high chase.
- **Revenge-trade guard:** never suggests averaging-down a losing basket unless the
  flame is *freshly re-igniting* in the basket's favour, and then only one cautious
  add. Add-ons are **advice only** (ALERT_ONLY) — the system never scales a basket
  on the user's behalf.
- **Locked by:** `scalp/__qa__/scalpAddonTiers.test.ts` (21),
  `scalpAddonForcedZero.test.ts` (14), plus existing `scalpEngine.test.ts` /
  `scalpManage.test.ts` (44).

## 2. Market scanner truth caps

- **Where:** `artifacts/api-server/src/lib/marketScanner.ts`
  (`computeFinalRead`, `computeNewsDecisionRead`).
- **What it decides:** the user-facing confidence label for a scanned opportunity
  (e.g. HIGH / MEDIUM / LOW / TRADE_WATCH / NO_TRADE) fused across technicals,
  news, and history.
- **Honesty invariants (monotonic, downward-only caps):**
  - A **non-live** data source can never reach HIGH or TRADE_WATCH.
  - SIMULATOR data is floored to LOW.
  - Stale feed ⇒ downgrade.
  - News/history **unavailable** ⇒ honest "feeds unavailable — read is
    technicals-only" and reduced confidence; it never *invents* a catalyst.
  - Technical/news/history **conflict** ⇒ downgrade.
  - Caps only ever lower a read, never raise it.
- **Locked by:** `__qa__/scannerTruthCaps.test.ts` (13; run with
  `--test-force-exit` — importing the scanner starts a simulator interval that
  otherwise blocks process exit).

## 3. Agent advisory + governance (Agent Ecosystem)

- **Where:** `lib/domain/src/agent-system/advisory/agentAdvisory.engine.ts`
  (`computeAgentAdvisory`), `governance/agentCourt.engine.ts`
  (`computeGovernanceReview`).
- **What it decides:** a **ranking/visibility** adjustment only. Advisory nudges a
  base score within strict bounds; governance reviews the contributions and can
  only *lower* the resulting rank or flag it for review/escalation.
- **Advisory bounds (locked):** net adjustment ∈ [−15, +15]; per-agent |delta| ≤ 8;
  `adjustedScore = clamp(base + netDelta, 0, 100)`. A pure-shadow agent
  (`authorityWeight 0` / SHADOW status) has **zero** effective influence.
  Distressed statuses (WARNING/PROBATION/RESTRICTED) are *damped* (0.5×) and set
  `hasUntrustedResponsibleAgent`; fully-muted statuses
  (LEARNING_CAMP/SHUTDOWN_RECOMMENDED/ARCHIVED) contribute exactly 0.
- **Governance protective invariant (locked):** `governanceScore ≤ advisoryScore`
  always; the review output carries **no execution field** (no execute / order /
  dispatch / live key). Every outcome is reachable and deterministic: `approved`,
  `approved_with_caution`, `rejected`, `downgraded`, `escalated`, `needs_more_data`,
  `delayed_speed`, `muted_low_confidence`, `learning_camp_review`. With no agent
  standing it is a pure pass-through (`governanceApplied: false`, no haircut).
- **Locked by:** `__qa__/governanceAdvisoryRuby.test.ts` (20).

## 4. Ruby (assistant) copy discipline

- **Where:** `lib/domain/src/security/userCopySafety.ts`
  (`findInternalLeaks`, `isUserCopyClean`, `scrubUserCopy`, `scrubUserCopyDeep`).
- **What it guarantees:** regular-user assistant copy never leaks backend
  internals — SCREAMING_SNAKE gate/env codes, `/api/...` route paths,
  system-prompt references, or secret shapes (sk- keys, JWTs). Clean plain-English
  passes through unchanged; deep scrub recurses objects/arrays and leaves
  non-strings intact. (Role-gating of *which* surfaces Ruby exposes is enforced at
  the route layer and covered by the existing route-containment/admin-gate suites,
  not duplicated here.)
- **Locked by:** the Ruby-discipline cases in
  `__qa__/governanceAdvisoryRuby.test.ts`.
- **Derived safety-state honesty:** what Ruby *reports* about the account's
  live-state (`liveLocked` / `safetyMode` / `readOnlyMode` / `allowOrderExecution`)
  is **derived per-user** from `getEnvelope()` (shared `deriveAssistantEnvelope`
  helper, fail-closed to off/locked) on every conversational surface, the
  `getTradingMode` / `getPaperSafetyStatus` tools, the `read-chart` /
  `explain-signal` reads, the realtime voice bootstrap, and the system prompt —
  never a static `paper_only` constant, and honest in both directions (a real
  blocker surfaces as its specific gate reason, not a generic lock). This is
  **reporting only**: it never changes the order-guard chain, the 23-gate Phase B
  dispatch, or the explicit per-trade confirm step, and read surfaces still place
  no orders. The read-only chart-brain / decision surfaces (`draw-setup`,
  `draft-read` — the latter's OpenAPI response pinned to `safetyMode: paper_only`)
  keep the forced `READ_ONLY_PAPER_ENVELOPE` constant.
  - **Locked by:** `scripts/src/rubySafetyEnvelopeDerivedTest.ts` + the
    `ruby-derived-safety-envelope` CI guard.

## 5. Market data routing (honesty about non-contributing feeds)

- **Where:** `artifacts/api-server/src/lib/data/marketDataRouter.ts`.
- **Behavior:** every asset-class chain reserves the top `mt5_broker` slot. Until
  the EA pushes ticks/candles, that slot fails fast with
  `MT5_BROKER_FEED_NOT_ACTIVE` (or `MT5_BROKER_NO_CANDLES_FOR_SYMBOL`) and the
  router falls through to Deriv (synthetic) or the composite assistant provider.
  Candles are real or an honest empty state — never simulator/master-account data.

---

## Surgical-gap audit (Task #327 · T006) — evidence-based

| Area | Verdict | Evidence |
|---|---|---|
| **Add-on personality forced-zero** | **GAP → patched (T007)** | `maxAddOns` was `clampTier(baseAddOnTier + personalityShift)`; AGGRESSIVE/OWNER_ADMIN (+1) resurrected a forced-0 dead/fading/extreme-chase/no-runway flame to tier 1 (`allowed: true`). Proven by 12 failing assertions in `scalpAddonForcedZero.test.ts` before the patch. |
| **Historical depth / unavailable history** | Honest, no patch | `computeNewsDecisionRead` reduces confidence and labels the read technicals-only when history is absent. Locked by `scannerTruthCaps.test.ts`. |
| **News wiring** | Honest, no patch | Scanner consumes news with explicit unavailable handling; the governance NEWS-challenge path is conditional/fail-open (fires only when a NEWS agent participates with weight) and is advisory-only, never a gate. |
| **Stale-penalty coverage** | Honest, no patch | Stale feed ⇒ downgrade is exercised in `scannerTruthCaps.test.ts`. |
| **MT5 candle non-contribution** | Honest, no patch | `marketDataRouter.ts` fails fast with `MT5_BROKER_FEED_NOT_ACTIVE` and falls through; documented as a known reserved-but-inactive slot. |

### Patch applied (T007)

`scalpManage.ts` `evaluateAddOn`: the personality tier shift is now applied **only
when the base tier is already alive** (`baseTier > 0`); a forced-zero flame stays
0 for every personality including AGGRESSIVE/OWNER_ADMIN. CONSERVATIVE still
narrows, AGGRESSIVE/OWNER still widen a *live* flame (no over-correction). This is
the single behavior change in Task #327 — protective, evidence-led (failing → green),
no threshold retune, no broadening, no double-penalty.

---

## Running the locks

```bash
pnpm --filter @workspace/api-server run test:algorithm-locks   # all 4 lock suites (68)
pnpm --filter @workspace/api-server run test:scalp-addon-tiers
pnpm --filter @workspace/api-server run test:scalp-addon-forced-zero
pnpm --filter @workspace/api-server run test:scanner-truth-caps
pnpm --filter @workspace/api-server run test:governance-advisory-ruby
```
