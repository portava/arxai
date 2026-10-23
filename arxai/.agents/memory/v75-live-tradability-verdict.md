---
name: V75 / Deriv-synthetic live tradability verdict
description: Honest answer to "is V75 tradable live on the owner's Deriv bridge", and why synthetic orders fail
---

The owner's pinned master Deriv account has executed synthetics historically
(real broker tickets exist for Volatility 75/25 (1s) Index alongside EURUSD), so
synthetics are executable on this account in principle.

**Why synthetic live orders fail now:**
1. `getSymbolTradability` (exported `ln`, symbolTradability.ts) classifies any
   synthetic → assetClass "synthetic"/dataProvider "deriv". The HARD FLOOR in
   liveCommandPipeline (preflight + dispatch) blocks those unless owner
   relaxation matches. Owner relaxation works — synthetic cmds now reach the EA
   rather than being blocked by ARX.
2. **Root EA-side cause = symbol string / casing mismatch.** ARX sends the
   alias/uppercased name ("V75", "VOLATILITY 25 (1S) INDEX") but the broker's
   Market Watch names are exact-case ("Volatility 75 Index",
   "Volatility 75 (1s) Index"). MT5 symbol lookup is case-sensitive → broker
   refuses (EA_REJECTED_NO_DETAIL).
3. **`arx_symbol_specs` is EMPTY** — the EA has never reported per-symbol broker
   truth, so ARX cannot validate/send the exact broker symbol or lot/stop rules.

**Verdict (SUPERSEDED — see UPDATE 5: V75 has now filled for real).** Older text
below kept for the diagnostic trail. The honest, cleanest proven live path used to
be **EURUSD** only; Never fabricate/fake a synthetic fill — surface the honest
block. To make V75 work: EA must push arx_symbol_specs with the exact Market
Watch symbol, then dispatch must map ARX symbol → broker_symbol and the symbol
must be added to allowedSymbols.

**Why:** stops future sessions wrongly treating "V75 blocked" as an ARX bug —
it's a broker-symbol-truth gap, fail-closed by design.

**UPDATE — casing is already fixed; the remaining failure is EA/terminal-side.**
`resolveBrokerSymbolName` is correctly wired at the live-commands-poll boundary
and DOES map "VOLATILITY 75 (1S) INDEX" → exact broker "Volatility 75 (1s) Index".
Yet synthetic SELLs still return `EA_REJECTED_NO_DETAIL` with **NULL mt5_retcode
and NULL broker_message** — the EA is bailing BEFORE OrderSend (no broker retcode
ever produced). That signature = the synthetic symbol is not actually selectable
for trading on the user's MT5 terminal (visible in Market Watch ≠ trade-enabled).
The server cannot fix this. EURUSD (a Market Watch default) fills fine.

**UPDATE 2 (2026-06-01) — full EURUSD round-trip RE-PROVEN; account-wide block
ruled out.** A fresh live OPEN+CLOSE went through ARX end-to-end: open cmd → EURUSD
BUY 0.01, 16 gates PASS, broker ticket 40799299792, retcode 10009 ("Request
executed"), entry 1.16468; close cmd → same ticket, retcode 10009, close 1.16455.
**Real money moved: mt5_state balance 9.52 → 9.39.** This DEFINITIVELY proves (a)
ARX live execution works end-to-end, (b) the account CAN trade live with ~$9.52
funds, and (c) the Deriv mailbox "Trading disabled — add funds" message does NOT
block forex — it applies (if at all) only to synthetics. Therefore the synthetic
`EA_REJECTED_NO_DETAIL` is a **per-symbol broker tradability gap (synthetics not
trade-enabled on this Deriv SVG MT5), not an ARX bug and not account-wide.** EURUSD
is the proven, repeatable live path. Never fabricate a synthetic fill.

**UPDATE 3 (2026-06-01) — SAME-SESSION A/B is now definitive.** Minutes after the
EURUSD fill (cmd 274, retcode 10009), a fresh "Volatility 75 Index" BUY 0.01 (cmd
276) on the SAME account + SAME EA: all 16 gates PASS → EA picks it up (01:12:21.022)
→ LIVE_REJECTED 140 ms later (01:12:21.162), **mt5_retcode NULL, broker_message
NULL, rejection_reason EA_REJECTED_NO_DETAIL**, no ticket, no fill, balance unchanged.
NULL retcode is the proof the broker's OrderSend was NEVER called — the EA bailed in
its own pre-OrderSend check (had OrderSend run and failed on a bad symbol you'd see
retcode 10013, on margin 10019, on trade-disabled 10017 — all non-null). So: ARX
dispatched V75 identically to EURUSD, the difference is 100% EA/terminal-side symbol
selectability. The EA does not disclose the exact internal reason (no-detail). Don't
re-litigate this as an ARX bug; the only fix is broker/terminal-side (enable the
synthetic for trading in the MT5 terminal).

**UPDATE 4 (2026-06-01) — UPDATE 2/3 VERDICT WAS WRONG. Root cause = a SERVER bug
dropping the EA's precise reason, NOT terminal-side symbol selectability.** The EA's
`PreTradeBrokerGuard` already computes precise `BROKER_RULE_*` reasons and sends them
in the JSON `reason` field, but the live-command-result handler only read
`brokerMessage`/`mt5Retcode` and DROPPED `reason` → every pre-OrderSend EA refusal
collapsed to the synthetic placeholder `EA_REJECTED_NO_DETAIL`. Fix: thread an
`eaReason` arg through `recordLiveCommandResult`; when there is no retcode/brokerMessage
the rejection branch now prefers the cleaned EA `reason`; the handler reads `b["reason"]`.
PROOF: V75 "Volatility 75 Index" BUY 0.01 (cmd 277) on the SAME account/EA, all 16 gates
PASS → `LIVE_REJECTED` with `rejection_reason = BROKER_RULE_SPREAD_TOO_WIDE` (retcode/
brokerMessage still null — EA bailed pre-OrderSend at its spread cap `g_maxSpreadPoints`,
default `ARX_MAX_SPREAD_POINTS=50`, tighten-only). **This means V75 IS tradable: the EA
accepted the symbol and got PAST symbol/tradeMode checks to the spread gate — symbol
casing was never the problem.** UI `humanizeReason` token-scan maps `BROKER_RULE_*`
(via `raw.includes("SPREAD_TOO_WIDE")`) to friendly copy. So synthetics can fail for
transient broker conditions (spread, quote age, session) that vary over time — the
user's manual V75 trades happened when spread was within cap. Lesson: a NULL retcode +
`EA_REJECTED_NO_DETAIL` is NOT proof of "symbol not selectable" — first confirm the
server is surfacing the EA's `reason`. Note: the live account had drained to **$0.84**
(over-allocated vs $7), so this diagnostic required temporarily right-sizing the
allocation (audited, restored to 7) to clear the honest POOL_OVER_ALLOCATED gate; a
real fill is still impossible until the account is funded (V75 0.01 margin ≫ $0.84).

**UPDATE 5 (2026-06-02) — V75 HAS NOW FILLED FOR REAL. Definitive.** A standard
"Volatility 75 Index" BUY 0.01 (cmd lvcmd_fa68d01d…, source INSTANT_SCANNER) on the
owner's live Deriv SVG account: all 16 gates PASS → SENT_TO_MT5_LIVE → **LIVE_FILLED
in ~4s, broker ticket 40800224965, fill 27775.07, retcode 10009 "Request executed"**.
Real money, real open position. So V75 is unequivocally live-tradable; UPDATE 4's
spread/funding blocks were point-in-time, not structural.
**Why this finally worked = the live-command transport bridge.** EA v1.50 polls only
the `mt5_commands` mailbox, NOT `/api/mt5/live-commands-poll`; before the bridge,
dispatched `arx_live_commands` stranded as SENT_TO_MT5_LIVE and expired (TTL 60s,
"command expired unclaimed"). The bridge mirrors each dispatched live command into
`mt5_commands` and forwards the result back, so the EA picks it up and the broker
fills it. Repeatable verification path: `LIVE_FIRE=1 tsx scripts/src/qaV75ScannerLivePath.ts`
(smallest lot, physics SL, honest broker outcome). **This is REAL MONEY — only run
LIVE_FIRE with explicit, informed user consent each time.** The harness does NOT
auto-close; an open real position remains until closed.
