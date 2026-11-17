import { NextResponse } from 'next/server';
import { getCurrentUser, setSessionCookie } from '@/lib/session';

export const runtime = 'nodejs';

export async function GET() {
  try {
    const user = await getCurrentUser();
    const response = NextResponse.json({ user });
    if (user?.isTestAccount && process.env.ENABLE_DEV_TEST_ACCOUNTS === 'true') {
      // Roll the persistent QA cookie forward on activity; the signed QA token itself
      // has no fixed 30-day expiry. Normal customer sessions keep the 30-day lifetime.
      setSessionCookie(response, user.uid, { neverExpires: true });
    }
    response.headers.set('Cache-Control', 'no-store, max-age=0');
    return response;
  } catch (error) {
    console.error('Unable to load session:', error);
    return NextResponse.json({ error: 'Unable to check the current session.' }, { status: 500 });
  }
}
