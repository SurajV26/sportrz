import { createHmac, randomBytes } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import type { PoolConnection, RowDataPacket } from 'mysql2/promise';
import { getPool } from '@/lib/mysql';
import { setSessionCookie, verifyPassword } from '@/lib/session';

export const runtime = 'nodejs';

interface LoginRow extends RowDataPacket {
  id: string;
  email: string;
  display_name: string | null;
  password_hash: string | null;
  email_verified_at: Date | string | null;
  status: 'active' | 'suspended';
  is_test_account: number | boolean;
}

const REFERRAL_CODE_PATTERN = /^[A-Z0-9-]{3,32}$/;
const CLICK_ID_PATTERN = /^[A-Za-z0-9._~-]{1,191}$/;
const TEST_EMAIL_SUFFIX = '@sportrz.test';
const LIVE_TEST_MAX_ATTEMPTS = 5;
const LIVE_TEST_WINDOW_MINUTES = 15;
const LIVE_TEST_LOCK_MINUTES = 30;

function normalizeTestUsername(username: string): string | null {
  if (!/^[a-z0-9_-]{3,32}$/.test(username)) return null;
  return `${username}${TEST_EMAIL_SUFFIX}`;
}

function hashRateLimitValue(value: string): string {
  const secret = process.env.AUTH_SECRET;
  if (!secret || secret.length < 32) throw new Error('AUTH_SECRET must be configured before live QA password login can be used.');
  return createHmac('sha256', secret).update(value).digest('hex');
}

function getRequestIp(request: NextRequest): string {
  // Use the hosting platform's proxy-provided address. Do not accept an IP in the JSON body.
  const vercelIp = request.headers.get('x-vercel-forwarded-for');
  const realIp = request.headers.get('x-real-ip');
  const cloudflareIp = request.headers.get('cf-connecting-ip');
  const forwardedIp = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim();
  return String(vercelIp || realIp || cloudflareIp || forwardedIp || 'unknown').trim().slice(0, 100);
}

async function prepareLiveQaRateLimit(connection: PoolConnection, networkHash: string, identifierHash: string) {
  await connection.execute(
    `INSERT INTO live_test_login_attempts
       (network_hash, identifier_hash, failed_attempts, window_started_at, blocked_until)
     VALUES (?, ?, 0, UTC_TIMESTAMP(), NULL)
     ON DUPLICATE KEY UPDATE
       failed_attempts = IF(window_started_at < DATE_SUB(UTC_TIMESTAMP(), INTERVAL ${LIVE_TEST_WINDOW_MINUTES} MINUTE), 0, failed_attempts),
       window_started_at = IF(window_started_at < DATE_SUB(UTC_TIMESTAMP(), INTERVAL ${LIVE_TEST_WINDOW_MINUTES} MINUTE), UTC_TIMESTAMP(), window_started_at),
       blocked_until = IF(blocked_until IS NOT NULL AND blocked_until <= UTC_TIMESTAMP(), NULL, blocked_until)`,
    [networkHash, identifierHash],
  );
  const [rows] = await connection.execute<Array<RowDataPacket & { failed_attempts: number; blocked_until: Date | string | null }>>(
    `SELECT failed_attempts, blocked_until FROM live_test_login_attempts
      WHERE network_hash = ? AND identifier_hash = ? LIMIT 1 FOR UPDATE`,
    [networkHash, identifierHash],
  );
  const row = rows[0];
  if (!row) throw new Error('Could not initialize QA login rate limit.');
  const blockedUntil = row.blocked_until ? new Date(row.blocked_until).getTime() : 0;
  return { blocked: blockedUntil > Date.now(), attempts: Number(row.failed_attempts) || 0 };
}

async function recordLiveQaFailure(connection: PoolConnection, networkHash: string, identifierHash: string) {
  await connection.execute(
    `UPDATE live_test_login_attempts
        SET failed_attempts = failed_attempts + 1,
            blocked_until = CASE WHEN failed_attempts + 1 >= ${LIVE_TEST_MAX_ATTEMPTS}
              THEN DATE_ADD(UTC_TIMESTAMP(), INTERVAL ${LIVE_TEST_LOCK_MINUTES} MINUTE)
              ELSE blocked_until END
      WHERE network_hash = ? AND identifier_hash = ?`,
    [networkHash, identifierHash],
  );
}

export async function POST(request: NextRequest) {
  const testAccountsEnabled = process.env.ENABLE_DEV_TEST_ACCOUNTS === 'true';
  if (!testAccountsEnabled) {
    return NextResponse.json({ error: 'Test-account sign-in is disabled. Set ENABLE_DEV_TEST_ACCOUNTS=true to enable it.' }, { status: 404 });
  }
  const isDevelopment = process.env.NODE_ENV === 'development';

  let connection: PoolConnection | null = null;
  let transactionOpen = false;
  let networkHash = '';
  let identifierHash = '';
  // Keep database-backed brute-force protection on every deployed environment.
  const useLiveRateLimit = !isDevelopment;

  try {
    const body = await request.json();
    const rawEmail = String(body.email || '').trim().toLowerCase();
    const username = String(body.username || '').trim().toLowerCase();
    const email = rawEmail || normalizeTestUsername(username) || '';
    const password = String(body.password || '');

    if (!email || !password || email.length > 191 || (username && !rawEmail && !normalizeTestUsername(username))) {
      return NextResponse.json({ error: 'Enter a valid test username and password.' }, { status: 400 });
    }
    if (!email.endsWith(TEST_EMAIL_SUFFIX)) {
      return NextResponse.json({ error: 'Password login is available only for designated QA accounts.' }, { status: 404 });
    }

    const pool = getPool();
    connection = await pool.getConnection();
    await connection.beginTransaction();
    transactionOpen = true;

    if (useLiveRateLimit) {
      networkHash = hashRateLimitValue(getRequestIp(request));
      identifierHash = hashRateLimitValue(email);
      const rate = await prepareLiveQaRateLimit(connection, networkHash, identifierHash);
      if (rate.blocked || rate.attempts >= LIVE_TEST_MAX_ATTEMPTS) {
        await connection.rollback();
        transactionOpen = false;
        return NextResponse.json(
          { error: `Too many failed QA sign-in attempts. Try again in ${LIVE_TEST_LOCK_MINUTES} minutes.` },
          { status: 429, headers: { 'Retry-After': String(LIVE_TEST_LOCK_MINUTES * 60) } },
        );
      }
    }

    const [rows] = await connection.execute<LoginRow[]>(
      `SELECT id, email, display_name, password_hash, email_verified_at, status, is_test_account
         FROM users WHERE email = ? LIMIT 1 FOR UPDATE`,
      [email],
    );
    const user = rows[0];

    // In a deployed environment, password login is strictly restricted to rows
    // explicitly seeded as QA identities. Normal customer OTP remains unchanged.
    const validQaIdentity = Boolean(user && Number(user.is_test_account) === 1);
    const validPassword = Boolean(user?.password_hash && await verifyPassword(password, user.password_hash));
    if (!user || !validQaIdentity || user.status !== 'active' || !validPassword) {
      if (useLiveRateLimit) {
        await recordLiveQaFailure(connection, networkHash, identifierHash);
        await connection.commit();
        transactionOpen = false;
      } else {
        await connection.rollback();
        transactionOpen = false;
      }
      return NextResponse.json({ error: 'Invalid QA username or password.' }, { status: 401 });
    }
    if (!user.email_verified_at) {
      await connection.rollback();
      transactionOpen = false;
      return NextResponse.json({ error: 'This QA account is not verified. Run the QA seed script again.' }, { status: 403 });
    }

    // First-touch referral attribution remains protected: this path never overwrites
    // a referral already attached to the customer.
    let referralCode = String(body.referralCode || request.cookies.get('sportrz_affiliate_code')?.value || '').trim().toUpperCase();
    let clickId = String(body.clickId || request.cookies.get('sportrz_affiliate_click')?.value || '').trim();
    if (!REFERRAL_CODE_PATTERN.test(referralCode)) referralCode = '';
    if (!CLICK_ID_PATTERN.test(clickId)) clickId = '';

    if (referralCode) {
      const [existingReferral] = await connection.execute<Array<RowDataPacket & { affiliate_user_id: string }>>(
        'SELECT affiliate_user_id FROM affiliate_referrals WHERE referred_user_id = ? LIMIT 1',
        [user.id],
      );
      if (!existingReferral.length) {
        const [affiliateRows] = await connection.execute<Array<RowDataPacket & { user_id: string }>>(
          `SELECT ap.user_id FROM affiliate_profiles ap
             JOIN users au ON au.id = ap.user_id
            WHERE ap.referral_code = ? AND ap.status = 'active'
              AND au.account_role = 'affiliate' AND au.status = 'active'
            LIMIT 1`,
          [referralCode],
        );
        const affiliateUserId = affiliateRows[0]?.user_id;
        if (affiliateUserId && affiliateUserId !== user.id) {
          if (!clickId) clickId = `clk_${randomBytes(18).toString('hex')}`;
          const [clickRows] = await connection.execute<Array<RowDataPacket & { id: number; referred_user_id: string | null }>>(
            `SELECT id, referred_user_id FROM affiliate_clicks
              WHERE affiliate_user_id = ? AND referral_code = ? AND click_id = ?
              LIMIT 1 FOR UPDATE`,
            [affiliateUserId, referralCode, clickId],
          );
          let clickRecordId: number | null = clickRows[0] ? Number(clickRows[0].id) : null;
          if (clickRows[0]?.referred_user_id && clickRows[0].referred_user_id !== user.id) {
            clickRecordId = null;
          } else if (clickRecordId) {
            await connection.execute(
              'UPDATE affiliate_clicks SET referred_user_id = COALESCE(referred_user_id, ?) WHERE id = ? AND (referred_user_id IS NULL OR referred_user_id = ?)',
              [user.id, clickRecordId, user.id],
            );
          } else {
            const [inserted] = await connection.execute<any>(
              `INSERT INTO affiliate_clicks
                 (affiliate_user_id, referral_code, click_id, click_source, landing_path, referred_user_id, is_billable, risk_reason, created_at)
               VALUES (?, ?, ?, 'sportrz', '/login', ?, 0, 'existing_account_attribution', UTC_TIMESTAMP())`,
              [affiliateUserId, referralCode, clickId, user.id],
            );
            clickRecordId = Number(inserted.insertId);
          }
          if (clickRecordId) {
            await connection.execute(
              `INSERT IGNORE INTO affiliate_referrals
                 (affiliate_user_id, referred_user_id, referral_code, click_id, source, status, created_at)
               VALUES (?, ?, ?, ?, 'link', 'qualified', UTC_TIMESTAMP())`,
              [affiliateUserId, user.id, referralCode, clickId],
            );
            await connection.execute(
              'UPDATE affiliate_clicks SET referred_user_id = COALESCE(referred_user_id, ?) WHERE id = ? AND affiliate_user_id = ?',
              [user.id, clickRecordId, affiliateUserId],
            );
          }
        }
      }
    }

    await connection.execute('UPDATE users SET last_login_at = UTC_TIMESTAMP(), updated_at = UTC_TIMESTAMP() WHERE id = ?', [user.id]);
    if (useLiveRateLimit) {
      await connection.execute('DELETE FROM live_test_login_attempts WHERE network_hash = ? AND identifier_hash = ?', [networkHash, identifierHash]);
    }
    await connection.commit();
    transactionOpen = false;
    connection.release();
    connection = null;

    const response = NextResponse.json({
      success: true,
      message: 'Signed in successfully.',
      user: { uid: user.id, email: user.email, displayName: user.display_name || user.email.split('@')[0] },
    });
    setSessionCookie(response, user.id, { neverExpires: Number(user.is_test_account) === 1 });
    response.cookies.set('sportrz_affiliate_code', '', { path: '/', maxAge: 0, httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production' });
    response.cookies.set('sportrz_affiliate_click', '', { path: '/', maxAge: 0, httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production' });
    return response;
  } catch (error) {
    if (connection && transactionOpen) {
      try { await connection.rollback(); } catch { /* Preserve original error. */ }
    }
    console.error('QA password login failed:', error);
    return NextResponse.json({ error: 'QA sign-in failed. Check the database migration and server configuration.' }, { status: 500 });
  } finally {
    connection?.release();
  }
}
