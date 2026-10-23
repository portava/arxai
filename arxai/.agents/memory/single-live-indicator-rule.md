---
name: Single live indicator rule
description: ARX surfaces account-mode/live state through ONE compact chip; never re-add full-width mode banners or persistent "ready" alerts.
---

# Single live indicator rule

ARX shows live/demo/blocked account state through exactly ONE compact chip:
`components/live/LiveModeBadge.tsx`, mounted once in `AppLayout`. It reads the
unified `useTradingMode()` envelope and also surfaces kill-switch and
armed-but-blocked (amber) states.

**Rule:** Do not re-introduce a full-width trading-mode banner, a second mode
pill, or a persistent positive status alert (e.g. "Live trading ready.").
Positive/steady live state belongs only on the chip. Banners/alerts are for
**actionable problems only** (kill switch, EA heartbeat stale, bridge
unavailable, account frozen, governance block, not-approved/suspended/
risk-locked, order rejected, insufficient funds).

**Why:** The app previously stacked three global live indicators
(a `TradingModeBanner` billboard with "Real money risk", the `LiveModeBadge`
chip, and a duplicate mode pill in `SafetyHeader`), plus a persistent
"Live trading ready" `Alert` from `MasterLiveAccessBanner` on Scanner. This
ate vertical space (worst on mobile / Scanner) and read as a billboard. The
owner's directive: "Not a billboard. A simple live will do."

**How to apply:**
- Live/demo copy lives on `LiveModeBadge`; allowed text is "LIVE",
  "LIVE · Shared MT5"; longer risk detail goes in the chip tooltip only.
- `MasterLiveAccessBanner` returns `null` when `canTrade` is true; it only
  renders for blocked/not-approved states.
- `SafetyHeader` keeps the chart-symbol pill + operator-gated badges but no
  account-mode pill.
- Conditional problem banners (`RiskLockBanner`, etc.) that already return
  `null` when there's no problem are fine — they are contextual, not billboards.
- Guards that keep this honest: `risky-wording-frontend`,
  `no-internal-names-user-ui`, `test:live-surface-no-demo`.
