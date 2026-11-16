---
name: Normal-user route containment (default-deny allowlist)
description: How direct-URL access to non-product pages is contained for normal users on the trading dashboard, and the traps to avoid.
---

Nav-hiding alone does NOT stop a normal user from reaching admin/dev/dormant/paper
pages by typing the URL. Containment is a **default-deny allowlist** in
`artifacts/trading-dashboard/src/lib/routeAccess.ts` (`isNormalUserAllowedPath`)
enforced by `RouteAccessGuard` in `AppLayout.tsx`.

**Why:** "remove from sidebar" was the original pruning approach and left every
gated route reachable by direct URL — the real gap. The allowlist closes it.

**How to apply / traps:**
- OWNER/ADMIN bypass entirely (keep full URL access). Only non-admins are gated.
- It's a **product-containment / UX layer only** — backend guards (`requireAdmin`,
  per-user ownership, 16-gate live pipeline, kill switch) stay authoritative. Never
  treat this as a security boundary.
- The `/emergency` safety/kill-switch route MUST stay in the allowlist — gating it
  away would hide the emergency stop from normal users.
- Must handle the identity-loading race: render a skeleton while
  `useCurrentUser().isLoading` so a real admin isn't bounced off a deep link
  before `/api/me` resolves. (`AuthGate` shares the `["me"]` query, so in practice
  it's already cached and the skeleton rarely shows — but keep the guard.)
- Drift trap: any route added to a *visible* normal-user nav group must also be
  added to the allowlist, or users get the block card on their own nav. Architect
  suggested a parity assertion (nav routes ⊆ allowlist) — not yet implemented.
- Result-card / command-palette deep-links to now-admin-only routes should be
  hidden from non-admins (e.g. Scanner Grade/Replay/Backtest via
  `useViewMode().realIsAdmin`) so users don't land on the block card.
