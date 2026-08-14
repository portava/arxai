// ── ARX Handshake System — clean user-facing copy (pure) ────────────────────
//
// Maps a handshake (type + rich readiness status) to a clean, generic message
// and optional next-step recommendations that are SAFE to surface to a regular
// user. Deterministic and IO-free.
//
// INVIOLABLE:
// - NO internal wording: no SCREAMING_SNAKE gate/env codes, route paths, layer
//   keys, provider names, or operator reasons. Operators read `adminDetails`.
//   Every string here is asserted clean by `findInternalLeaks` in tests.
// - Advisory tone only. "BLOCKED" copy is a soft "not ready yet" hint — it never
//   claims authority over execution. The 16-gate live pipeline is the authority.
// - Honest: WAITING_FOR_DATA / ERROR never imply data exists when it does not.

import type { HandshakeReadinessStatus, HandshakeType } from "./handshake.types";

export interface HandshakeCopy {
  // Clean message safe to show a regular user.
  userFacingMessage: string;
  // Clean, user-safe next-step suggestions (may be empty).
  recommendations: string[];
}

// Which family of copy a handshake type uses. Keeps wording on-surface without
// leaking the underlying layer/service names.
type CopyFamily = "investor" | "execution" | "chart" | "data";

function copyFamily(type: HandshakeType): CopyFamily {
  switch (type) {
    case "INVESTOR_VALUE":
    case "WEEKLY_REPORT":
      return "investor";
    case "TRADE_PREVIEW":
    case "RUBY_EXECUTION":
      return "execution";
    case "SMART_CHART_OVERLAY":
    case "SIGNAL_INTELLIGENCE":
    case "SCANNER_EXPLANATION":
    case "NEWS_RADAR":
    case "NEWS":
      return "chart";
    default:
      return "data";
  }
}

/**
 * Build the clean user-facing copy for a handshake result. Pure + deterministic.
 * The output is guaranteed free of internal wording (verified by tests).
 */
export function buildHandshakeCopy(
  type: HandshakeType,
  status: HandshakeReadinessStatus,
): HandshakeCopy {
  const family = copyFamily(type);

  switch (status) {
    case "READY":
      if (family === "investor") {
        return { userFacingMessage: "Portfolio Status: Fresh.", recommendations: [] };
      }
      if (family === "execution") {
        return { userFacingMessage: "Ready to trade.", recommendations: [] };
      }
      if (family === "chart") {
        return { userFacingMessage: "Live and up to date.", recommendations: [] };
      }
      return { userFacingMessage: "All systems are ready.", recommendations: [] };

    case "READY_WITH_WARNINGS":
      return {
        userFacingMessage: "Ready, with reduced confidence — some extra inputs are limited right now.",
        recommendations: ["You can proceed, but double-check before you commit."],
      };

    case "WAITING_FOR_DATA":
      if (family === "execution") {
        return {
          userFacingMessage: "Waiting for fresh price…",
          recommendations: ["Hold for a fresh quote before placing this trade."],
        };
      }
      if (family === "investor") {
        return {
          userFacingMessage: "Updating your portfolio figures…",
          recommendations: ["Please check back in a moment."],
        };
      }
      return {
        userFacingMessage: "Waiting for fresh data…",
        recommendations: ["Please try again shortly."],
      };

    case "STALE":
      if (family === "execution") {
        return {
          userFacingMessage: "Late — do not chase.",
          recommendations: ["Wait for the next confirmed setup instead of chasing a stale price."],
        };
      }
      if (family === "investor") {
        return {
          userFacingMessage: "Figures may be a little behind — refreshing.",
          recommendations: ["Give it a moment to catch up."],
        };
      }
      return {
        userFacingMessage: "This view is a little behind — catching up.",
        recommendations: ["Wait for the next refresh before acting on it."],
      };

    case "DEGRADED":
      return {
        userFacingMessage: "Running with reduced confidence — some inputs are limited right now.",
        recommendations: ["Proceed with extra caution."],
      };

    case "BLOCKED":
      if (family === "execution") {
        return {
          userFacingMessage: "Live bridge is not ready — trading is paused for now.",
          recommendations: ["Wait until the connection is back before trying again."],
        };
      }
      if (family === "investor") {
        return {
          userFacingMessage: "Your portfolio figures aren't ready yet.",
          recommendations: ["Please check back shortly."],
        };
      }
      return {
        userFacingMessage: "Some required data isn't ready yet. Please try again shortly.",
        recommendations: ["Try again in a few moments."],
      };

    case "ERROR":
    default:
      return {
        userFacingMessage: "Status is unavailable right now.",
        recommendations: ["Please try again shortly."],
      };
  }
}
