---
name: Ruby live-execution is an integration, not a greenfield build
description: The "make Ruby execute trades" request is already substantially wired — extend the single live path, never build a second one.
---

# Ruby live-execution is an integration, not a greenfield build

The Ruby → live execution seam already exists end-to-end. The assistant
instant-trade-command endpoint parses the utterance and forwards a
Ruby-flagged intent through the **same** `executeInstant()` path every other
trade surface uses — there is no Ruby-only dispatch code.
OPEN/CLOSE/CLOSE_ALL/MODIFY/break-even are covered. Full (drift-prone)
detail: `docs/RUBY_EXEC_HANDSHAKE_UPGRADE_AUDIT.md`.

**Why:** A future agent reading "build Ruby execution" will be tempted to
write a new dispatch path. That would create a second, un-gated live path —
a safety violation. The correct move is to extend the existing seam.

**Durable invariants (verify exact names/lines in code — they drift):**
- **Single live path.** Every Ruby action, including future watch-enter /
  monitor-close triggers, MUST route through `executeInstant()`. No parallel
  path. The 16-gate evaluator is the core check but NOT the only one —
  additive pre-gates (command-integrity, allocation-freeze,
  pilot/user-access/bridge) also run at dispatch; never describe it as
  "only 16 gates."
- **Ruby auth is additive AND default-deny.** A Ruby-source pre-check
  AND-gates a master AI flag + a per-action allow flag *before* the 16
  gates; it never replaces them. Master + OPEN flags default false.
- **OPEN needs more than the AI flags.** A Ruby OPEN additionally requires
  the user's live one-click setting to be enabled — enabling the AI flags
  alone is insufficient to OPEN.
- **Backend already honours the flags.** The settings flags are read/written
  by the existing one-click settings API and enforced by the gate. The
  genuine missing piece is the **frontend** settings controls (plus the two
  new lifecycle intents, which the command parser does NOT yet have).
- **monitor-close ≠ protective engine.** A "monitor and close" trigger is a
  *user-authorized* close through the live path. Do NOT flip the protective
  auto-close engine off ALERT_ONLY/locked. `autoCloseMode = "ALERT_ONLY"`
  stays.
