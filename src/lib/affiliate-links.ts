/** Canonical URL helpers for affiliate links. */
import { getAppOrigin } from '@/lib/app-origin';

/**
 * Build all public affiliate URLs from the server-side application origin.
 * APP_URL is preferred at runtime so a stale public build-time variable cannot
 * make a production link point back to localhost.
 */
export function getPublicAppOrigin(): string {
  return getAppOrigin();
}

export function buildAffiliateReferralUrl(referralCode: string): string {
  return `${getPublicAppOrigin()}/r/${encodeURIComponent(referralCode)}`;
}
