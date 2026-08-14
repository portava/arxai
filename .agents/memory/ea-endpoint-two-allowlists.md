---
name: EA-facing route needs TWO allowlists
description: A new EA bridge endpoint 401s with AUTH_REQUIRED unless added to the global-gate PUBLIC_EXACT list, not just the body-parser list.
---

A new EA-facing bridge endpoint (per-user `X-MT5-Bridge-Token`, no user
session) must be registered in **two independent places** or it fails before
`bridgeAuthPerUserOnly` ever runs:

1. `artifacts/api-server/src/lib/auth/globalGate.ts` → `PUBLIC_EXACT` set
   (router-relative path, e.g. `/mt5/candles/ingest`, NO `/api` prefix). This
   is the one that bites: without it `requireAuthOrPublic` returns
   `401 {error:"AUTH_REQUIRED", message:"Sign in required."}` — which looks
   like a token-match failure but is actually the session gate rejecting an
   unauthenticated request before the bridge-token middleware can run.
2. `artifacts/api-server/src/app.ts` body-parse loop (only if the body can be
   large / needs `requireBridgeTokenHeader` pre-gate). Smaller bodies inherit
   the global `express.json()` and don't strictly need an entry here.

**Why:** the symptom is misleading. A correctly-seeded `mt5_connection` row
(SHA-256 token hash matches in DB) still 401s, so you suspect the hash or the
harness DB. The real cause is the global gate. Debug by printing the 401 body:
`AUTH_REQUIRED`/"Sign in required" = global gate; `"Invalid MT5 bridge token."`
= `bridgeAuthPerUserOnly`.

**How to apply:** when adding any EA/bridge route, grep `globalGate.ts` for a
sibling endpoint (`/mt5/sync-candles`) and add the new path right next to it.
The `global-gate` CI invariant guard validates the list shape.
