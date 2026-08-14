---
name: MQL5 WebRequest body off-by-one truncation
description: EA POST bodies arriving 1 byte short (missing final brace) → server entity.parse.failed
---

# MQL5 `StringToCharArray` + `WebRequest` POST body off-by-one

Symptom: server rejects EA POSTs with `entity.parse.failed` / "Expected ',' or
'}' after property value in JSON at position N" where N is the LAST char — the
captured raw body is valid JSON **missing its final `}`** (truncated exactly 1
byte). Diagnose by capturing the raw bytes via `express.json({ verify })` (runs
before parse, so you see the body even when parse fails), not by reasoning about
the source string.

**Root cause:** `StringToCharArray(s, arr, 0, count, CP_UTF8)` with an *explicit*
count does NOT append a NUL terminator. Code that then does
`ArrayResize(arr, ArraySize(arr) - 1)` (a pattern that's only correct when a NUL
was appended) chops off the last REAL byte.

**Fix:** convert with `WHOLE_ARRAY` (which appends the NUL and returns the byte
count including it), then strip only the NUL:
```mql5
int len = StringToCharArray(json, post, 0, WHOLE_ARRAY, CP_UTF8);
if(len > 0) ArrayResize(post, len - 1);
```
**Why:** WHOLE_ARRAY's return value is the authoritative byte length incl. the
terminator, and is multibyte-UTF-8 correct (unlike `StringLen`, which counts
characters, not bytes).

**How to apply:** any MQL5 EA whose POSTs the server flags as malformed — check
the single shared `PostJson`/WebRequest helper first; one fix covers every
endpoint (heartbeat, snapshots, command-result). The server is behaving
correctly (it should reject malformed JSON); the bug is EA-side and needs a
recompile + reinstall, so it can't be verified live from this environment.
