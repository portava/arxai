# Replit command — R5: Deriv Phase 2 (demo execution on the four-symbol universe)

**Prerequisite:** R1 + R4 slices 1–5 (provenance + runtime discovery). **Risk class:** new broker execution path — demo only, live remains structurally impossible in this phase. Branch + owner merge.

Companion report: `audit-reports/audit-deriv.md` (11-item gap list, 9 slices, 10 red-fail tests — two fail red today, proving the symbol-map drift and the silent mock fallback).

Instruction for Claude Code in the Replit shell:

---

Implement Deriv Phase 2 from `audit-deriv.md` on branch `feat/deriv-phase2-demo`, per the multi-broker spec §17 (Deriv rules) and §19 Phase 2:

1. **Account identity first** — stop discarding the `authorize` payload: persist `loginid`, `is_virtual`, `currency` per connection. Every subsequent slice hard-requires `is_virtual === true` (demo). Wire `DERIV_ENVIRONMENT`/`DERIV_ACCOUNT_ID` or retire them (currently dead env vars).
2. **Runtime discovery retention** (shared with R4 slice 5) — `active_symbols` payload persisted, four-symbol universe (`Volatility 25 (1s)`, `Volatility 50 (1s)`, `Volatility 75`, `Volatility 75 (1s)`) resolved at runtime, never from the static maps.
3. **Contract model** — model Deriv contract types (multipliers first; options/accumulators later) as their OWN domain types, never mapped onto MT5 CFD position semantics (spec §17). `contracts_for` discovery gates which types the account actually supports.
4. **Execution client** — `proposal` → `buy` → `proposal_open_contract` subscription → `sell`, with idempotent client request IDs, UNKNOWN-on-timeout semantics matching R2, and the same immutable-intent pipeline (draft → confirm → dispatch) the MT5 path uses — one execution truth, a second adapter.
5. **Adapter seam** — implement against the adapter interface from R2-S7; the DerivProvider replaces the silent `MockBrokerProvider` fallback (which R1 already made an explicit `NOT_IMPLEMENTED` refusal).
6. **Reconciliation** — `portfolio`/`profit_table` polls compare open contracts against ARX records; mismatch freezes the connection's new entries (R2-S4 machinery).
7. **Unsubscribe hygiene** — implement `forget`/`forget_all` (header claims it, code lacks it); keep-alive narrows to the discovered universe instead of pinning all 22 synthetics.
8. **Certification** — run the spec §16 adapter certification list against the Deriv demo account; every advertised capability gets a test; unsupported types refuse before network submission.

Hard rules: demo-only in this phase — no code path may submit with `is_virtual === false` (make that a typed refusal + test); `syntheticLiveFloor` contract untouched; all 18 Phase B gates + R2/R3 pre-gates apply unchanged to any future live consideration.

---

**Hold point:** after slice 4 first successful demo round-trip (buy → open → sell with real contract IDs), stop and demo it to the owner before 5–8.
