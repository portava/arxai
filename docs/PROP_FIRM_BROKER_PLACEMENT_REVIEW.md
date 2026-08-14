# Prop Firm Mode — Broker Placement Review (Phase 27-B)

**Scope of review:** confirm that the extended prop firm rule schema and engine
introduced in Phase 27-B do **not** alter, weaken, or bypass any existing
execution safety surface (live execution, MT5 bridge, paper order placement,
auto-close governor, or shared-account isolation).

## Surfaces reviewed (read-only, untouched by this phase)

| File | Role | Status |
|------|------|--------|
| `artifacts/api-server/src/lib/orderGuard.ts` | Pre-trade safety gate | Untouched |
| `artifacts/api-server/src/routes/brokerPlacement.ts` | Live broker placement | Untouched |
| `artifacts/api-server/src/lib/tradePlacement.ts` | Paper order placement | Untouched |
| `artifacts/api-server/src/routes/mt5.ts` | MT5 EA bridge | Untouched |
| `artifacts/api-server/src/lib/protectiveAutoClose.ts` | Protective auto-close (ALERT_ONLY) | Untouched |
| `artifacts/api-server/src/lib/safetyCore.ts` | Global safety envelope | Untouched |

## Invariants confirmed

1. **Live execution remains BLOCKED.** The Phase 27-B `PATCH /prop-challenges/:id/rules`
   endpoint mutates rule columns only on `prop_challenges`. It never reads,
   writes, or queues anything in `mt5_commands`, `mt5_accounts`, broker tables,
   or any vault credential.
2. **Paper-only rule engine.** `evaluateChallenge()` in `routes/propChallenges.ts`
   and the inline evaluator in `lib/assistant/tools.ts` read only this user's
   `paper_orders`. Defense-in-depth filter on `userId` is preserved. No new
   data sources, no live broker connections.
3. **BLOCKED status is an advisory rule status only.** When
   `strictGuardrailsEnabled = true` AND a HARD violation is present, the
   evaluator emits `ruleStatus = "BLOCKED"`. This status is surfaced to the AI
   (`getPropFirmModeStatus`) and to the UI panel as a paper-action advisory —
   **it does not call any cancel/close API, does not push any MT5 command, and
   does not modify broker configuration.**
4. **Notification helper is fire-and-forget.** `buildPropFirmAlert()` produces
   a `NotifyInput` and the route calls `notify()` with `.catch()`. A
   notification failure can never block the rule evaluator, can never roll back
   a paper order, can never reach the broker placement code path.
5. **Verbatim safety language preserved.** Every prop firm alert carries the
   spec strings:
   - `"Prop firm rule warning — no trade was executed."`
   - `"Prop firm guardrail blocked this paper action."`
   - `"Live execution remains locked."`
6. **News + pending-order rules are honest.** Without a connected news provider
   and without a PENDING status in the paper schema, these rules return
   `INSUFFICIENT_DATA` rather than fabricating a pass/fail.
7. **Per-user scoping unchanged.** Every new rule field is per-challenge, per-user.
   The `PATCH /prop-challenges/:id/rules` handler uses `ownChallenge(id, userId)`
   exactly like every other prop-challenge mutation. No cross-user mutation
   surface introduced.
8. **Shared MT5 remains BLOCKED.** No code added to this phase touches the
   MT5 bridge guard. Shared-account isolation invariants from Phase 25 hold.

## What this phase did NOT add

- No new live order route.
- No new MT5 command emission.
- No new broker credential read/write.
- No mutation of the global safety envelope (`paper_only`, `liveLocked:true`,
  `readOnlyMode:true`, `allowOrderExecution:false`).
- No bypass of `orderGuard.ts`.

## Conclusion

Phase 27-B extended the prop firm rule schema, the rule evaluator (route +
tool), the user-facing notification language, and the UI panel — all behind
the existing safety boundary. Broker placement and live execution paths
remain identical to the Phase 27 baseline (commit `b89f8e8`).
