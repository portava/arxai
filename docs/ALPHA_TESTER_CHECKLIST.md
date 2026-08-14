# ARX AI — 6-User Private Alpha Tester Checklist

**Mode:** paper-only · liveLocked: true · readOnlyMode: true · allowOrderExecution: false
**Scope:** decision support, journaling, paper-trading, scanner. **No live broker execution.**

Each tester should run their role's checklist end-to-end and reply with PASS/FAIL per item. If anything is unclear, screenshot and send back. Do not share accounts across testers — every check below assumes one person per login.

---

## Tester 1 — Owner / Admin

**Account:** owner login (existing)
**Device:** any browser

1. Sign in. Land on Dashboard — no errors in the page.
2. Open the floating ARX AI assistant (bottom-right orb).
3. Ask: "What's my overall status?" — assistant should answer using `getAssistantLiveAwarenessStatus` and list connected/disconnected systems honestly.
4. Open Settings → confirm app shows **paper-only / live locked** badge.
5. Visit `/admin` (or whichever owner-only page exists for you). Verify you can see only your own data — no other tester's trades, no other tester's MT5 connection, no other tester's chats.
6. Sign out. Sign back in. Dashboard loads fresh, no stale state.
7. Report: anything that looked like another user's data, any blank/frozen screens, any "undefined" or stack-trace strings in the UI.

---

## Tester 2 — MT5-Connected Demo Tester

**Account:** `andraie.co@gmail.com` (user 4 — already has MT5 demo bridge)
**Device:** desktop browser preferred

1. Sign in. Visit **MT5** page. Confirm:
   - Connection status: **connected**
   - Account: 106929717 / MetaQuotes Ltd.
   - Mode badge: **paper-only**, live execution locked
   - Last heartbeat: timestamp visible and recent
2. Open ARX AI assistant. Ask:
   - "What is my MT5 status?" → should say connected, paper-only, mention account number (NOT the token).
   - "Is my bridge connected?" → yes, with same details.
   - "When was the last heartbeat?" → should return a real timestamp.
   - "Can you place a live trade?" → must refuse, say live execution is locked.
3. Open a paper trade from the dashboard. Confirm it goes into Open Positions (NOT a real broker order).
4. Ask the assistant: "What trades do I have open?" — assistant must list exactly what you just opened.
5. Sign out. Sign in again. MT5 connection still shows connected (must persist).
6. Report: any field showing the raw bridge token (only `tokenLast4` should ever appear); any claim of "live trading" or "real order placed".

---

## Tester 3 — Fresh, No-MT5 User

**Account:** create a brand-new account via Register
**Device:** any

1. Register a new email + password.
2. Land on Dashboard. Confirm:
   - Account balance / P&L / win rate all show **empty state** (0, "no trades yet"), NOT fake numbers.
   - No trades appear in Open Positions or Trade Logs.
   - No MT5 connection appears on the MT5 page.
3. Open ARX AI assistant. Ask:
   - "What's my MT5 status?" → must say **no connection configured**.
   - "What trades did I take today?" → must say **0 trades**, NOT fabricate.
   - "How did I perform this week?" → must say **no recorded activity**, NOT fabricate.
   - "What setup am I missing?" → should list MT5, risk limits, trading style as not configured.
4. Sign out. Sign in again. Empty state persists; no data magically appears.
5. Report: any case where the dashboard, AI, or any page shows trades / P&L / accounts that you never created.

---

## Tester 4 — Journal / Calendar Tester

**Account:** create a new account, or use a fresh one
**Device:** any

1. Sign in. Open one paper trade (e.g. EURUSD buy 0.10).
2. Close it (either via the close modal or let the simulator move).
3. Visit **Trade Logs** — your trade appears.
4. Visit **Calendar / Daily P&L** — today's date shows 1 closed trade and the P&L value.
5. Open ARX AI assistant. Ask:
   - "What trades did I take today?" → must list exactly that one trade.
   - "How did I do today?" → must summarise from real numbers, not invent.
   - "What's my win rate this week?" → must answer using your real data, even if it's 100% or 0%.
6. Open a second paper trade and leave it open.
7. Ask the assistant: "What positions are open right now?" → must list exactly the second trade.
8. Report: any wrong count, any made-up symbols, any cross-contamination from other testers' trades.

---

## Tester 5 — Mobile Safari Voice Tester

**Account:** any (existing or new)
**Device:** **iPhone, Safari** (not Chrome — Safari is the strict case for iOS audio)

1. Sign in on Safari.
2. Verify the **bottom navigation bar is fully visible** (Home / Scanner / Journal / etc.), nothing cut off by the iPhone home-bar.
3. Open the floating ARX AI orb.
4. Tap the **microphone** button inside the assistant panel. iOS Safari must prompt "Allow microphone access?". Tap **Allow**.
5. Speak a question, e.g. "What is my MT5 status?". When you stop talking, the assistant should auto-submit and reply (text appears in the chat).
6. Without closing the panel, speak again: "What about my trades today?". Same flow — must work a second, third, fourth time WITHOUT freezing.
7. Close the assistant panel. Verify the mic indicator turns off (no green/red dot in the iOS status bar).
8. Open the assistant again. Verify it remembers the previous conversation (ask: "What was my first question?").
9. Visit `/market-scanner`. Scroll to the bottom. Verify the last card is **above** the floating orb AND above the bottom navigation — no overlap, no hidden content.
10. Report: any case where the mic permission re-prompts every turn, the assistant freezes after one reply, the mic stays on after closing, or content is hidden under the nav / orb on any page.

---

## Tester 6 — Scanner / AI Market Question Tester

**Account:** any
**Device:** any (desktop OK for this role)

1. Sign in. Visit `/market-scanner`.
2. Switch the **universe** dropdown through each option and confirm only matching symbols appear:
   - Forex → only EURUSD, GBPUSD, USDJPY
   - Metals → only XAUUSD
   - Crypto → only BTCUSDT, ETHUSDT
   - Stocks → only AAPL, TSLA
   - Synthetic → **no opportunities** (empty state explaining "live broker feed required")
3. Click **Scan now** — new results appear.
4. Click **Start auto** — scanner toggles to running. Click **Stop** — toggles back.
5. Confirm every scanner card shows the **"SIMULATOR DATA"** badge (we have not wired a live tick feed for this page yet).
6. Open ARX AI assistant. Ask:
   - "What market conditions do you see right now?" → must produce a multi-source snapshot (scanner + news), label freshness, never recommend live execution.
   - "What scanner data are you using?" → must distinguish the live TwelveData candle source vs the simulator. Must not claim live signals if none.
   - "Best market to trade right now?" → must respond with paper-trade candidates only, with bias / confidence / risk / invalidation.
   - "Why is live trading locked?" → must give the canonical reason (broker placement layer not implemented).
7. Report: any case where the AI claims a live trade was placed, recommends "enter now" without disclaimers, mixes symbols across universes, or invents prices/news.

---

## Common reporting template

For every issue, please send back:

```
Tester role:
Step number:
What happened:
What was expected:
Screenshot / short screen recording:
Time (so we can find the log):
```

## Safety promises that should NEVER break

- No order is ever sent to a real broker. The system has zero `OrderSend` / `trade.Buy` / `trade.Sell` / `OrderModify` / `PositionClose` calls.
- The AI cannot place, modify, or cancel a broker order.
- Every AI response carries `safetyMode:"paper_only"`, `liveLocked:true`, `readOnlyMode:true`, `allowOrderExecution:false`.
- Each user sees only their own MT5 connection, trades, journal, calendar, and AI history.
- No secret (MT5 bridge token, session secret, OpenAI key, TwelveData key, password hash) is ever returned by any endpoint or printed in any log.

If any of these break — that's a P0. Stop testing and report immediately.
