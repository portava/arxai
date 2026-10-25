/** Trusted configuration only. Never use Host/X-Forwarded-Host to build a
 * password-reset link. Production must never fall back to a development URL. */
export function resolvePublicOrigin(env: NodeJS.ProcessEnv = process.env): string {
  const production = env.NODE_ENV === "production";
  const configured = env.APP_PUBLIC_ORIGIN?.trim() || env.APP_BASE_URL?.trim();
  const published = env.REPLIT_DOMAINS?.split(",")[0]?.trim();
  const dev = env.REPLIT_DEV_DOMAIN?.trim();
  const raw = configured || (published ? `https://${published}` : "")
    || (!production && dev ? `https://${dev}` : "") || (!production ? "http://localhost" : "");
  try {
    const url = new URL(raw);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash
      || url.pathname !== '/') throw new Error();
    if (production && (url.protocol !== 'https:' || ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
      || url.hostname.endsWith('.localhost') || url.hostname.endsWith('.replit.dev'))) throw new Error();
    return url.origin;
  } catch {
    // Do not put the invalid config in error text; it could contain credentials.
    throw new Error("PUBLIC_ORIGIN_NOT_CONFIGURED");
  }
}
