import { cookies } from 'next/headers';
import type { NextResponse } from 'next/server';
import { createHmac, randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import type { RowDataPacket } from 'mysql2/promise';
import { getPool } from '@/lib/mysql';

const scrypt = promisify(scryptCallback);
export const SESSION_COOKIE = 'sportrz_session';
const SESSION_LIFETIME_SECONDS = 60 * 60 * 24 * 30;
// Browsers commonly cap persistent cookies. Refresh this cookie whenever /api/auth/me
// is called, while the signed QA token itself has no server-side expiry.
const QA_SESSION_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 400;

export interface AppUser {
  uid: string;
  email: string;
  displayName: string;
  photoURL: string | null;
  emailVerified: boolean;
  isAdmin: boolean;
  accountRole: 'user' | 'super_admin' | 'subadmin' | 'affiliate';
  isAffiliate: boolean;
  avatar: string;
  hasReceivedWelcomeNotification: boolean;
  isTestAccount: boolean;
}

interface UserRow extends RowDataPacket {
  id: string;
  email: string;
  display_name: string | null;
  photo_url: string | null;
  email_verified_at: Date | string | null;
  status: 'active' | 'suspended';
  is_admin: number | boolean;
  account_role: 'user' | 'super_admin' | 'subadmin' | 'affiliate';
  avatar: string | null;
  has_received_welcome_notification: number | boolean;
  is_test_account: number | boolean;
}

function getSessionSecret(): string {
  const secret = process.env.AUTH_SECRET;
  if (secret) return secret;
  if (process.env.NODE_ENV === 'production') {
    throw new Error('AUTH_SECRET must be configured in production.');
  }
  return 'local-development-secret-change-before-deployment';
}

function signSessionPayload(payload: string): string {
  return createHmac('sha256', getSessionSecret()).update(payload).digest('base64url');
}

export function createSessionToken(userId: string, neverExpires = false): string {
  const expiryPart = neverExpires
    ? 'never'
    : String(Math.floor(Date.now() / 1000) + SESSION_LIFETIME_SECONDS);
  const payload = `${userId}.${expiryPart}`;
  return `${payload}.${signSessionPayload(payload)}`;
}

interface ParsedSessionToken {
  userId: string;
  neverExpires: boolean;
}

function readSessionToken(token: string | undefined): ParsedSessionToken | null {
  if (!token) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;

  const [userId, expiresRaw, signature] = parts;
  const neverExpires = expiresRaw === 'never';
  const expiresAt = Number(expiresRaw);
  if (!userId || (!neverExpires && (!Number.isFinite(expiresAt) || expiresAt <= Math.floor(Date.now() / 1000)))) return null;

  const payload = `${userId}.${expiresRaw}`;
  const expected = Buffer.from(signSessionPayload(payload));
  const actual = Buffer.from(signature);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;
  return { userId, neverExpires };
}

export function setSessionCookie(response: NextResponse, userId: string, options: { neverExpires?: boolean } = {}): void {
  const neverExpires = options.neverExpires === true;
  response.cookies.set(SESSION_COOKIE, createSessionToken(userId, neverExpires), {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    // QA accounts have no application-level token expiry. Their persistent cookie
    // is rolled forward by /api/auth/me so active testers do not hit a 30-day logout.
    maxAge: neverExpires ? QA_SESSION_COOKIE_MAX_AGE_SECONDS : SESSION_LIFETIME_SECONDS,
  });
}

export function clearSessionCookie(response: NextResponse): void {
  response.cookies.set(SESSION_COOKIE, '', {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: 0,
  });
}

export async function getCurrentUser(): Promise<AppUser | null> {
  const cookieStore = await cookies();
  const session = readSessionToken(cookieStore.get(SESSION_COOKIE)?.value);
  if (!session) return null;
  const { userId } = session;

  const [rows] = await getPool().execute<UserRow[]>(
    `SELECT id, email, display_name, photo_url, email_verified_at, status, is_admin, account_role,
            avatar, has_received_welcome_notification, is_test_account
       FROM users WHERE id = ? LIMIT 1`,
    [userId],
  );
  if (!rows.length || rows[0].status !== 'active') return null;

  const user = rows[0];
  const isTestAccount = Number(user.is_test_account) === 1;
  // A non-expiring token is only valid for an explicitly marked QA account.
  if (session.neverExpires && !isTestAccount) return null;
  // The single environment switch controls QA password login and existing QA sessions.
  // Disabling it immediately prevents marked test accounts from using the application.
  if (isTestAccount && process.env.ENABLE_DEV_TEST_ACCOUNTS !== 'true') return null;
  return {
    uid: user.id,
    email: user.email,
    displayName: user.display_name || user.email.split('@')[0],
    photoURL: user.photo_url,
    emailVerified: Boolean(user.email_verified_at),
    isAdmin: Boolean(user.is_admin),
    accountRole: user.account_role,
    isAffiliate: user.account_role === 'affiliate',
    avatar: user.avatar || 'avatar1',
    hasReceivedWelcomeNotification: Boolean(user.has_received_welcome_notification),
    isTestAccount,
  };
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString('hex');
  const derivedKey = (await scrypt(password, salt, 64)) as Buffer;
  return `scrypt$${salt}$${derivedKey.toString('hex')}`;
}

export async function verifyPassword(password: string, storedHash: string): Promise<boolean> {
  const [algorithm, salt, expectedHex] = storedHash.split('$');
  if (algorithm !== 'scrypt' || !salt || !expectedHex) return false;

  const expected = Buffer.from(expectedHex, 'hex');
  const actual = (await scrypt(password, salt, expected.length)) as Buffer;
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export function generateOneTimeToken(): string {
  return randomBytes(32).toString('base64url');
}

export function hashOneTimeToken(token: string): string {
  return createHmac('sha256', getSessionSecret()).update(token).digest('hex');
}
