# Simulator-Data Leak Audit — non-admin-reachable routes

**Scope of the audit:** every non-admin-reachable API route was classified for
whether it can return **simulator-derived live-market analysis** (fabricated
opportunity scores, confidence, entry/SL/TP, HOT_SETUP badges, etc.) to a
non-admin viewer as if it were real market analysis.

**The masked leak class:** a route is an in-scope leak **only** when it
generates, server-side, an opportunity/analysis row that is **tagged
`dataSource: "SIMULATOR"`** and returns it raw to a non-admin. The mask is
applied with `viewerSeesSimulatorDetail(readRoleFromRequest(req))` — ADMIN/OWNER
keep the raw simulator detail (operator diagnostics); every other viewer gets the
honest waiting state.

**Out of scope, by design (over-reach is forbidden):**
- A user's **own paper-trade history / journals / playbooks** — these are real
  records of the user's own activity, not fabricated market analysis. Masking
  them would lie about the user's real history.
- **Live data** of any kind.
- Routes that only **echo client-supplied values** the client already holds.
- Routes that surface synthetic data **honestly labeled** with a flag
  (`syntheticData: true`) rather than passing it off as live.

The masking helpers and `viewerSeesSimulatorDetail` live in
`artifacts/api-server/src/lib/honesty/feedTruthCopy.ts`.

---

## A. In-scope leaks — masked (the fix)

These are the only routes that generate `dataSource: "SIMULATOR"` market analysis
reachable by a non-admin. Each now projects per-viewer.

| Route | File | Mask applied |
| --- | --- | --- |
| `POST /api/ai/market-analysis` | `routes/aiBrain.ts` | `maskSimulatorMarketAnalysis` |
| `POST /api/ai/generate-trade-card` | `routes/aiBrain.ts` | `maskSimulatorTradeCard` |
| `POST /api/ai/entry-sniper-score` | `routes/aiBrain.ts` | `maskSimulatorEntrySniperScore` |
| `POST /api/ai/grade-trade` | `routes/aiBrain.ts` | `maskSimulatorTradeGrade` |
| `POST /api/ai/opportunity-score` | `routes/scanner.ts` | `maskSimulatorOpportunityScore` |
| `POST /api/ai/setup-analysis` | `routes/scanner.ts` | analysis + opportunity + card maskers |
| `POST /api/ai/session-plan`, `GET /api/ai/session-plan` | `routes/scanner.ts` | `maskSimulatorSessionPlan` |

## B. Pre-existing per-viewer projection (already honest before this task)

| Route | File | Mechanism |
| --- | --- | --- |
| `POST /api/market-scanner/scan` | `routes/scanner.ts` | `projectOpportunitiesForViewer(readRoleFromRequest(req))` |
| `GET /api/market-scanner/opportunities` | `routes/scanner.ts` | `projectOpportunitiesForViewer(readRoleFromRequest(req))` |

---

## C. Classified NOT-A-LEAK (with reasoning showing completeness)

### ADMIN-ONLY (sim values gated behind `requireAdmin`)
| Route | File | Reason |
| --- | --- | --- |
| `GET /api/market/quotes` | `routes/marketDataLayer.ts` | `requireAdmin`; non-admins never reach it. |
| `GET /api/news-risk/events` (scored) | `routes/marketDataLayer.ts` | `requireAdmin`. |
| `POST /api/market-scanner/start`, `/stop` | `routes/scanner.ts` | `requireAdmin`; non-admin = 403 (proven in Part B). |
| Scanner alert mutate (`/alerts/acknowledge`, `/dismiss`, `/snooze`) | `routes/scanner.ts` | `requireAdmin`; not opportunity surfaces. |

### LIVE-ONLY / HONEST-EMPTY (never emit a `SIMULATOR`-tagged row)
| Route | File | Reason |
| --- | --- | --- |
| `GET /api/opportunities/top`, `/opportunities`, `POST /api/opportunities/scan`, `/watchlist/intelligence` | `lib/opportunityRadar/radar.ts` | Scoring path is **live-only** (`scanSymbolTimeframe` via the router). Insufficient data ⇒ `opportunityScore: 0`, `dataQuality: "UNAVAILABLE"`. `dataSource` is `"ROUTER"`/provider, **never `"SIMULATOR"`**. |
| `GET /api/me/market-context`, market-data reads | `routes/meMarketContext.ts`, `routes/meMarketData.ts` | Live router data + honest empty state; no simulator analysis. |

### ECHO-OF-CLIENT-INPUT (no new server-generated simulator analysis)
| Route | File | Reason |
| --- | --- | --- |
| `POST /api/me/assistant/explain-signal` | `routes/meAssistant.ts` | Only **echoes the client-supplied scores** (confidence/risk/entry/SL/TP) back inside prose. The client got those from a scanner row that is **already masked upstream** (Part B). Masking the echo would be redundant; the route generates no new simulator market analysis. |

### HONESTLY-LABELED SYNTHETIC (flagged, not passed off as live)
| Route | File | Reason |
| --- | --- | --- |
| `POST /api/trade-decision/evaluate`, `/demo`, `/logs`, `/latest` | `routes/tradeDecision.ts` | Surfaces a first-class `syntheticData` boolean; `/demo` is an explicit "Try it" synthetic demo. The honesty signal is the label, not a hidden score masquerading as live. |

### USER'S-OWN-PAPER-HISTORY (masking would be over-reach — forbidden)
| Route | File | Reason |
| --- | --- | --- |
| `routes/edgeDiscovery.ts`, `routes/aiMentor.ts`, `routes/analytics.ts`, `routes/paperIntelligence.ts`, `routes/mePlaybooks.ts`, `routes/tradingPlaybooks.ts`, `routes/meTradeDecisions.ts` | — | Return the **user's own** paper-trade records / journals / playbooks, per-user scoped. These are real records of the user's own activity, not fabricated market analysis. Masking them is explicitly out of scope. |

### NON-OPPORTUNITY RAW DATA (covered by the market-data honesty layer, not this task)
| Route | File | Reason |
| --- | --- | --- |
| `GET /api/market/quote-envelope/:symbol`, `/market/candles-envelope`, `POST /api/risk/evaluate` | `routes/marketDataLayer.ts` | Return raw quotes/candles or pure risk math on caller inputs — **not** scored opportunity rows. Market-data honesty (router empty-or-real + the chart-truth CI guards) governs these; they are outside this task's opportunity-leak scope. |

---

## Completeness statement

Every route that **generates** simulator-derived market analysis reachable by a
non-admin is in section **A** (masked) or **B** (already projected). Section **C**
enumerates the remaining candidate/swept surfaces with the reason each is not an
in-scope leak. No other non-admin-reachable route emits a `dataSource:
"SIMULATOR"` opportunity/analysis row.

## Tests locking this audit

- `artifacts/api-server/src/routes/__qa__/scannerManualScanAccess.test.ts` —
  non-admin `/scan` masks the simulator row; OWNER sees it raw; `/start`,`/stop`
  = 403 (role via dev header).
- `artifacts/api-server/src/routes/__qa__/scannerGenuineSessionAccess.test.ts` —
  the same masking + `/start`,`/stop` 403, proven with a **genuine signed
  `hr_session` cookie** (no dev header), the production role path.
- `artifacts/api-server/src/lib/honesty/__qa__/*` — hermetic unit proofs of every
  masker (`dataSource: "SIMULATOR"` rows zeroed; live/non-sim rows untouched).
- `artifacts/trading-dashboard/src/pages/market-scanner.empty-state.test.tsx` —
  NEVER-SCANNED vs SCANNED-EMPTY render distinction (Part A).
