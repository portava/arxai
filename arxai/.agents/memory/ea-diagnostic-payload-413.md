---
name: EA diagnostic result payloads exceed default JSON body limit
description: ENUMERATE_SYMBOLS (and other large EA command-result POSTs) 413 under the default 100kb express.json ceiling
---

# EA `command-result` payloads vs the default body-parser limit

Symptom: an EA diagnostic command (e.g. `ENUMERATE_SYMBOLS`) is claimed by the
EA (`mt5_commands.status` flips PENDING→DELIVERED) and the EA runs it, but the
result never ingests — `arx_symbol_specs` stays empty. Server log shows
`PayloadTooLargeError` / `entity.too.large` **413** on `POST /api/mt5/command-result`,
NOT a 400. The command sits at DELIVERED forever (the EA records the cmdId via
RememberCmd and will NOT retry — you must dispatch a fresh command after fixing
the server).

**Root cause:** `express.json()` defaults to a 100kb body limit. A full symbol
enumeration (EA cap `MaxSymbolsEnumerated` ~600 rows × per-symbol specs) is
~300–450kb, so the parser rejects it before the route handler runs.

**413 → 502 CASCADE (critical):** a body-parser 413/parse-reject fires BEFORE
the request body is drained. On a keep-alive connection the un-read bytes
mis-frame the NEXT request on that socket, so the EA's following heartbeat /
pending-snapshot push surfaces as a **502** (looks like the server died but it
didn't). So a single oversized `command-result` produces the exact screenshot
trio: `command-result 413`, then `heartbeat 502`, `pending-snapshot 502`.

**Fix (three parts, all server-side in `app.ts`, no EA recompile):**
1. Parse EVERY array-carrying bridge endpoint (not just command-result:
   `command-result`, `positions-snapshot`, `pending-snapshot`,
   `sync-positions(-per-user)`, `sync-symbol-specs`) with a generous BOUNDED
   `express.json({limit:"25mb", verify})` mounted BEFORE the global parser
   (once it sets `req._body`, the global `express.json()` skips re-parsing).
   25mb fits a full ~600-symbol Deriv enumeration with zero symbol-dropping;
   no chunking needed. `heartbeat`/`sync-account` get 1mb. The `verify` hook
   captures `buf.length` → a post-parse `/api/mt5` middleware logs
   `mt5_payload_size {path,method,bytes}`.
2. In the JSON error handler set `Connection: close` ONLY on parser-class
   rejects (`entity.too.large` / `entity.parse.failed`, plus 413) so the
   poisoned keep-alive socket is dropped instead of corrupting the next
   request — this is what actually breaks the 502 cascade. Do NOT close the
   socket on generic app-thrown 400s (their body was fully read).
3. The raised limit parses BEFORE auth (auth lives in the route middleware), so
   add a cheap presence-only `X-MT5-Bridge-Token` header gate in front of those
   parsers (response shape identical to `bridgeAuthPerUserOnly`'s TOKEN_MISSING)
   so an unauth caller can't force a 25mb parse. Real constant-time validation
   still runs downstream.

**Why scope the limit:** raising the GLOBAL limit broadens body size on every
endpoint incl. public auth routes (DoS surface). Scope the bump to the per-user
bridge paths that actually carry big payloads.

**Self-test without the EA (curl through `localhost:80`):** no-token+30mb→401
TOKEN_MISSING (pre-parse); token+30mb→413 PAYLOAD_TOO_LARGE; token+5mb-valid→
401 TOKEN_INVALID (proves limit raised, not 413); `/api/healthz` 200 before AND
after the oversized post (proves no crash/cascade).

**How to apply:** any new EA read/diagnostic command that returns a large
payload (GET_SYMBOL_RULES, big position snapshots) posts to the same
`command-result` sink, so this one scoped parser covers them. To re-run after a
server fix, INSERT a fresh PENDING `mt5_commands` row (action, status='PENDING',
safety_mode='paper_only', user_id, mt5_connection_id) — the EA polls
`/api/mt5/commands` (filtered status='PENDING') and picks it up within ~5s.
ENUMERATE_SYMBOLS is read-only (walks Market Watch, never OrderSends), so a
direct PENDING insert is consistent with the safe-command pattern and does NOT
go through the paper-only BLOCKED trade chokepoint.
