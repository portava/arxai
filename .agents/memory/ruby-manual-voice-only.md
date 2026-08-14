---
name: Ruby manual press-to-record voice (auto-listen removed)
description: Why Ruby's auto-listen was removed, how manual voice is locked, and that Realtime mode is a separate kept-on-purpose path.
---

Ruby's chat panel voice is **manual press-to-record only**. Auto-listen was
removed from `ArxAssistantLivePanel.tsx`.

**Why:** the auto-listen VAD loop re-opened the mic mid-reply and interrupted
Ruby's own TTS, so her spoken answer cut off after a few seconds.

**How it works now:**
- Derived state lock `voiceFlow`: `idle | recording_user_voice |
  processing_voice_message | ruby_speaking`; `rubySpeaking =
  status==="speaking" || tts.state==="speaking"`.
- Mic button is pure tap-to-start / tap-to-stop+send and is **disabled while
  `rubySpeaking`** (and while processing/uploading/thinking/streaming/
  listening) so TTS runs to completion unless the user hits the Stop control.
- The mic never re-opens on its own.

**How to apply / gotchas:**
- `useAutoListen.ts` is intentionally left on disk but fully unwired (zero
  refs). Do NOT rewire it — re-adding the auto-restart loop reintroduces the
  TTS cut-off bug. If hands-free is ever wanted, gate it so it cannot fire
  while `rubySpeaking`.
- The separate **Realtime WebRTC live-call mode** (`arx-realtime-start`,
  mute/stop) is a different feature and was kept on purpose. It is explicit
  user-initiated full-duplex (mic never opens by itself); it is NOT the
  auto-listen path. Code review may flag it as a strict "only manual" gap —
  keeping it is the intended scope boundary.
- Proof test: `ArxAssistantLivePanel.manualVoice.test.tsx`. The big panel
  file OOMs vitest under the default pool here — run with `--pool=forks`.
