---
name: Agent Ecosystem uses raw Express + audit, not OpenAPI
description: Convention for adding agent-ecosystem endpoints — they are NOT contract-first
---

The entire `/api/admin/agent-ecosystem/*` subsystem is built with raw Express
routers + `adminActionAuditLogTable` rows, NOT the contract-first OpenAPI/Orval
flow the rest of the app uses. NO agent-ecosystem endpoint appears in
`lib/api-spec/openapi.yaml`.

**Why:** these are admin/OWNER-only operator/diagnostic surfaces (advisory/shadow
governance), never consumed by generated client hooks. Layers 1–3 all followed
this; adding OpenAPI for just one layer would be inconsistent.

**How to apply:** when extending agent-ecosystem, add a raw Express route in
`artifacts/api-server/src/routes/agentEcosystem.ts` guarded by the local
`requireAdmin`, validate the body inline, and write a fail-closed audit row
(action + beforeState + afterState + reason≥3). Do NOT add it to openapi.yaml or
run codegen for it. If a code review flags "missing OpenAPI", this convention is
the documented rationale.
