---
name: ARX Single Confirm vs MT5 terminal One-Click Trading
description: Two unrelated "one-click" concepts; the bridge cannot read the MT5 terminal checkbox
---

There are TWO distinct things called "one-click" — never conflate them in code,
copy, or diagnostics:

1. **MT5 terminal "One Click Trading"** (Options → Trade checkbox). A terminal-side
   UI convenience setting. **MQL5 does NOT expose it to EAs**, so the bridge
   genuinely cannot read it. EA v1.29 heartbeat `capabilities`/`eaInputs` report
   `algoTradingAllowed`, `enableLiveExecution`, `readOnlyMode`, `terminalConnected`
   — but nothing for this checkbox. ARX must report it as
   "Not readable by ARX / Unknown", never as OFF, and must NEVER gate live
   dispatch on it.

2. **ARX "Single Confirm" (a.k.a. one-click live)** — the APP-side, **per-user**
   setting in `user_one_click_settings.live_one_click_enabled` (MT5 Setup →
   One-Click Trade card). THIS is what `executeInstant` checks for open actions
   (BUY/SELL); when false it returns `LIVE_ONE_CLICK_DISABLED` (412) *before* any
   dispatch. Reduce-only (CLOSE/CLOSE_ALL/MODIFY) is intentionally NOT gated by it.

**Why it matters:** earlier copy said "one-click is off" ambiguously, making the
owner think ARX wanted them to flip the MT5 terminal checkbox (which was already
ON) — when ARX actually meant its own app setting. The user-facing fix is wording
only: `humanize.ts` LIVE_ONE_CLICK_DISABLED → "ARX Single Confirm (live) is off",
the toggle card titled "ARX Single Confirm (One-Click)", and the admin live-gates
diagnostic carries two explicit rows (`mt5_terminal_one_click` =
MT5_ONE_CLICK_NOT_READABLE_BY_BRIDGE, `arx_single_confirm_live` = per-admin
ARX_SINGLE_CONFIRM_LIVE_ON/OFF).

**How to apply:** any new copy/diagnostic touching "one-click" must name which one.
Enabling ARX Single Confirm requires the typed phrase `ENABLE ONE CLICK TRADING`
+ master-live access; it bypasses none of the 16 gates.

**Ruby/assistant denied the feature exists:** when asked "how do I turn on one
click trading", Ruby answered it doesn't exist / "ARX is paper-only". Two root
causes, and fixing only one is insufficient: (1) `featureMap.ts` had no
`one_click_trading` entry so `getFeatureHelp` returned `found:false`; (2) the
assistant system prompt's dominant "execution is confirmation-based / not
fire-and-forget / read-only" priors made the LLM deny the feature even after the
tool ran. **Why:** the registry is fuzzy-matched and the LLM overrides a weak
tool result with strong prompt framing. **How to apply:** to make Ruby reliably
surface a real feature, add BOTH a registry entry (shortDescription must contain
the literal user phrase for `getFeatureHelp`'s `includes()` fuzzy match) AND a
deterministic system-prompt bullet asserting the feature exists + which tool to
call. Knowledge/wording only — never weakens read-only or any gate.
