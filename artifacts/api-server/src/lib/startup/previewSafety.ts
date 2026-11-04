// Local preview can serve authentication while schema-dependent background work
// remains paused. Production deliberately ignores this development-only switch.
export function isPreviewSafeStart(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.NODE_ENV === "development" && env.ARX_PREVIEW_SAFE_START === "true";
}
