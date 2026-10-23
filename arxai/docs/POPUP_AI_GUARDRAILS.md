# Popup AI Guardrails — ARX AI Floating Assistant

**Status reviewed from `POPUP_AI_CLOSEOUT.md`: A. POPUP AI COMPLETE.**

This document freezes the floating ARX Assistant popup work. It enumerates the live implementation surface that must not be casually edited, the platform requirements (mobile/desktop/a11y/safety) that must hold across future builds, and the regression checklist + automated test references that prove the popup AI still works.

Future feature work (Status Command Center extensions, Paper Lab, Replay Lab, Backtesting Lab, MT5 work, etc.) **must not** modify the files listed here without first reading this note and re-running the regression suite.

---

## Protected files (live implementation surface)

| Concern | File | Why it's protected |
|---|---|---|
| Floating assistant trigger | `artifacts/trading-dashboard/src/components/help/FloatingHelpWidget.tsx` | Single trigger + panel. Mounted exactly once in `AppLayout`. Owns open/close, thinking, readyAt, iconError, blockerCount state and threads them into the icon hook. |
| Animated icon (SVG) | `artifacts/trading-dashboard/src/components/help/AnimatedArxAssistantIcon.tsx` | Pure SVG + CSS icon with composite state model (`useAssistantIconState`). No trading/MT5/broker imports allowed. |
| Icon styles + design tokens | `artifacts/trading-dashboard/src/components/help/AnimatedArxAssistantIcon.css` | Hosts the `--arx-aicon-*` and `--arx-assistant-*` CSS custom properties + the `prefers-reduced-motion` fallback. Status-ring colors must keep referencing tokens. |
| Answer engine | `artifacts/trading-dashboard/src/knowledge/answerEngine.ts` | Sole entry point for the assistant `ask(question, ctx)`. Safety pre-filter must run first. Don't bypass the refusal hook. |
| Safety refusal pre-filter | `artifacts/trading-dashboard/src/knowledge/safetyRefusal.ts` | Six refusal rules: trade-advice, bypass-safety, secret-disclosure, role-escalation, skip-readiness, force-MT5. Patterns may only be ADDED, never relaxed. |
| Route/page knowledge | `artifacts/trading-dashboard/src/knowledge/routeKnowledge.ts` | Per-route purpose, badges, questions. New routes added here only. |
| App-wide knowledge | `artifacts/trading-dashboard/src/knowledge/arxAppKnowledge.ts` | Global Q&A entries (g-arx, why-blocked, next-step, blockers:composed, etc.). |
| Status/badge knowledge | `artifacts/trading-dashboard/src/knowledge/badgeKnowledge.ts` | Mode/state badges. Must not invent live-trading-ready badges. |
| UI element knowledge | `artifacts/trading-dashboard/src/knowledge/uiElementRegistry.ts` | Per-element "What it does / What it does NOT do / Safe next" entries. Element entries must keep the "does NOT" guard line. |
| Glossary | `artifacts/trading-dashboard/src/knowledge/glossary.ts` | Term definitions. Pure reference. |
| Runtime diagnostic | `artifacts/trading-dashboard/src/assistant/appDoctor.ts` (consumed via `assistant/useRuntimeContext.ts` and `hooks/use-assistant-context.ts`) | Read-only diagnostic. `diagnose()` must never write or mutate trading state. |
| Persistent QA suite | `artifacts/trading-dashboard/src/knowledge/_qa-test.ts` | The single source of CI-style assertions for the popup. Run before every release. |
| Mount point (do not duplicate) | `artifacts/trading-dashboard/src/components/layout/AppLayout.tsx` | `<FloatingHelpWidget />` mounted exactly once. Adding a second floating trigger anywhere is a regression. |

---

## Mobile positioning requirements (must hold)

- Trigger offset must remain `bottom: calc(env(safe-area-inset-bottom) + 96px)` (see `FloatingHelpWidget.tsx`).
- Trigger must remain visually clear of: bottom nav (Cockpit / Trade / AI / Risk / More), Emergency Stop chip, Help Center chips.
- Panel opens upward and scrolls internally; its body container must keep `overflow-y-auto` and a `max-h-*` derived from viewport.
- Input field inside the panel must remain reachable when the on-screen keyboard is open (no `position: fixed` parents that hide it).
- Close button and back navigation must work on every panel view (Menu, Ask, Blockers, Element).

## Desktop positioning requirements (must hold)

- Trigger floats bottom-right at `right-6 bottom-24` (Tailwind classes in `FloatingHelpWidget.tsx`).
- Trigger must not overlap the left sidebar, the hamburger/menu, or any page-level controls.
- Native `title` tooltip must appear on hover (additive, never a substitute for `aria-label`).
- Panel opens cleanly without pushing layout; sidebar/menu remain clickable while the panel is open.

## Accessibility requirements (must hold)

- `aria-label` on the trigger button is dynamic per state — produced by `useAssistantIconState` and bound via `aria-label={ariaLabel}`.
- `aria-label` must NEVER be replaced by the `title` tooltip; both must coexist.
- Trigger is a real `<button type="button">` so Enter and Space activate natively.
- Visible `focus-visible:ring-2 focus-visible:ring-primary/70` ring must remain on the trigger.
- `prefers-reduced-motion` honored in BOTH the JS hook (`usePrefersReducedMotion`) and the CSS `@media (prefers-reduced-motion: reduce)` block — looped animations off, status rings remain statically visible.
- No flashing animation: slowest pulse cycle is 1.6 s; do not introduce shorter strobing animations.
- ErrorBoundary `StaticTriggerFallback` must continue to render `aria-label="Open ARX Assistant"` and `data-testid="floating-help-trigger"`.

## Safety boundaries (inviolable)

The popup AI and its icon must NEVER:

- Place trades — no import of `executeTrade`, `placeLiveOrder`, `engageKillSwitch`, `setCanPlaceTrades`, no fetch of `/api/execute-trade`, no fetch of `/api/mt5*`.
- Place paper trades automatically — assistant has no write actions; `ask()` returns text only.
- Enable live trading — no `setCanPlaceTrades`, no live-readiness mutation.
- Enable broker execution — no `brokerClient`, no `liveOrderRouter`.
- Alter MT5 execution — no MT5 bridge writes.
- Fake heartbeat or readiness — `appDoctor.diagnose()` is read-only.
- Bypass Emergency Stop or risk controls — `refusal:bypass-safety` rule blocks attempts.
- Expose secrets/API keys — `refusal:secret-disclosure` rule + safe-report context redaction.
- Change user role — `refusal:role-escalation` rule.
- Change routes unexpectedly — assistant only emits `nextAction.route` *suggestions*; navigation is always user-initiated.

The icon's `warning`/`error` rings communicate APP/ASSISTANT status only and must NEVER reference live trading or hint at live readiness. Forbidden phrases: `"enable live"`, `"live trading ready"`, `"go live"`, `"start live"`, `"live mode ready"` — already enforced by `_qa-test.ts`.

---

## Forbidden areas — DO NOT touch casually from feature work

Future agents and contributors must NOT casually edit these without re-running the full regression suite:

1. `lib/safetyCore.ts`, vault tables, MT5 routes, `strategyEngine.ts` — already protected by `docs/SAFETY_NOTES.md`.
2. The `<FloatingHelpWidget />` mount in `AppLayout.tsx` — adding a second mount is a regression.
3. The `useAssistantIconState` precedence rules — disabled > thinking > typing > ready > open > opening > hover > idle, and status error > warning > none.
4. The `prefers-reduced-motion` JS hook + CSS `@media` block — both must remain.
5. `safetyRefusal.ts` patterns — may only be EXTENDED. Never narrow or remove an existing pattern.
6. The 220 ms perceptible-thinking simulation in `AskView` — keep it so the thinking ring is visible if `ask()` is later promoted to async.
7. Mobile safe-area offset `bottom: calc(env(safe-area-inset-bottom) + 96px)`.
8. The QA suite `_qa-test.ts` Phase-7/8/9 blocks — they encode the acceptance contract.

---

## Regression checklist (run before any future app build is accepted)

- [ ] Only one assistant icon appears in the live app
- [ ] Assistant floats above the bottom nav on mobile (safe-area offset preserved)
- [ ] Assistant does not block the More tab
- [ ] Assistant does not block the Emergency Stop chip
- [ ] Assistant does not block the desktop sidebar/menu
- [ ] Assistant opens and closes correctly from both the floating trigger and the panel close button
- [ ] All animated icon states still work (idle / hover / opening / open / closing / thinking / typing / ready / warning / error / disabled)
- [ ] Assistant answers app-wide questions (15-question canonical set in `_qa-test.ts`)
- [ ] Assistant refuses trade/execution requests (Q15 "Can you buy EURUSD for me?" still routes through `refusal:trade-advice`)
- [ ] No "No help topics for this page yet" message appears for any of the 15 canonical questions
- [ ] No trading / MT5 / broker / risk / live-trading logic was changed by popup UI work (CI guards 11/11 still pass)

---

## Automated regression test command

The popup-AI regression suite is a single command:

```bash
pnpm --filter @workspace/trading-dashboard exec tsx src/knowledge/_qa-test.ts
```

This must print `✅ ALL CHECKS PASS`. The suite encodes the following named checks (all currently green):

| Check group | Coverage |
|---|---|
| Composite state derivation (Phase 7) | 10 cases — full precedence matrix incl. `disabled > thinking > typing > ready > open > opening > hover > idle` and `error > warning > none` |
| Aria-label coverage | All required dynamic strings present in `AnimatedArxAssistantIcon.tsx` |
| No live-trading copy in icon | Forbidden-phrase scan over icon source + CSS |
| Reduced-motion CSS fallback | `@media (prefers-reduced-motion: reduce)` with `animation: none` |
| State CSS coverage | `data-state="..."` rules for every motion state |
| Status ring CSS (warning/error) | Both `data-status` rules present |
| Widget wires hook + tooltip + dynamic aria + activity events | `useAssistantIconState`, `aria-label={ariaLabel}`, `title={tooltip}`, `blockerCount`, `onActivity` all wired |
| Fallback button preserves aria + testid | `StaticTriggerFallback` keeps both attrs |
| Mobile safe-area offset preserved | `env(safe-area-inset-bottom)` present in widget |
| Single floating trigger (no duplicates) | Recursive `src/` walker — testid must live in exactly one host file |
| Icon module makes no trading/MT5/broker calls | Static forbidden-call scan: `executeTrade`, `placeLiveOrder`, `engageKillSwitch`, `setCanPlaceTrades`, `/api/execute-trade`, `/api/mt5`, `mt5Bridge`, `brokerClient`, `liveOrderRouter` |
| Design tokens present | Five required CSS custom properties exist |
| Popup AI 15-question coverage (Phase 9) | All 15 acceptance questions answered correctly; Q15 must trigger `refusal:trade-advice` |

Always run alongside:

```bash
pnpm run typecheck     # full monorepo typecheck (all 4 packages)
pnpm run ci:guards     # 11 invariant guards (kill switch, live-order risk limits, etc.)
```

Both must succeed before merging any change that touches the protected files.

---

## Manual QA fallback (if running the automated suite isn't possible)

1. Load the app on mobile viewport (≤ 480 px width). Confirm exactly one floating ARX Assistant orb appears bottom-right above the bottom nav.
2. Tap the orb. Confirm morph animation plays and a panel opens upward.
3. Tap the **Ask** view. Type "What is ARX AI?" — expect a non-empty answer mentioning "Analyze, Risk, eXecute" and "paper-first".
4. Type "Can you buy EURUSD for me?" — expect a refusal that explains ARX is paper-only and refuses to recommend or execute trades.
5. Close the panel. Confirm morph back to orb.
6. Confirm bottom nav (Cockpit / Trade / AI / Risk / More) and the Emergency Stop chip are still tappable, not occluded.
7. Switch to desktop viewport (≥ 1024 px width). Confirm the orb floats bottom-right; hover shows a tooltip.
8. Open the panel; confirm the left sidebar remains clickable.
9. Toggle OS-level "reduce motion". Reload. Confirm the orb is static (no morph) but warning/error rings still appear if blockers exist.

---

## Final report

| Item | Result |
|---|---|
| Popup AI status | **Complete** |
| `POPUP_AI_CLOSEOUT.md` reviewed | Yes — confirmed `A. POPUP AI COMPLETE` |
| `POPUP_AI_GUARDRAILS.md` created | Yes (this document) |
| Files protected by guardrails | 13 files listed in the protected-files table above |
| Tests / checklist added | Automated: `src/knowledge/_qa-test.ts` (13 named check groups, all currently green); Manual: 9-step QA fallback section |
| Remaining popup AI issues | None |
| New app features built in this pass | None — guardrails note only; no source code changes |
