---
name: Global broker diagnostics ownership
description: Why a global broker provider cannot be made per-user merely by stamping its output with a user ID.
---

A global broker adapter is operator diagnostic data, not user-owned data. Adding
the caller's user ID only to snapshots or logs does not establish ownership of
the underlying account. Keep the surface operator-only until provider selection
and credential lookup are genuinely bound to that authenticated owner.

**Why:** A globally selected provider can return the same account to every
caller. Stamping each response with the current caller would launder shared
account data into apparently private rows and create a cross-account disclosure.

**How to apply:** Effective-role gate every route that can call a global broker
adapter, retain per-operator row scoping, and keep global broker data out of
per-user aggregators. A future user-facing adapter must resolve an owner-bound
connection first and fail closed when none exists.