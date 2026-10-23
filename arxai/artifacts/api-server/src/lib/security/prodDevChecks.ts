// ═══════════════════════════════════════════════════════════════════════════
// Phase 7 — prod/dev separation + supply-chain hygiene service.
//
// Gathers REAL environment signals and composes the PURE domain
// `evaluateProdDevSeparation` / `evaluateSupplyChainHygiene` engines. A signal
// that cannot be verified is left `undefined` so the engine reports it as an
// honest UNKNOWN (`unverified`) rather than silently treating it as safe.
//
// SAFETY: in production a confirmed dangerous-dev signal is a CRITICAL blocking
// finding; in dev it is a non-blocking WARN. We never break a healthy
// production path on a false positive — only verified signals produce findings.
// ═══════════════════════════════════════════════════════════════════════════

import {
  evaluateProdDevSeparation,
  evaluateSupplyChainHygiene,
  type ProdDevSignals,
  type ProdDevVerdict,
  type SupplyChainSignals,
  type SupplyChainVerdict,
} from "@workspace/domain/security";

function isProductionEnv(): boolean {
  return String(process.env.NODE_ENV ?? "").toLowerCase() === "production";
}

/**
 * Build the prod/dev signals from environment evidence. Only signals we can
 * actually observe here are set; everything else stays undefined (honest
 * unknown). The email-fallback signal is observable: real delivery requires a
 * verified Resend sender, so an unset EMAIL_FROM in production is a dev
 * fallback signal.
 */
export function buildProdDevSignals(): ProdDevSignals {
  const isProduction = isProductionEnv();
  const signals: ProdDevSignals = { isProduction };

  // Observable: when in production with no explicit sender configured, the
  // email layer can only log (dev fallback). In dev this is expected.
  if (isProduction) {
    signals.devEmailFallbackActive = !process.env.EMAIL_FROM;
  }

  // The remaining signals (mock market data in live mode, demo bridge on a live
  // route, fake execution in a live route, debug panels, test endpoints) are
  // architecturally prevented elsewhere and not observable as a single env
  // flag here — left undefined (honest unknown) rather than asserted safe.
  return signals;
}

export function getProdDevPosture(): ProdDevVerdict {
  return evaluateProdDevSeparation(buildProdDevSignals());
}

/**
 * Supply-chain signals are not statically verifiable from the running process,
 * so all are left undefined (honest unknown) until a real scanner feeds them.
 * This keeps the posture honest rather than advertising a clean bill of health
 * we cannot prove.
 */
export function buildSupplyChainSignals(): SupplyChainSignals {
  return {};
}

export function getSupplyChainPosture(): SupplyChainVerdict {
  return evaluateSupplyChainHygiene(buildSupplyChainSignals());
}
