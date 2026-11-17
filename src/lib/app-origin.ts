/**
 * Resolve Sportrz's canonical public origin.
 *
 * APP_URL is intentionally checked before NEXT_PUBLIC_APP_URL because APP_URL
 * is a server-only runtime variable. That lets cPanel override an older build
 * whose NEXT_PUBLIC_APP_URL was compiled with a local value.
 */
const PRODUCTION_ORIGIN = 'https://sportrz.com';
const LOCAL_ORIGIN = 'http://localhost:3000';

function parseOrigin(value: string | undefined, production: boolean): string | null {
  const candidate = value?.trim();
  if (!candidate) return null;

  try {
    const parsed = new URL(candidate);
    if (!['https:', 'http:'].includes(parsed.protocol)) return null;
    if (parsed.username || parsed.password) return null;
    if (production && parsed.protocol !== 'https:') return null;
    return parsed.origin;
  } catch {
    return null;
  }
}

/**
 * In production, always return an HTTPS origin and never trust the incoming
 * Host header as the canonical site URL. In local development, the request
 * origin is a useful fallback for alternate dev ports.
 */
export function getAppOrigin(requestOrigin?: string): string {
  const production = process.env.NODE_ENV === 'production';

  const configured =
    parseOrigin(process.env.APP_URL, production) ??
    parseOrigin(process.env.NEXT_PUBLIC_APP_URL, production);

  if (configured) return configured;
  if (production) return PRODUCTION_ORIGIN;

  return parseOrigin(requestOrigin, false) ?? LOCAL_ORIGIN;
}
