# CLAUDE.md - ARX AI (Claude Code entry point)

Read ./replit.md FIRST - it is the authoritative project doc (invariants, 18
live-trading gates, run/QA commands, where things live). This file adds only
the Claude Code working rules carried over from the Portava workflow.

## Non-negotiable safety
- This is a live-trading system. Before touching lib/safetyCore.ts, vault
  tables, MT5 routes, strategyEngine.ts, anything under
  lib/domain/src/safety-contracts/, or the Phase B live pipeline, read
  docs/SAFETY_NOTES.md. Never weaken a gate, default, or invariant.
- Never place/close live trades, change arming/approval state, or touch
  broker credentials to "test" something. Default-deny stays default-deny.
- pnpm run ci must be green before any commit (pnpm run typecheck while
  working).

## Evidence discipline (Portava method)
- Claims about current behavior need file:line evidence read at your own
  HEAD. Unproven statements are assumptions-to-verify: prove them with
  read-only evidence (a command + its output) before they influence code.
- Committed is not applied; a green suite is not verification. Prefer a
  command you ran over a file you understood.
- Completion reports state what ran, against what, with output. A phase
  that cannot produce proof is reported as unverified, not complete.

## Workflow
- Branch + PR to origin (github.com/portava/arxai); never commit straight
  to main. The owner presses the final trigger on anything irreversible or
  production-facing - stage, verify, then hand over the press.
- replit.md stays lean; completed-phase detail goes to
  docs/history/replit-history.md.
