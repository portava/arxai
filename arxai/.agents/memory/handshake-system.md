---
name: ARX Handshake System (Phase 0)
description: What the cross-layer handshake/readiness backbone is and the invariant that it stays advisory.
---

# ARX Handshake System (Phase 0)

A shared cross-layer readiness/check-in backbone that **wraps existing services
read-only** — it does not own or duplicate any layer's logic. Pure domain in
`lib/domain/src/handshake/` (types, aggregate engine, registry, consistency
helpers), server coordinator + read-only layer adapters + in-process event bus
in `artifacts/api-server/src/lib/handshake/`, an append-only evidence table
(`handshake_checkins`) with fail-open persistence (`handshakeLog.ts`), and an
admin-only monitor (`GET /api/admin/handshake-monitor` + `POST .../refresh`,
page under `pages/admin/handshake-monitor.tsx`, wrapped in `AdminDiagnosticsGate`).

**The one invariant that matters:** the handshake system is **advisory and
fail-open**. It must NEVER become a gate. It is not part of the 16-gate live
pipeline; on any error or missing data its layers return honest per-layer
`NOT_AVAILABLE`/`SKIPPED` and aggregate to `UNKNOWN` (never mock/sim/fake), a
definitively bad state is `FAIL`, and consistency `DIVERGENT → BLOCK` is only a
surfaced hint, never an execution block. Nothing in it sits on a
trading/scanner/Ruby hot path, and no producer hot path emits onto its event bus
yet (subscriber-side cache invalidation is wired; producer-side is reserved).

**Vocabulary:** per-layer `PASS|WARN|FAIL|SKIPPED|NOT_AVAILABLE`; aggregate
`PASS|WARN|BLOCK|UNKNOWN`. Investor-scoped handshakes read ONLY the supplied
investor's rows and report `SKIPPED` (→ `UNKNOWN`) with no investor context —
never another tenant's data, never balances/waterfall.

**Why:** the whole point is observability that wraps without risk. If a later
phase ever wires a handshake result into a real decision path, that is a
deliberate, separately-reviewed change — the default and the tests assume
advisory-only.
