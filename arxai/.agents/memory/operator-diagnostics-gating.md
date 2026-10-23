---
name: Operator/diagnostic page gating
description: Rule for wrapping any page that surfaces raw booleans, backend constants, gate/env/endpoint/token names, or debug dumps so non-admins (and admin-previewing-as-user) cannot see them.
---

# Rule

Any page whose UI exposes raw booleans, backend constants, gate names, env
names, endpoint names, token labels, JSON debug dumps, or other operator-only
diagnostics MUST be wrapped at its default export with `AdminDiagnosticsGate`
(`artifacts/trading-dashboard/src/components/admin/AdminDiagnosticsGate.tsx`).

The gate renders children only when BOTH of these hold:
1. `useTradingMode().shouldShowAdminDiagnostics === true`
2. `useTradingMode().isAdminPreviewingUserMode === false`

While the resolver is loading, the gate shows a neutral "Checking
permissions" card — never the children — so non-admins cannot glimpse raw
internals during the React Query refetch window.

**Why:** The server's `adminDiagnosticsAvailable` flag is computed as
`isAdmin` only — it does NOT account for preview-as-user mode. If we
relied solely on the server flag, an admin in user-preview would still
see operator diagnostics, defeating the preview. The gate component
must AND the two signals on the client.

**How to apply:**
- New operator pages: wrap default export; keep page body as `*Inner`.
- Page-level placeholder must include: a back link to `/my-account`, a
  Get-help link, and a user-safe message describing why no action is
  needed. Never name endpoints, env vars, or internal constants in the
  placeholder.
- Do NOT also gate the route in `App.tsx` — the wrapper handles direct
  URL navigation because it runs unconditionally on render.

# Forbidden in any user-visible card or placeholder

- Raw `String(boolean)` outputs of internal state
- Internal constants: `BROKER_PLACEMENT_LAYER_NOT_IMPLEMENTED`,
  `EA_READ_ONLY_MODE_ACTIVE`, gate-name strings, etc.
- Env var names: `MT5_BRIDGE_TOKEN`, `SESSION_SECRET`,
  `ARX_LIVE_BROKER_EXECUTION_ENABLED`
- Token/header labels, route paths, table names
- Typed operator phrases like `ENABLE LIVE TRADING`
- Raw JSON dumps of API responses

# Regression contract

`pnpm --filter @workspace/scripts run test:operator-diag-gating` asserts
the server-side envelope contract the gate depends on (normal-user vs
admin, no forbidden secret keys, arx_live_commands Δ=0). Run before
shipping any change to `meUnifiedMode.ts` or the gate wrapper.
