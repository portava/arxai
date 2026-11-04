# AI and Truth completion sweep (2026-11-04)

Branch `claude/ai-truth-complete-20261104`, stacked on PR #112 (`claude/closed-market-bars-20261104`).
Four read-only sweeps (AI chat server + tools, Truth + banners, Smart Chart + signals, AI dashboard client)
found 37 defects; each was checked against both the calling and the receiving code. Fixes below.
Nothing here re-opens the settled T1/T2/T4 decisions or the #108 audit fixes.

## Truth
| Id | Fix |
|---|---|
| TRUTH-1 | Router durable-mirror bars (`durable_mirror`) are never `aiUsable`, like the #112 stored-history serve. |
| TRUTH-2 | `feedScope` / `contention` / receive-time basis are now shown: "Shared feed — not your bridge" and "Two bridges pushing" chips on the feed badge and Ruby Market Read; "(received)" on receive-time stamps; Ruby says when prices come from the shared feed. |
| TRUTH-3 | Truth snapshot carries `data.notLiveReason: "market_closed"`; new evidence reason `MARKET_CLOSED` (stale class); verdict says "the market is closed" instead of "live feed not confirmed" (action unchanged: wait). |
| TRUTH-4 | Client scanner truth and display status read `notLiveReason`; stored history gets its own strip and wording, never "Delayed" or SYNCING. |
| TRUTH-5 | Feed confidence uses the server's closed-market / stored-history message and label. |
| TRUTH-6 | Stored history has no feed scope, no contention check and no broker-clock reading. |

## AI chat (server)
| Id | Fix |
|---|---|
| AICS-1 | "buy EURUSD 0.01 sl 1.0850 tp 1.0950" carries SL/TP; "sl at X" is never an entry trigger; pip-distance SL/TP asks for a price. |
| AICS-2 | Account/positions/journal/daily P&L/performance tools read the same book as the Performance Calendar (`lib/performanceCC/closedTradeLedger.ts`), with the basis labelled. |
| AICS-3 | `runPreTradeRiskCheck` runs the real Risk Governor in preview (no audit/peak writes); `wouldPass: null` when it cannot run. `getRiskLimits` returns the limits in force and their source. |
| AICS-4 | Last tool round cannot call tools; an empty reply becomes an error, never a blank bubble. |
| AICS-5..7 | Push-to-talk prompt knows voice has no tools; prompt names real tools; ticket-preview tools described as previews. |
| AICS-8 | Dead `setVoiceMode` client branch removed. |
| AICS-9 | `getCurrentEvents` (no provider) no longer offered. |
| AICS-10 | Safety envelope computed once per chat request. |
| Voice route | Transcribes the clip, sends `user_transcript`, forwards provider audio as `audio_chunk`, always ends with `done`. |
| AC7 server | `instant-trade-command` accepts optional `conversationId`; the command and reply are saved in an owned conversation (confirm resend stored as "Confirm: …"). |

## Smart Chart and signals
| Id | Fix |
|---|---|
| CS1 | Expiry beats confirmation: an expired setup can no longer prefill the ticket and its lines leave the chart. |
| CS2 | Setup-preview scanner score only from the chart's own timeframe, labelled ("Scanner (H1) 72" / "no scanner score for M5"). |
| CS3 | Chart position alerts include MT5 demo/live positions (same scope as `/me/positions/all`), broker-suffix-insensitive. |
| CS4 | Momentum alerts paused on a stale/degraded feed; position alerts only on a ≤30 s bridge price; skips listed in `suppressed`. |
| CS5 | New Smart Chart "Decision receipts" panel: history, record outcome, similar setups, behaviour cautions. |
| CS6 | Ruby zones on Smart Chart expire at the next candle close and show their age; not resurrected after feed recovery. |
| CS7 | Scanner fetch failure shows "Scanner unavailable", not "No scanner signal". |

## AI dashboard client
| Id | Fix |
|---|---|
| AC1 | Voice stream accepts the server's event names (old ones kept); never stuck in "speaking"/"Transcribing…". |
| AC2 | Realtime voice accepts the per-user safety modes. |
| AC3 | Chat commands send the real account mode; non-live and unarmed users get a plain sentence, not a raw error after Confirm. |
| AC4 | Settings switches for Ruby open / close / modify-SL/TP permissions (defaults stay OFF); refusal codes shown as sentences. |
| AC5 | "Ask Ruby" on a position opens the chat panel with the question (no throwaway conversations). |
| AC6 | After a command, the chat follows the command status and posts filled / closed / rejected / still pending (20 s cap). |
| AC7 | Typed commands saved in the conversation (voice already saved by the voice route). |
| AC8 | Spoken commands go through the same gated command pre-filter. |
| AC9, AC11–13 | One voice preference; corrected empty-state copy; 429 shows retry time; demo-trade wording. |
| AC10, AC14 | AC10 resolved server-side (AICS-8); AC14 already fixed on PR #111. |

## Not done / for the owner
- PR #111 (MT5 order controls + Ruby fakeout SL/TP authority) is not in this stack (#112 is based on #110). The fakeout authority was not re-swept here.
- Remaining paper-trade wording: prop-firm copy in `tools.ts` (~1700), `systemPrompt.ts` (~471), `evaluatePaperTradePlan` description.
- Voice replies now start after one transcription (the user's words are shown first).

## Tests
New suites wired into root `ci`: api `test:ai-chat-server-20261104` (27), api `test:chart-signals-20261104` (9),
dashboard `test:chart-signals-20261104` (34), dashboard `test:ai-client-20261104` (28); new files added to
api `test:truth-component-evidence` (`marketClosedTruth`, 1540 total) and dashboard `test:scanner-truth` (781 total).
Typecheck clean, guards 87/87, full dashboard vitest 4555 pass / 5 fail (the known pre-existing
chart-setup-safety ×4 and SelectedMarketPanel.responsiveness ×1 on the #110 base).
