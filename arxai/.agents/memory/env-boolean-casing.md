---
name: Env boolean casing must go through a shared helper
description: Process.env reads of boolean-shaped values must use a case-insensitive shared helper, not ad-hoc `=== "true"` checks scattered through call sites.
---

Process.env values are always strings and may be set with any casing (`True`, `TRUE`, `true`, `1`, `yes`). When two call sites parse the same env var with different rules — one `=== "true"`, another `.toLowerCase() === "true"` — they will disagree at runtime, producing UI contradictions (e.g. header reports armed, page reports disabled) that look like state bugs but are actually parser bugs.

**Rule:** every boolean-shaped env var must be read through `isEnvTruthy(raw)` or a dedicated wrapper (e.g. `isLiveBrokerExecutionEnabledEnv()` in `lib/domain/src/safety-contracts/isLiveBrokerExecutionEnabled.ts`). Never write `process.env.FOO === "true"` inline.

**Why:** ARX_LIVE_BROKER_EXECUTION_ENABLED was set to `True` (capital T). Half the readers used `=== "true"` (false) and half `.toLowerCase() === "true"` (true). The contradiction showed up as the header saying "live armed" while every live page said "disabled".

**How to apply:** when adding any env-driven boolean gate, import the helper. When reviewing PRs that read `process.env.SOMETHING`, treat raw string comparison as a code-smell and require the shared helper.

The Replit secrets UI does not normalize casing — operators routinely type `True`, `TRUE`, `1`, etc. The helper must tolerate all of them.
