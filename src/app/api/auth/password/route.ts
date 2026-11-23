import { randomUUID } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import type { PoolConnection, RowDataPacket } from 'mysql2/promise';
import { getPool } from '@/lib/mysql';
import { hashOneTimeToken, hashPassword, setSessionCookie, verifyPassword } from '@/lib/session';
import { attachSignupReferral } from '@/lib/signup-referral';
import { getRequestIp, preparePasswordRateLimit, recordPasswordFailure } from '@/lib/password-rate-limit';

export const runtime = 'nodejs';

interface PasswordUser extends RowDataPacket {
  id: string;
  password_hash: string | null;
  status: string;
  is_test_account: number;
}

export async function POST(request: NextRequest) {
  let connection: PoolConnection | null = null;
  let transactionOpen = false;
  try {
    const body = await request.json();
    const email = String(body.email || '').trim().toLowerCase();
    const password = typeof body.password === 'string' ? body.password : '';
    const registering = body.action === 'register';
    if (email.length > 191 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
        !['register', 'login'].includes(body.action) || !password || password.length > 128 ||
        (registering && (Array.from(password).length < 6 || Array.from(password).length > 12))) {
      return NextResponse.json({ error: registering ? 'Enter a valid email and a password of 6–12 characters.' : 'Enter a valid email and password.' }, { status: 400 });
    }
    const networkHash = hashOneTimeToken(`customer-password-network:${getRequestIp(request)}`);
    const identifierHash = hashOneTimeToken(`customer-password-email:${email}`);
    connection = await getPool().getConnection();
    await connection.beginTransaction();
    transactionOpen = true;
    const rate = await preparePasswordRateLimit(connection, networkHash, identifierHash);
    if (rate.blocked || rate.attempts >= 5) {
      // Commit the window refresh so a completed block can expire.
      await connection.commit();
      transactionOpen = false;
      return NextResponse.json({ error: 'Too many password attempts. Use email OTP or try again in 30 minutes.' }, { status: 429, headers: { 'Retry-After': '1800' } });
    }
    const [rows] = await connection.execute<PasswordUser[]>(
      'SELECT id, password_hash, status, is_test_account FROM users WHERE email = ? LIMIT 1 FOR UPDATE', [email],
    );
    const user = rows[0];
    if (user && (user.status !== 'active' || (Number(user.is_test_account) === 1 && process.env.ENABLE_DEV_TEST_ACCOUNTS !== 'true'))) {
      return NextResponse.json({ error: 'This account is not active. Please contact support.' }, { status: 403 });
    }
    let userId: string;
    if (registering) {
      if (user) {
        return NextResponse.json({ error: 'This email already has an account. Use your password or email OTP.' }, { status: 409 });
      }
      const [settings] = await connection.execute<RowDataPacket[]>("SELECT setting_value FROM site_settings WHERE setting_key = 'registration_enabled' LIMIT 1");
      if (settings[0]?.setting_value === 'false') {
        return NextResponse.json({ error: 'New registrations are temporarily disabled.' }, { status: 403 });
      }
      userId = randomUUID();
      const name = email.split('@')[0].replace(/[._+-]+/g, ' ').trim().slice(0, 191) || 'Sportrz User';
      await connection.execute(
        `INSERT INTO users (id, email, password_hash, display_name, status, last_login_at)
         VALUES (?, ?, ?, ?, 'active', UTC_TIMESTAMP())`, [userId, email, await hashPassword(password), name],
      );
      let ref = String(body.referralCode || request.cookies.get('sportrz_affiliate_code')?.value || '').trim().toUpperCase();
      let click = String(body.clickId || request.cookies.get('sportrz_affiliate_click')?.value || '').trim();
      if (!/^[A-Z0-9-]{3,32}$/.test(ref)) ref = '';
      if (!/^[A-Za-z0-9._~-]{1,191}$/.test(click)) click = '';
      await attachSignupReferral(connection, userId, ref, click);
    } else {
      if (!user?.password_hash || !await verifyPassword(password, user.password_hash)) {
        await recordPasswordFailure(connection, networkHash, identifierHash);
        await connection.commit();
        transactionOpen = false;
        return NextResponse.json({ error: 'Incorrect email or password. You can also log in with email OTP.' }, { status: 401 });
      }
      userId = user.id;
      await connection.execute('UPDATE users SET last_login_at = UTC_TIMESTAMP(), updated_at = UTC_TIMESTAMP() WHERE id = ?', [userId]);
    }
    await connection.execute('DELETE FROM live_test_login_attempts WHERE network_hash = ? AND identifier_hash = ?', [networkHash, identifierHash]);
    await connection.commit();
    transactionOpen = false;
    const response = NextResponse.json({ success: true, isNewUser: registering, message: registering ? 'Account created. You are now signed in.' : 'You are now signed in.' });
    setSessionCookie(response, userId);
    for (const cookie of ['sportrz_affiliate_code', 'sportrz_affiliate_click']) {
      response.cookies.set(cookie, '', { path: '/', maxAge: 0, httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production' });
    }
    return response;
  } catch (error) {
    if ((error as { code?: string }).code === 'ER_DUP_ENTRY') {
      return NextResponse.json({ error: 'This email already has an account. Use your password or email OTP.' }, { status: 409 });
    }
    console.error('Customer password sign-in failed:', error);
    return NextResponse.json({ error: 'Unable to sign in right now. Please try again.' }, { status: 500 });
  } finally {
    try {
      if (connection && transactionOpen) await connection.rollback();
    } finally {
      connection?.release();
    }
  }
}
