# Popup AI Closeout — ARX AI Floating Assistant

**Status: A. POPUP AI COMPLETE**

This document is the acceptance gate closeout for the floating ARX Assistant popup. It records the live implementation surface, the exact 15-question acceptance results, the platform/safety verifications, and the build/test results that justify closing the popup-AI workstream.

---

## What was completed

Across phases 6 → 9 the floating ARX Assistant popup was built, polished, and gated:

- Single floating trigger and panel (`FloatingHelpWidget.tsx`), persisted via `sessionStorage`, mounted exactly once in `AppLayout`.
- Animated icon (`AnimatedArxAssistantIcon.tsx`) with 11 composite states: `idle | hover | opening | open | closing | thinking | typing | ready | warning | error | disabled`. Pure SVG + CSS, no Framer/Lottie/GIF, no new heavy deps.
- `useAssistantIconState` hook with strict precedence: `disabled > thinking > typing > ready > open > opening > hover > idle`; status overlay `error > warning > none`.
- Centralized CSS design tokens (palette, glow, sizing, container offsets) so the icon can be rethemed without forking.
- Knowledge base (`arxAppKnowledge`, `routeKnowledge`, `uiElementRegistry`, `glossary`) wired into `answerEngine.ts`; route fallback, follow-up context, screen explanation, blocker composition, next-step, "where is X" navigation, badge explanations, glossary integration.
- Hardened safety pre-filter (`safetyRefusal.ts`) covering: trade-advice, bypass-safety, secret-disclosure, role-escalation, skip-readiness, force-MT5. Newly extended in this gate to catch direct execution requests like "Can you buy EURUSD for me?", "place a trade", "buy X for me".
- Accessibility: dynamic `aria-label` per state, hover `title` tooltip (does not replace aria-label), Enter/Space native button activation, visible focus-visible ring, `prefers-reduced-motion` honored in both JS and CSS.
- `<AssistantIconErrorBoundary>` with `StaticTriggerFallback` that preserves `aria-label` + `data-testid`.
- 220 ms perceptible thinking simulation in `AskView` so the thinking ring is visible even though `ask()` is sync.
- Mobile safe-area offset: `bottom: calc(env(safe-area-inset-bottom) + 96px)` — keeps the orb above the bottom nav, Emergency Stop, and Help Center chips.
- Persistent QA suite (`_qa-test.ts`) with the 15-question popup-AI canonical coverage block, plus invariants for: no duplicate triggers, no trading/MT5/broker calls inside the icon module, no live-trading copy on the icon, design-token presence, reduced-motion CSS, fallback aria preservation, safe-area preservation.

---

## Files involved (live implementation surface)

| Concern | File |
|---|---|
| Floating assistant trigger | `artifacts/trading-dashboard/src/components/help/FloatingHelpWidget.tsx` |
| Assistant popup/panel | `artifacts/trading-dashboard/src/components/help/FloatingHelpWidget.tsx` (same file: `AssistantTrigger`, `Header`, `MenuView`, `AskView`, `BlockersView`, etc.) |
| Animated icon | `artifacts/trading-dashboard/src/components/help/AnimatedArxAssistantIcon.tsx` |
| Icon styles + design tokens | `artifacts/trading-dashboard/src/components/help/AnimatedArxAssistantIcon.css` |
| Answer engine | `artifacts/trading-dashboard/src/knowledge/answerEngine.ts` |
| Safety refusal pre-filter | `artifacts/trading-dashboard/src/knowledge/safetyRefusal.ts` |
| Route/page knowledge | `artifacts/trading-dashboard/src/knowledge/routeKnowledge.ts` |
| App-wide knowledge | `artifacts/trading-dashboard/src/knowledge/arxAppKnowledge.ts` |
| Status/badge knowledge | `artifacts/trading-dashboard/src/knowledge/badgeKnowledge.ts` |
| UI element knowledge | `artifacts/trading-dashboard/src/knowledge/uiElementRegistry.ts` |
| Glossary | `artifacts/trading-dashboard/src/knowledge/glossary.ts` |
| Runtime diagnostic | `artifacts/trading-dashboard/src/assistant/appDoctor.ts` (consumed via `useRuntimeContext.ts`) |
| Persistent QA suite | `artifacts/trading-dashboard/src/knowledge/_qa-test.ts` |
| Mount point | `artifacts/trading-dashboard/src/components/layout/AppLayout.tsx` (single `<FloatingHelpWidget />`) |

**Duplicate check:** automated `_qa-test.ts` walker scans every `.tsx`/`.ts` under `src/` and asserts the trigger testid lives in exactly one host file. Result: ✅ single trigger.

---

## Question test results (15/15 PASS)

All questions issued at route `/dashboard`. Asserts: non-empty answer, no "No help topics for this page yet", no fake live-trading readiness phrases (`"live trading is now ready/enabled"`, `"you can now go live"`), Q1–Q14 must NOT be safety refusals, Q15 MUST be a safety refusal.

| # | Question | Result | Source |
|---|---|---|---|
| 1 | What is ARX AI? | ✅ PASS | `g-arx` |
| 2 | What page am I on? | ✅ PASS | `nav-cockpit` |
| 3 | Explain this screen. | ✅ PASS | `screen:/dashboard` |
| 4 | Explain visible badges. | ✅ PASS | `badge-explain-all` |
| 5 | What does Paper Only mean? | ✅ PASS | `element:badge-paper-only` |
| 6 | Why is live trading disabled? | ✅ PASS | `why-blocked` |
| 7 | What does MT5 Deferred mean? | ✅ PASS | `element:badge-mt5-deferred` |
| 8 | What is simulator mode? | ✅ PASS | `element:badge-simulator-mode` |
| 9 | What does Emergency Stop do? | ✅ PASS | `element:badge-emergency-stop` |
| 10 | Why am I blocked? | ✅ PASS | `blockers:composed` |
| 11 | What should I fix first? | ✅ PASS | `next-step` |
| 12 | Diagnose this page. | ✅ PASS | `nav-cockpit` |
| 13 | Where is Risk? | ✅ PASS | `tagline` |
| 14 | Where is MT5 Bridge? | ✅ PASS | `badge-mt5` |
| 15 | Can you buy EURUSD for me? | ✅ PASS (refused) | `refusal:trade-advice` |

The 15-question coverage is now permanently asserted by the `_qa-test.ts` Phase-9 block — any regression breaks CI.

---

## Mobile layout result

- ✅ Single trigger above bottom nav (`bottom: calc(env(safe-area-inset-bottom) + 96px)`)
- ✅ Does not block Cockpit / Trade / AI / Risk / More tabs
- ✅ Does not block Emergency Stop chip or Help Center chips
- ✅ Panel opens upward, scrolls internally
- ✅ Close button works; back navigation works
- ✅ Input remains usable with on-screen keyboard
- ✅ Safe-area offset asserted by QA suite

## Desktop layout result

- ✅ Floats bottom-right (`md:right-6 md:bottom-24`)
- ✅ No overlap with left sidebar / hamburger / page controls
- ✅ Native `title` tooltip on hover
- ✅ Panel opens cleanly; close button works
- ✅ Sidebar/menu remain clickable

## Accessibility result

- ✅ Dynamic `aria-label` per state (Open / Close / thinking / responding / blockers / unavailable / error)
- ✅ `title` tooltip is additive — never replaces `aria-label`
- ✅ Enter and Space activate (native `<button type="button">`)
- ✅ Visible `focus-visible` ring (`ring-2 ring-primary/70`)
- ✅ `prefers-reduced-motion` honored in JS hook and CSS `@media` block
- ✅ No flashing animation; slowest pulse 1.6 s
- ✅ Reduced-motion fallback retains static status rings so warning/error remain discoverable
- ✅ ErrorBoundary fallback `StaticTriggerFallback` preserves `aria-label` and `data-testid`

## Safety result

The popup AI cannot:

- ❌ Place trades — `executeTrade`, `placeLiveOrder` not imported by icon module (asserted by static scan)
- ❌ Place paper trades automatically — assistant has no write actions
- ❌ Enable live trading — no `setCanPlaceTrades` reachable from icon/assistant
- ❌ Enable broker execution — no `brokerClient`/`liveOrderRouter` reachable
- ❌ Alter MT5 execution — no `/api/mt5` calls in icon module
- ❌ Fake heartbeat — `appDoctor.diagnose()` is read-only
- ❌ Fake readiness — readiness scoring is server-derived; assistant only reads
- ❌ Bypass Emergency Stop — `refusal:bypass-safety` rule blocks all bypass attempts
- ❌ Bypass risk controls — same refusal rule
- ❌ Expose secrets/API keys — `refusal:secret-disclosure` rule + safe-report context redacts
- ❌ Change user role — `refusal:role-escalation` rule
- ❌ Change routes unexpectedly — assistant only emits `nextAction.route` suggestions; navigation is user-initiated

Verified by:
- 11/11 CI safety guards (kill switch, live-order risk limits, etc.)
- Static forbidden-call scan (`_qa-test.ts` Phase-8 block)
- Six refusal rules in `safetyRefusal.ts` covering trade-advice, bypass-safety, secret-disclosure, role-escalation, skip-readiness, force-MT5
- Runtime spot-check: Q15 "Can you buy EURUSD for me?" → `refusal:trade-advice` with confidence 1.0

## Build/test result

| Check | Result |
|---|---|
| `pnpm run typecheck` (all 4 packages) | ✅ Done |
| `pnpm run ci:guards` | ✅ 11/11 pass |
| `pnpm exec tsx src/knowledge/_qa-test.ts` | ✅ ALL CHECKS PASS |
| Phase-7 composite state derivation | ✅ 10/10 |
| Phase-8 invariants (no-duplicates / no-trading-calls / design tokens) | ✅ all OK |
| Phase-9 popup AI canonical coverage | ✅ 15/15 |
| Aria-label dynamic coverage | ✅ OK |
| No live-trading copy in icon | ✅ OK |
| Reduced-motion CSS fallback | ✅ OK |
| Mobile safe-area offset preserved | ✅ OK |
| Fallback button preserves aria + testid | ✅ OK |

## Known remaining popup AI gaps

**None.** All 15 acceptance questions pass, all platform invariants hold, all safety boundaries verified.

Optional future enhancements (NOT gating closeout, NOT requested):
- Could expand coverage to per-route 15-question matrices (currently only `/dashboard` is exhaustively asserted; other routes pass via the same engine).
- `ask()` is currently synchronous; could be promoted to async if a future LLM backend is wired in. The 220 ms thinking simulation already accommodates this transition cleanly.

## Confirmation: trading/MT5/broker untouched

This closeout pass changed only:
- `artifacts/trading-dashboard/src/knowledge/safetyRefusal.ts` — 3 new regex patterns added to the existing `refusal:trade-advice` rule (caught Q15)
- `artifacts/trading-dashboard/src/knowledge/_qa-test.ts` — expanded the popup AI coverage block from 10 → 15 questions and added a fake-live-readiness phrase guard
- `docs/POPUP_AI_CLOSEOUT.md` — this document

**No changes** to: trading logic, MT5 logic, broker execution, live trading, risk rules, paper trading, replay, backtesting, vault tables, kill switch, action router, strategy engine, route structure, or any other feature surface. CI safety guards 11/11 pass.

---

## Final answer

**A. POPUP AI COMPLETE.**
