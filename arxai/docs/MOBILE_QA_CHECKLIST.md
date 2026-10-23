# ARX AI — Mobile / iPhone Safari QA Checklist

**Version:** `ARX_AI_LAUNCH_CANDIDATE_0.1` mobile pass
**Mode:** paper-only · liveLocked: true · readOnlyMode: true · allowOrderExecution: false
**Scope:** smoke-test the launch candidate on iPhone Safari at 375×812 and 390×844.
**Do not:** fire live trades, create real bridge commands, or flip
`ARX_LIVE_BROKER_EXECUTION_ENABLED`.

## Devices / viewports to test

- [ ] iPhone SE 2/3 (375×667) — narrowest supported
- [ ] iPhone 13/14 (390×844) — common reference
- [ ] iPhone 15 Pro Max (430×932) — large notched
- [ ] iPad mini (744×1133) — small tablet sanity

Browser: **Safari** (not Chrome iOS — different engine layer).
Network: throttle to "Fast 3G" once per device.

## Routes / screens to walk

| # | Route | Acceptance |
|---|---|---|
| 1 | `/login` | Inputs do not zoom on focus; submit reachable above keyboard |
| 2 | `/onboarding` | All steps reachable; next/back buttons not covered by Ruby trigger |
| 3 | `/` (Dashboard) | Tiles wrap to 1 col < 375px; no horizontal scroll |
| 4 | `/scanner` | Symbol search input ≥ 16px (no zoom); rows tappable |
| 5 | `/trade` (Trade Command Room) | Trade ticket Confirm/Cancel never hidden by Ruby trigger |
| 6 | `/positions` | Position cards readable; close-trade modal scrolls |
| 7 | `/orders` | Order rows fit; edit modal scrolls |
| 8 | `/journal` / P&L calendar | Calendar grid scrolls horizontally if needed |
| 9 | `/analytics` | Charts fit viewport width; legends wrap |
| 10 | `/risk` (Risk Command Center) | Toggle inputs reachable above keyboard |
| 11 | `/status` (Status Command Center) | Cards stack on mobile |
| 12 | `/settings` | Form inputs do not zoom; save reachable |
| 13 | `/mt5-setup` | Per-user bridge token shown once; demo arming toggle visible |
| 14 | `/ai-mentor` | Ruby chat scrolls; input above keyboard |
| 15 | `/admin/operator-command-center` (admin) | KPI cards stack; tables scroll horizontally |
| 16 | `/admin/launch-readiness` | Section cards readable |
| 17 | `/admin/trading-control` | Kill-switch + close-only toggles tappable |
| 18 | `/admin/reconciliation-center` | NEEDS_REVIEW table scrolls horizontally |
| 19 | `/admin/audit-center` | Export buttons reachable; no secret strings shown |
| 20 | `/admin/master-bridge` | Approval queue tappable; allocation modal scrolls |

## Mandatory mobile invariants

- [ ] Viewport meta tag has `viewport-fit=cover` (notched-iPhone safe area)
- [ ] All `<input>`, `<textarea>`, `<select>` render ≥ 16px on phones (no auto-zoom)
- [ ] Floating Ruby trigger uses `z-40` so trade-confirmation modals (`z-50`) overlay it
- [ ] Bottom nav has `pb-[env(safe-area-inset-bottom)]`
- [ ] Touch targets ≥ 44×44px (bottom nav anchors are `min-h-[44px]`)
- [ ] No `position: fixed` element covers Confirm/Cancel in any trade flow
- [ ] All tables wrap in `overflow-x-auto`

## Ruby / voice on iOS

- [ ] Tapping the floating Ruby trigger opens the panel (smooth animation)
- [ ] Closing the panel (X or tap-outside) releases focus
- [ ] Chat input stays above the iOS keyboard
- [ ] **Voice mode requires a user tap to start** (iOS gesture rule)
- [ ] Microphone permission prompt fires once and is remembered
- [ ] Mic pauses while Ruby is speaking; resumes after Ruby stops
- [ ] Voice cannot bypass trade confirmation — every trade still requires the
      typed-phrase or Confirm tap (no silent execution)
- [ ] Voice mode stops when Ruby panel closes
- [ ] Permission denied shows a clean fallback (no raw browser error)

## Privacy / cache on account switch

- [ ] Logout clears Ruby chat history client-side
- [ ] Logging in as User B does NOT show User A's scanner snapshot
- [ ] Logging in as User B does NOT show User A's notifications
- [ ] No shared-master global totals visible to a normal user
- [ ] No bridge tokens, API keys, account numbers, or session secrets in any
      response body (verified server-side by `master-bridge-secrets-not-leaked` guard)

## Safety gates still enforced from mobile

- [ ] Admin approval still required for live arming (mobile cannot bypass)
- [ ] Disclosure acceptance still required for live (mobile cannot bypass)
- [ ] Kill switch toggle from `/admin/trading-control` still blocks all live dispatch
- [ ] Close-only mode still blocks new opens
- [ ] One-click toggle defaults OFF on every session
- [ ] Cooldown timers honored from mobile origin
- [ ] Confirmation modal cannot be dismissed by tapping outside (must use button)

## Error rendering

- [ ] No raw stack traces shown in any UI
- [ ] No raw SQL / Drizzle errors
- [ ] No raw EA bridge payloads
- [ ] Blocked-trade reasons render as friendly text (no `LIVE_BLOCKED:` raw codes)
- [ ] Permission-denied screens render cleanly with retry/back options
- [ ] Network failure shows "Connection lost, retry" not a code dump

## Known mobile issues / fixes applied in this pass

**Fixes applied:**

- `index.html` — added `viewport-fit=cover` so notched iPhones get the
  correct `env(safe-area-inset-*)` values.
- `src/index.css` — added `@media (max-width: 767px)` rule forcing
  `input`/`textarea`/`select` to `font-size: 16px` (prevents iOS auto-zoom
  on focus without changing desktop styling).
- `src/components/help/FloatingHelpWidget.tsx` — lowered floating Ruby
  trigger from `z-[60]` to `z-40` so trade-confirmation modals (`z-50`)
  always overlay it; the open Ruby panel (`z-50`) remains unchanged.

**No fix required (already correct):**

- `MobileBottomNav` uses `pb-[env(safe-area-inset-bottom)]` and
  `min-h-[44px]` per-anchor.
- `TradeActionReviewModal` already uses `max-h-[90vh] overflow-y-auto`.
- `LiveTradeCard` already uses `max-h-[85vh] overflow-y-auto`.
- Tables on `trade-logs`, `mt5-setup` already wrap in `overflow-x-auto`.

## Remaining mobile blockers

**None known.** Items deferred to post-launch polish:

- Admin tables with > 8 columns (e.g. reconciliation NEEDS_REVIEW grid)
  remain horizontal-scroll on phones; responsive-card variant tracked as
  `ARX-MOBILE-002` (post-launch).
- P&L calendar dense view squishes on iPhone SE; switches to list view
  acceptably; tracked as `ARX-MOBILE-003` (post-launch).

## Confirmations

- [ ] `arx_live_commands` count read before AND after mobile QA
- [ ] Counts unchanged (must be `0 → 0`)
- [ ] No live trade was fired
- [ ] No secrets exposed in any captured response
