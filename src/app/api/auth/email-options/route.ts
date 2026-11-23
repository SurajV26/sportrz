import { NextRequest, NextResponse } from 'next/server';
import type { RowDataPacket } from 'mysql2/promise';
import { getPool } from '@/lib/mysql';

export const runtime = 'nodejs';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const email = String(body.email || '').trim().toLowerCase();
    if (email.length > 191 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return NextResponse.json({ error: 'Enter a valid email address.' }, { status: 400 });
    }
    const [rows] = await getPool().execute<Array<RowDataPacket & { has_password: number }>>(
      'SELECT (password_hash IS NOT NULL AND password_hash != \'\') AS has_password FROM users WHERE email = ? LIMIT 1', [email],
    );
    return NextResponse.json({ exists: rows.length > 0, hasPassword: Boolean(rows[0]?.has_password) }, {
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch {
    return NextResponse.json({ error: 'Unable to check your email. Please try again.' }, { status: 500 });
  }
}
