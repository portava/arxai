---
name: Chart command controls must be role + mode aware (no dead buttons)
description: Scanner chart trade/annotation controls — gating rules so PAPER/investor never see refused actions.
---

# Scanner chart command controls — role + mode gating

The Scanner chart (`ScannerChartPanel.tsx` + `ChartCommandMenu.tsx`) exposes
trade-planning (Plan Buy/Sell → DRAFT), annotation marks, and price alerts.
Each control must be gated to what the backend will actually accept, or it is a
dead button.

- **Trade-planning controls (Plan Buy/Sell + draft strip)** render ONLY when
  `canTrade` (= live/demo mode AND canManualTrade AND !frozen). PAPER, frozen,
  and non-trading accounts get an honest read-only note, NOT the buttons.
  **Why:** the documented invariant is "PAPER mode renders **no** trade
  buttons" — blocking placement alone is not enough; the *button* must be gone.
  Gating only the placement/confirm step (and leaving Plan Buy/Sell visible) was
  the actual review failure.
- **Annotation + AI-alert controls (mark level, price alert, the periodic
  ai-alerts scan POST)** are USER-safe (role USER/ADMIN/OWNER → backend 200),
  but the product-role gate (`productRole.ts enforceProductRoleAccess`) refuses
  ALL investor mutations except `/me/investor/allocation`. Investors are already
  route-contained out of `/market-scanner`, but ALSO suppress the command menu
  (`openMenuAt` early-return) and the scan loop for `isInvestor`
  (`useProductRole().isInvestor`) as defence-in-depth — otherwise an investor
  who reaches the page gets dead buttons / a 403 scan spin.

**How to apply:** when adding any chart control, ask "what role+mode does the
backend accept this for?" and gate the control on exactly that. `canTrade` for
trade actions; `!isInvestor` for annotation/alert mutations. Route containment
is not a substitute for hiding refused controls.
