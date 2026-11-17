import { NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const enabled = process.env.ENABLE_DEV_TEST_ACCOUNTS === 'true';

  return NextResponse.json(
    { enabled },
    { headers: { 'Cache-Control': 'no-store, max-age=0' } },
  );
}
