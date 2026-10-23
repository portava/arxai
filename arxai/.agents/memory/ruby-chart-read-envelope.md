---
name: Ruby/assistant safety envelope — derived vs forced paper_only
description: Which Ruby/assistant endpoints DERIVE the per-user safety envelope vs. force the compile-time paper_only constant, and why the OpenAPI contract forces some of them.
---

# Ruby/assistant safety envelope — derived vs forced

Ruby's *reported* safety state (`liveLocked`/`safetyMode`/`readOnlyMode`/
`allowOrderExecution`) is **derived per-user, not hardcoded**. Two patterns:

- **Derived** (spread `assistantEnvelopeFields(deriveAssistantEnvelope(userId))`,
  fail-closed to `FAIL_CLOSED_ENVELOPE` on read failure): all conversational
  surfaces (chat SSE + tools via `dispatchTool`, incl. `getTradingMode` and
  `getPaperSafetyStatus`), realtime voice bootstrap, system prompt, **and the
  read surfaces `POST /me/assistant/read-chart` + `POST /me/assistant/explain-signal`**.
  The two read surfaces additionally force `readOnlyMode:true` so they stay
  non-executing while still reporting the caller's REAL account mode (owner ⇒
  `safetyMode:"live"`, `liveLocked:false`). `err()` paths use `FAIL_CLOSED_FIELDS`.
- **Forced constant** `READ_ONLY_PAPER_ENVELOPE`/`SAFETY_ENVELOPE`
  (`{safetyMode:"paper_only", liveLocked:true, readOnlyMode:true, allowOrderExecution:false}`):
  `GET /me/chart/intelligence`, `POST /me/assistant/draft-read`, and
  `POST /me/assistant/draw-setup`.

**Why forced:** `draft-read` and the chart-intelligence read have OpenAPI
response schemas pinning `safetyMode: { enum: [paper_only] }`; spreading the
dynamic envelope would return `safetyMode:"live"` for an owner — a schema/runtime
contract mismatch typed clients mis-model. (`draw-setup` is forced in code but is
NOT in openapi.yaml — keep that distinction out of docs.) Deriving changes only
what Ruby *reports*; it never weakens the order-guard chain, the 16-gate Phase B
dispatch, the per-trade confirm choreography, or the `requestedBy:"ai-assistant"`
AI_DIRECT_EXECUTION boundary in `placeOrder.ts`.

**How to apply:** a NEW chart/state read whose response schema is
`enum:[paper_only]` must force the constant. Everything conversational/advisory
should DERIVE (honest both ways) and force `readOnlyMode:true` if it must not
place orders. Locked by `scripts/src/rubySafetyEnvelopeDerivedTest.ts` + the
`ruby-derived-safety-envelope` CI guard (asserts NEW-present AND OLD-absent,
comment-stripped, legacy `BROKER_PLACEMENT_LAYER_NOT_IMPLEMENTED` literal absent
ONLY in `derivedEnvelope.ts` — it must remain in the legacy chokepoint/Phase-B
blockReasons/reconciliation field).
