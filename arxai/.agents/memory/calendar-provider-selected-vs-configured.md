---
name: Calendar seams gate honesty on "selected" not "configured"
description: Why provider-selected (regardless of key) — not provider-configured (key present) — is the correct gate for the mock back-compat fallback in news/calendar seams.
---

# Calendar mock fallback gates on PROVIDER-SELECTED, never PROVIDER-CONFIGURED

A pluggable provider behind a back-compat mock has TWO independent env facts:
- **selected** — `ECONOMIC_CALENDAR_PROVIDER === "trading_economics"` (regardless of key)
- **configured** — selected AND key present (`resolveTradingEconomicsConfig() !== null`)

Every consumer seam that falls back to a mock generator must gate that fallback
on **selected**, NOT on **configured**:

- `selected === true`  ⇒ serve the real provider, which yields honest-empty
  (`[]` / status missing|error) when the key is absent or upstream errors.
  **NEVER** the mock generator.
- `selected === false` (no provider chosen — true legacy default) ⇒ mock
  back-compat is fine.

**Why:** gating the mock on `configured` means a *selected-but-keyless* provider
silently falls through to fabricated mock events — a direct honesty breach
("missing key must show provider missing, not fabricated/no events"). In an env
where the provider IS selected but the key is intentionally unset, this is the
LIVE state, so the bug is active, not theoretical.

**How to apply:** any new seam (route array, DB-sync provider selector, heat,
radar, assistant) reuses the shared `isEconomicCalendarProviderSelected()` for
the mock-vs-real decision and lets the service's own status model carry
missing/error/empty. Bare-array/legacy seams that cannot express status return
`[]` (honest-empty, no fabrication); rich surfaces carry the explicit status.
Lock with a regression test: selected+no-key ⇒ real provider returning `[]`;
not-selected ⇒ mock.
