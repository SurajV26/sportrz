import { timingSafeEqual } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import type { RowDataPacket } from 'mysql2/promise';
import { getPool } from '@/lib/mysql';
import { getCurrentUser, hashOneTimeToken, hashPassword, verifyPassword } from '@/lib/session';
import { preparePasswordRateLimit, recordPasswordFailure } from '@/lib/password-rate-limit';

export async function POST(request: NextRequest) {
  try {
    const user = await getCurrentUser();
    if (!user) return NextResponse.json({ error: 'Sign in to change your password.' }, { status: 401 });
    const { method, currentPassword, otp, password, confirmPassword } = await request.json();
    if (typeof password !== 'string' || Array.from(password).length < 6 || Array.from(password).length > 12 || password !== confirmPassword) {
      return NextResponse.json({ error: 'Enter matching new passwords of 6–12 characters.' }, { status: 400 });
    }
    if (method === 'otp' ? typeof otp !== 'string' || !/^\d{6}$/.test(otp)
      : method !== 'password' || typeof currentPassword !== 'string' || !currentPassword || currentPassword.length > 128) {
      return NextResponse.json({ error: 'Enter your current password or a valid email code.' }, { status: 400 });
    }
    const connection = await getPool().getConnection();
    try {
      await connection.beginTransaction();
      if (method === 'otp') {
        const [rows] = await connection.execute<RowDataPacket[]>(
          `SELECT id, token_hash, attempts FROM auth_tokens
           WHERE user_id = ? AND email = ? AND purpose = 'password_reset'
             AND used_at IS NULL AND expires_at > UTC_TIMESTAMP()
           ORDER BY id DESC LIMIT 1 FOR UPDATE`, [user.uid, user.email],
        );
        const token = rows[0];
        if (!token || token.attempts >= 5) return NextResponse.json({ error: 'Request a new reset code.' }, { status: 400 });
        const expected = hashOneTimeToken(`profile-reset:${token.id}:${user.email}:${otp}`);
        if (!timingSafeEqual(Buffer.from(token.token_hash, 'hex'), Buffer.from(expected, 'hex'))) {
          await connection.execute('UPDATE auth_tokens SET attempts = attempts + 1 WHERE id = ?', [token.id]);
          await connection.commit();
          return NextResponse.json({ error: 'Incorrect email code.' }, { status: 400 });
        }
        await connection.execute('UPDATE auth_tokens SET used_at = UTC_TIMESTAMP() WHERE id = ?', [token.id]);
      } else {
        const scope = hashOneTimeToken('profile-password-change');
        const account = hashOneTimeToken(user.uid);
        const rate = await preparePasswordRateLimit(connection, scope, account);
        if (rate.blocked || rate.attempts >= 5) {
          await connection.commit();
          return NextResponse.json({ error: 'Too many attempts. Use email OTP or try again later.' }, { status: 429 });
        }
        const [rows] = await connection.execute<RowDataPacket[]>(
          "SELECT password_hash FROM users WHERE id = ? AND status = 'active' FOR UPDATE", [user.uid],
        );
        if (!rows[0]?.password_hash || !await verifyPassword(currentPassword, rows[0].password_hash)) {
          await recordPasswordFailure(connection, scope, account);
          await connection.commit();
          return NextResponse.json({ error: 'Current password is incorrect. You can use email OTP instead.' }, { status: 400 });
        }
        await connection.execute('DELETE FROM live_test_login_attempts WHERE network_hash = ? AND identifier_hash = ?', [scope, account]);
      }
      const [result] = await connection.execute<import('mysql2/promise').ResultSetHeader>(
        `UPDATE users SET password_hash = ?, updated_at = UTC_TIMESTAMP()
         WHERE id = ? AND email = ? AND status = 'active'`, [await hashPassword(password), user.uid, user.email],
      );
      if (!result.affectedRows) return NextResponse.json({ error: 'Account is no longer active.' }, { status: 403 });
      await connection.commit();
      return NextResponse.json({ message: 'Password updated.' });
    } finally {
      try { await connection.rollback(); } finally { connection.release(); }
    }
  } catch {
    return NextResponse.json({ error: 'Unable to update your password. Please try again.' }, { status: 500 });
  }
}
