# Voice/realtime and news/calendar: grades against the A+ bar

The A+ bar (owner ruling, 2026-11-09): every number shown or spoken is measured and true, every claim is checked, and CI tests prove it. The AI never places orders.

## Voice / realtime

### Before: grade C−

| Question | What was true |
|---|---|
| What's measured | Nothing about the spoken content. Only the rate limit and session cap were counted. |
| What's claimed | The realtime and gpt-audio prompts told the model it has no tools and should not quote numbers. |
| What's checked | **Nothing.** Typed chat goes through the runtime claims verifier (`grounding/*`). Voice did not. |
| Numbers shown/spoken | Whatever the model said. That covered prices, tickets, times, "your order filled" and percentages. |
| Tests | Envelope, mint-shape and no-tools tests only. None covered what voice says. |

What held it back:
1. **gpt-audio** (`POST /me/assistant/conversations/:id/voice`) relayed `audio_chunk` and `transcript` deltas to the browser as the model produced them. The audio and the bubble were never checked.
2. **gpt-realtime** (WebRTC) streamed model audio directly from OpenAI to the browser's speaker, with no server in the path. Partial transcripts were also shown in the bubble unchecked.
3. **TTS** (`POST /me/assistant/tts`, `tts-1-hd` / ElevenLabs) synthesized any text the client sent.
4. When server TTS failed, browser `speechSynthesis` read text aloud verbatim, including `[unverified]` figures.
5. **Voice could execute.** A spoken direct command went to `/me/assistant/instant-trade-command` with `source: "eleanor_voice"` on the same execution path as typed commands. "close it" answers to a reversal alert closed the position outright.

### After: grade A+

- **One gate.** `lib/assistant/voice/speechGate.ts` uses the same `checkSegment` the text verifier uses. It checks numbers, tickets, clock times, dates, execution claims and probabilities.
  - Speech is stricter than text: a listener cannot see an `[unverified]` mark. So any sentence with a finding is not read aloud.
  - Runs of withheld sentences become one spoken notice.
  - If the withheld sentence claimed an execution, a dedicated notice replaces it: "I can't place, change or confirm orders by voice, and nothing was executed."
  - Text the text verifier had already marked or removed is never spoken.
- **gpt-audio: hold, gate, then release.**
  - The route buffers the model's audio and transcript until the turn is complete, then calls `gateVoiceTurn`.
  - Clean turn: the held audio plays unchanged.
  - Any finding: the model audio is dropped. The bubble shows the verified text, and `speech_replaced` carries the speakable text, which the client reads through TTS.
  - The persisted message is the verified text.
- **Realtime: verified text, then TTS.**
  - Sessions are minted with `output_modalities: ["text"]`, so the model emits no audio.
  - The browser sends each final answer to `POST /me/assistant/voice/speech-gate`. It shows the gated `display` and speaks only the gated `speech`.
  - Partial deltas are never shown.
  - If the gate is unreachable, it fails closed: nothing is shown or spoken.
- **TTS route gates too.**
  - Each sentence must either be claim-free or appear verbatim, after markdown normalisation, in text the verifier already released to *this* user.
  - That released text comes from the speech ledger (chat content events and the server-composed briefing) and from the user's last 10 persisted assistant messages.
  - Everything else is replaced by the notice before any provider is called.
  - Response headers `X-ARX-Speech-Gate` and `X-ARX-Speech-Withheld` report the result.
- **Browser fallback.** `sanitizeForSpeech` drops any sentence carrying verifier markup.
- **Voice never places or confirms an order.**
  - `voiceCommandDecision` runs before any watch acknowledgement or command parse.
  - For `eleanor_voice` it refuses every execution path, including the confirm resend and "close it". The request is audited as `ELEANOR_TRADE_COMMAND_VOICE_BLOCKED`.
  - The only voice command allowed is "keep it / hold", which sends nothing to a broker.

**Latency trade-off.** First audio now waits for the full reply instead of streaming.

| Path | Before | After |
|---|---|---|
| gpt-audio, clean turn | First audio at the model's first audio byte (~0.5–1 s) | First audio when the whole reply is generated (~1–4 s for a 1–3 sentence reply) |
| gpt-audio, turn with a withheld claim | Same as above | The above plus one TTS round-trip (~0.4–1.5 s) |
| Realtime | ~0.3–0.6 s speech-to-speech | Text reply, then the gate, then TTS first byte (~0.6–1.5 s) |

- The gate itself is measured in CI: a 2,000-character turn takes a median of about 0.5 ms (`[voice-claim-gate]` line).
- The provider latencies above are estimates, not measured. They cannot be measured offline.
- We accept the delay because the owner ruling forbids unchecked figures reaching the listener.

**Tests.**
- `pnpm --filter @workspace/api-server run test:voice-claim-gate` (24 tests). It covers:
  - eight scripted transcripts (clean, price, ticket, time, execution, probability, user echo, mixed)
  - ledger trust and per-user isolation
  - markup never spoken
  - the voice command policy
  - source-level wiring proofs for all four routes
  - the gate-cost measurement
- `artifacts/trading-dashboard/src/components/help/voiceClaimGate.client.test.ts` covers:
  - the browser speech filter
  - the realtime gate client, including fail-closed behaviour
  - final-event detection

**Residual.**
- The realtime `session.update` is sent from the browser. A user who tampers with their own browser could re-enable audio on their own session. The server-minted default is text-only.
- The ledger is in-memory. After a restart, verified figures are recognised from persisted messages instead.

## News / economic calendar

### Before: grade B−

| Question | What was true |
|---|---|
| What's measured | Fetch time and cache age (service level), connected/missing/error/empty states. |
| What's claimed | Impact buckets (provider importance or ARX classifier), FRED event times. |
| What's checked | Honest provider states, the stale-on-error label at service level, and stored-calendar window coverage. |
| Numbers shown | Event times, forecast/previous/actual as the provider reported them, minutes-to-event countdowns. |
| Tests | TE and FRED calendar suites, news-risk fabrication, heat radar honesty. |

What held it back:
1. **DST-wrong times.** FRED gives release dates only. Every FRED event was stamped `00:00 UTC`. The news-risk scorer, the assistant resolver and the reconciliation pre-news check then counted down to midnight, not to the real release (CPI is at 08:30 US Eastern, which is 13:30 or 12:30 UTC depending on DST).
2. **No per-event provenance on the served shapes.** `/news/calendar`, `/economic-calendar/events` and the stored `/economic-events` rows had no per-event fetch time or freshness, so a stale event could not be labelled where it is shown. The stored table had no fetch time at all, and re-syncs did not stamp one.
3. **Mock generator still wired.** `pickNewsProvider()` defaulted to a provider that fabricated an FOMC/CPI/NFP schedule at invented times. Legacy `source='mock'` rows stayed readable from the stored calendar.
4. **Impact basis undocumented.** Nothing stated that impact is a category and not a forecast.

### After: grade A+

- **Source, fetch time and freshness on every served event.**
  - Live and legacy shapes carry `provider`, `source`, `fetchedAt`, `freshness` and `stale`, plus `timePrecision`, `timeSource` and `impactBasis` on the live shape. Stale-on-error events keep their original fetch time and are labelled STALE.
  - Stored rows get a new `fetched_at` column, stamped on insert and on re-sync. Reads serve `fetchedAt` and `freshness`: LIVE up to 5 min, DELAYED up to 6 h, then STALE. A row with no recorded fetch time, or one stamped in the future, is STALE.
  - The Economic Calendar page shows a "Source · fetched … UTC · Stale" line on each row.
- **UTC-correct across DST.**
  - `releaseSchedule.ts` converts each agency's published US Eastern release time to UTC for that specific date, using the IANA zone (Intl). The host time zone does not affect it.
  - A release with no published time stays date-only: `timePrecision: "date"`, the midnight sentinel, never shown as a clock time, and the news-risk scorer never counts down to it.
  - Downstream date-only checks (scanner selected-market, calendar page) now treat only the sentinel as date-only.
- **Mock removed.** With no provider selected, the picker returns the honest-empty provider `none`. Every stored-calendar read, including trading readiness, excludes `source='mock'`.
- **Impact provenance.**
  - Impact is a category with `impactBasis`: `provider_importance` (Trading Economics) or `arx_release_classifier` (FRED).
  - No calendar shape carries an expected-move or impact number. None is measured from history today, so none is shown. CI asserts this.
  - The heat engine's internal `impactScore` is a count-based input to the heat magnitude. It is not shown as a forecast.

**Tests.**
- `pnpm --filter @workspace/api-server run test:news-calendar-provenance` (20 tests). It runs with `TZ=Asia/Tokyo` to catch any local-time arithmetic, and covers:
  - DST, on both sides of the 2026 switches including the switch days
  - FRED schedule times and the date-only fallback
  - zone-less TE timestamps
  - no countdown to a sentinel
  - LIVE, then DELAYED, then STALE-on-error, with the original fetch time
  - provenance on all served shapes
  - stored-row freshness, route wiring and mock exclusion
  - impact basis and no forecast fields
- The existing TE and FRED suites were updated for the mock removal and real release times.

**Deploy.** Apply `lib/db/migrations/2026-11-10_economic_events_fetched_at.sql` before deploying. It is additive.

**Residual.** Release times come from the agencies' published schedules, not from the FRED feed. If an agency moves a release time, `FRED_RELEASE_TIMES_ET` must be updated. Every entry records the publisher.
