// Which Deriv API generation this deployment is configured for.
//
// Deliberately placed OUTSIDE newApi/ and importing nothing: both the legacy
// client and the new transport need this answer, and the new tree must never
// import the legacy client (Ruling 15a). A neutral module lets both read the
// same detector instead of keeping two copies that can drift — the copy in
// certify.ts hardcoded "new" and made its own mode check unfireable.

export type DerivApiMode = "new" | "legacy" | "none";

/**
 * Detect the configured generation from env.
 *
 * An explicit DERIV_API_MODE wins over inference — including when it is
 * wrong. Auto-detection reads the App ID shape: Deriv's new generation issues
 * alphanumeric App IDs paired with a PAT, the legacy one numeric App IDs.
 */
export function detectDerivApiMode(): DerivApiMode {
  const mode = (process.env["DERIV_API_MODE"] ?? "auto").trim().toLowerCase();
  const appId = (process.env["DERIV_APP_ID"] ?? "").trim();
  const token = (process.env["DERIV_API_TOKEN"] ?? "").trim();
  if (mode === "legacy") return "legacy";
  if (mode === "new") return "new";
  if (appId && token && /[a-zA-Z]/.test(appId)) return "new";
  if (appId && /^\d+$/.test(appId)) return "legacy";
  return "none";
}
