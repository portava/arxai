/**
 * mapRubyState — pure helper that translates the booleans/flags an existing
 * Ruby surface already has into a single RubyState for <RubyAvatar/>.
 *
 * This keeps the visual component dumb: each call site passes the flags it
 * already tracks (chat loading, voice recording, TTS speaking, read loading,
 * risk/alert, bridge availability) and gets back the right animation state.
 * No new state is invented — when nothing is active it falls through to "idle".
 *
 * Priority order matters: disconnected and risk/alert outrank routine activity
 * so a warning is never hidden by a "thinking" animation.
 */
import type { RubyState } from "./RubyAvatar";

export interface RubyStateInputs {
  disconnected?: boolean;   // bridge/data/Ruby unavailable
  riskWarning?: boolean;    // an actual risk/critical condition
  alert?: boolean;          // an important (non-risk) alert
  listening?: boolean;      // voice recording active
  speaking?: boolean;       // text-to-speech active
  thinking?: boolean;       // chat/response generating
  analyzing?: boolean;      // chart/scanner/market read loading
  success?: boolean;        // positive/clear result (transient)
}

export function mapRubyState(i: RubyStateInputs): RubyState {
  if (i.disconnected) return "disconnected";
  if (i.riskWarning) return "riskWarning";
  if (i.alert) return "alert";
  if (i.listening) return "listening";
  if (i.speaking) return "speaking";
  if (i.analyzing) return "analyzingMarket";
  if (i.thinking) return "thinking";
  if (i.success) return "success";
  return "idle";
}
