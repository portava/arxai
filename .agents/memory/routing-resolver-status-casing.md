---
name: Routing resolver status casing
description: virtual_trading_accounts.status and shared_master_accounts.status comparisons must normalize case.
---

`resolveRouting()` in `lib/adminTrading/routingResolver.ts` must compare row `status` columns case-insensitively (`String(x).toLowerCase() !== "active"`). Production rows exist with both `"ACTIVE"` and `"active"`.

**Why:** A strict `!== "active"` against an `"ACTIVE"` row makes the resolver return `VIRTUAL_ACCOUNT_ACTIVE` (the documented "soft case"). The frontend `liveSharedReasonCopy.ts` maps any reason containing `VIRTUAL_ACCOUNT` to "Your account isn't set up for the shared live route yet. Contact your operator…" — surfaces as a false allocation blocker on Validate. OWNER fallback in `tradesLiveShared.ts::requireSharedRouting` masks this for OWNER only; normal users see the false blocker.

**How to apply:** Any new comparison of a DB `status` column to a literal string must `.toLowerCase()` both sides. Same applies to enum-like text columns inserted by older code paths that didn't normalize.
