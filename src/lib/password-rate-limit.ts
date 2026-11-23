import type { NextRequest } from 'next/server';
import type { PoolConnection, RowDataPacket } from 'mysql2/promise';
const LIVE_TEST_MAX_ATTEMPTS = 5;
const LIVE_TEST_WINDOW_MINUTES = 15;
const LIVE_TEST_LOCK_MINUTES = 30;

export function getRequestIp(request: NextRequest): string {
  // Use the hosting platform's proxy-provided address. Do not accept an IP in the JSON body.
  const vercelIp = request.headers.get('x-vercel-forwarded-for');
  const realIp = request.headers.get('x-real-ip');
  const cloudflareIp = request.headers.get('cf-connecting-ip');
  const forwardedIp = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim();
  return String(vercelIp || realIp || cloudflareIp || forwardedIp || 'unknown').trim().slice(0, 100);
}

export async function preparePasswordRateLimit(connection: PoolConnection, networkHash: string, identifierHash: string) {
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
  const [rows] = await connection.execute<Array<RowDataPacket & { failed_attempts: number; is_blocked: number }>>(
    `SELECT failed_attempts, (blocked_until > UTC_TIMESTAMP()) AS is_blocked FROM live_test_login_attempts
      WHERE network_hash = ? AND identifier_hash = ? LIMIT 1 FOR UPDATE`,
    [networkHash, identifierHash],
  );
  const row = rows[0];
  if (!row) throw new Error('Could not initialize password login rate limit.');
  return { blocked: Boolean(row.is_blocked), attempts: Number(row.failed_attempts) || 0 };
}

export async function recordPasswordFailure(connection: PoolConnection, networkHash: string, identifierHash: string) {
  await connection.execute(
    `UPDATE live_test_login_attempts
        SET blocked_until = CASE WHEN failed_attempts + 1 >= ${LIVE_TEST_MAX_ATTEMPTS}
              THEN DATE_ADD(UTC_TIMESTAMP(), INTERVAL ${LIVE_TEST_LOCK_MINUTES} MINUTE)
              ELSE blocked_until END,
            failed_attempts = failed_attempts + 1
      WHERE network_hash = ? AND identifier_hash = ?`,
    [networkHash, identifierHash],
  );
}

