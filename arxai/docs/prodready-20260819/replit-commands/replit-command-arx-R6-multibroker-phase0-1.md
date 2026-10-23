# Replit command — R6: multi-broker Phase 0 + 1 (read-only broker hub)

**Prerequisite:** R1 merged; R2-S7 adapter seam helpful but not required. **Risk class:** additive schema + read-only surfaces behind disabled flags. Branch + owner merge. DB migrations are owner-pressed.

Companion reports: `audit-reports/audit-connections.md` (reuse map + 5 Phase 0 slices + 8 Phase 1 slices + 14 red-fail tests) and `audit-reports/audit-workspaces.md` (Mode B reuse map — it already exists at ~70-80% under different names — plus 7 compliance slices).

## Standing rulings (executive, 2026-08-19)

- **TypeScript, not Python.** The spec's §5 Python layout maps to: `lib/domain` (pure contracts), `lib/db` (schema), `api-server/src/lib/brokers/*` (adapters), `api-server/src/routes` (HTTP). The spec's own reuse-first rule (§1) forbids a parallel Python stack.
- **Integer FKs + `publicId` uuid columns**, not UUID PKs — `users.id` is serial and every live table FKs integers; verbatim spec DDL would break referential integrity.
- **Compose, don't duplicate.** The spec's `trading_control_state` would be a FIFTH master/kill switch; `risk_profiles` a SIXTH limit store; `broker_instruments` must extend the account-keyed pattern of `broker_candles`, not duplicate `arx_symbol_specs`. Phase 0 builds a COMPOSITION layer over the existing stores, adding only what has no equivalent: venue-neutral `broker_connections`/`broker_accounts` registry, credential vault (throwing `encryptCredential` — the existing `encryptField` fails open to plaintext and must not be reused), eligibility/residency + `COMPLIANCE_HOLD`, per-connection pause/frozen/close-only, entitlements, broker catalog endpoint.
- **Managed Allocation:** do NOT build the spec's workspace tables from scratch — `shared_master_accounts` + `user_master_live_access` + `user_slot_allocation` + `virtual_trading_accounts` ARE the implicit managed workspace. Implement the 7 compliance slices from `audit-workspaces.md` instead: netting demo/shadow-only structural gate, beneficial-ownership attestation, `COMPLIANCE_HOLD` status, assignment expiry/schedule, per-intent reservations (shared with R3 slice 3), workspace naming layer, owner-provenance columns.

Instruction for Claude Code in the Replit shell:

---

Implement Phase 0 (5 slices) then Phase 1 (8 read-only slices) exactly as sequenced in `audit-connections.md`, on branch `feat/multibroker-phase01`, under a default-OFF feature flag (`ARX_BROKER_HUB_ENABLED`). Phase 1 ends with: broker catalog + connections UI cards, MT5 represented through the same connection model (projection, not migration), Deriv read-only connection, balances/positions/instruments discovery, health + reconciliation status — and NO submit method on any adapter interface in this phase. Fix the two defects the audit pinned to this area as you pass: the unmasked account number serializer (done in Round A — verify), and `arx_symbol_specs` uniqueness (new `broker_instruments` is account-keyed; leave the legacy table untouched). Every slice: red-fail test first, `pnpm run ci` green after. No live credentials, no OAuth app registrations without the owner (they require developer-portal accounts).

---

**Hold points:** after Phase 0 (schema review before migration — owner presses `pnpm --filter @workspace/db run push`), and after Phase 1 slice 4 (first real Deriv read-only connection).
