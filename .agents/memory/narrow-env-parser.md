---
name: Narrow env parser for ARX_LIVE_BROKER_EXECUTION_ENABLED
description: The live-broker master switch must only accept literal "true" (trimmed, case-insensitive). Broadening it is a safety regression.
---

The `isEnvTruthy()` helper that backs `isLiveBrokerExecutionEnabledEnv()` and `ARX_LIVE_BROKER_EXECUTION_ENABLED` accepts ONLY the string `"true"` after trim + lowercase. It rejects `"1"`, `"yes"`, `"on"`, `"TRUE "`, etc.

**Why:** the user explicitly confirmed this (multiple sessions in a row). A loose parser is a real-money risk — a typo like `ARX_LIVE_BROKER_EXECUTION_ENABLED=1` would silently enable live dispatch with no operator awareness. The strict literal forces operators to type the exact intentional value.

**How to apply:**
- Never replace the parser with `Boolean(value)`, `value === "1"`, or any zod coerce.
- When an admin reports "I set it but it's not on", the diagnostics endpoint already surfaces the expected literal (`"true"`) inside `adminDiagnostics.envExpectedLiteral` — point them there before changing the parser.
- If a future request asks to broaden it, push back and require an explicit go-ahead in writing.
