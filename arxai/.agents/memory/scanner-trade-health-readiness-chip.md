---
name: Scanner Trade-Health readiness chip (display-only)
description: The Scanner header's prominent Trade-Health chip reuses the existing readiness verdict; why LIVE_GATE_BLOCKED deliberately keeps the green feed-quality tone.
---

The Market Scanner header surfaces a compact, prominent **Trade Health** chip
that reads the EXISTING `ScannerTruth.readiness` (`evaluateTradeHealthReadiness`
verdict) and renders its `displayLabel` + `userFacingTrustLine`. It is
DISPLAY-ONLY — it derives nothing new, gates nothing.

Tone rule (honesty): ONLY `dataFreshness === "LIVE_CONFIRMED"` gets the
emphasised green + ring treatment; `LIVE_DELAYED`/`HISTORICAL_ONLY` → warning,
`AWAITING` → secondary, `status === "blocked"` → danger, UNKNOWN → muted.

**Non-obvious decision — do not "fix":** the `LIVE_GATE_BLOCKED` verdict (label
"Live read · execution gated") has `dataFreshness === "LIVE_CONFIRMED"`, so the
chip **intentionally keeps the green feed-quality tone** there.

**Why:** the chip is a READ-QUALITY / feed signal, not a decision/execution
signal. The feed genuinely IS live-confirmed; the execution gate is carried by
the label text itself, so nothing claims the trade is ready. This mirrors the
header's existing split (the Data pill shows green "Live" independently of the
Trading pill). Flipping it to warning would misreport feed quality.

**How to apply:** if a future change tries to downgrade the gated-live chip to
warning "for honesty", stop — the honesty lives in the label, and the tone
reflects feed quality. The deliberate behavior is pinned by a case in
`ScannerHeaderSummary.readiness.test.tsx`.
