'use strict';

// LOCAL DEVELOPMENT ONLY. Creates four reusable, email-verified test users.
// It deliberately refuses production and non-local database hosts.
const path = require('node:path');
const dotenv = require('dotenv');
const mysql = require('mysql2/promise');
const { randomBytes, randomUUID, scrypt: scryptCallback } = require('node:crypto');
const { promisify } = require('node:util');

const scrypt = promisify(scryptCallback);
const root = process.cwd();
dotenv.config({ path: path.join(root, '.env.local') });
dotenv.config({ path: path.join(root, '.env') });

const DEFAULT_ACCOUNTS = [
  {
    username: 'superadmin', email: 'superadmin@sportrz.test', displayName: 'Sportrz Test Super Admin',
    password: 'Sportrz@SuperAdmin2026', role: 'super_admin', isAdmin: 1,
  },
  {
    username: 'subadmin', email: 'subadmin@sportrz.test', displayName: 'Sportrz Test Sub Admin',
    password: 'Sportrz@SubAdmin2026', role: 'subadmin', isAdmin: 1,
  },
  {
    username: 'testuser', email: 'testuser@sportrz.test', displayName: 'Sportrz Test User',
    password: 'Sportrz@TestUser2026', role: 'user', isAdmin: 0,
  },
  {
    username: 'affiliate', email: 'affiliate@sportrz.test', displayName: 'Sportrz Test Affiliate',
    password: 'Sportrz@Affiliate2026', role: 'affiliate', isAdmin: 1,
  },
];

const SUBADMIN_PERMISSIONS = [
  'dashboard.view',
  'users.view',
  'subscriptions.view',
  'payments.view',
  'affiliates.view',
  'messages.view',
  'feedback.view',
];

function resolveDbConfig() {
  if (process.env.DATABASE_URL) {
    const parsed = new URL(process.env.DATABASE_URL);
    return {
      host: parsed.hostname,
      port: Number(parsed.port || 3306),
      user: decodeURIComponent(parsed.username),
      password: decodeURIComponent(parsed.password),
      database: decodeURIComponent(parsed.pathname.replace(/^\//, '')),
    };
  }
  return {
    host: process.env.MYSQL_HOST || '127.0.0.1',
    port: Number(process.env.MYSQL_PORT || 3306),
    user: process.env.MYSQL_USER,
    password: process.env.MYSQL_PASSWORD || '',
    database: process.env.MYSQL_DATABASE,
  };
}

function ensureSafeLocalTarget(config) {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('Test accounts are disabled when NODE_ENV=production.');
  }
  if (process.env.ENABLE_DEV_TEST_ACCOUNTS !== 'true') {
    throw new Error('For safety, add ENABLE_DEV_TEST_ACCOUNTS=true to your local .env.local, then run this script again.');
  }
  const host = String(config.host || '').toLowerCase();
  const isLocalHost = ['localhost', '127.0.0.1', '::1'].includes(host);
  if (!isLocalHost) throw new Error(`Refusing to seed test accounts into non-local database host: ${host || 'unknown'}.`);
  if (!config.database || !config.database.toLowerCase().includes('sportrz')) {
    throw new Error('Refusing to seed test accounts: database name must contain "sportrz".');
  }
  if (!config.user) throw new Error('MYSQL_USER is missing in .env.local.');
}

async function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  const derivedKey = await scrypt(password, salt, 64);
  return `scrypt$${salt}$${Buffer.from(derivedKey).toString('hex')}`;
}

async function ensureUser(connection, account) {
  const passwordHash = await hashPassword(account.password);
  const [existing] = await connection.execute(
    'SELECT id FROM users WHERE email = ? LIMIT 1 FOR UPDATE',
    [account.email],
  );
  let userId = existing[0]?.id;

  if (userId) {
    await connection.execute(
      `UPDATE users
          SET password_hash = ?, display_name = ?, is_admin = ?, account_role = ?, is_test_account = 1, status = 'active',
              email_verified_at = COALESCE(email_verified_at, UTC_TIMESTAMP()), updated_at = UTC_TIMESTAMP()
        WHERE id = ?`,
      [passwordHash, account.displayName, account.isAdmin, account.role, userId],
    );
  } else {
    userId = randomUUID();
    await connection.execute(
      `INSERT INTO users
         (id, email, password_hash, display_name, avatar, is_admin, account_role, is_test_account, status, email_verified_at)
       VALUES (?, ?, ?, ?, 'avatar1', ?, ?, 1, 'active', UTC_TIMESTAMP())`,
      [userId, account.email, passwordHash, account.displayName, account.isAdmin, account.role],
    );
  }
  return userId;
}

async function verifySchema(connection) {
  const required = [
    ['users', 'account_role'],
    ['users', 'password_hash'],
    ['users', 'email_verified_at'],
    ['users', 'is_test_account'],
    ['admin_user_permissions', null],
    ['affiliate_profiles', 'commission_model'],
    ['affiliate_profiles', 'click_reward_paise'],
    ['affiliate_profiles', 'affiliate_type'],
    ['affiliate_profiles', 'website_url'],
    ['affiliate_profiles', 'referral_code'],
    ['affiliate_profiles', 'status'],
    ['affiliate_clicks', 'click_id'],
    ['affiliate_clicks', 'is_billable'],
    ['affiliate_clicks', 'network_key'],
    ['affiliate_clicks', 'risk_reason'],
    ['affiliate_commissions', 'click_record_id'],
    ['affiliate_commissions', 'commission_model'],
    ['affiliate_commissions', 'commission_paise'],
  ];
  for (const [table, column] of required) {
    const [tables] = await connection.execute(
      'SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? LIMIT 1',
      [table],
    );
    if (!tables.length) throw new Error(`Missing table ${table}. Run npm run db:migrate:admin first.`);
    if (column) {
      const [columns] = await connection.execute(
        'SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ? LIMIT 1',
        [table, column],
      );
      if (!columns.length) throw new Error(`Missing column ${table}.${column}. Run npm run db:migrate:admin first.`);
    }
  }
}

async function main() {
  const config = resolveDbConfig();
  ensureSafeLocalTarget(config);
  const connection = await mysql.createConnection({ ...config, connectTimeout: 10000, charset: 'utf8mb4' });
  try {
    const [[dbInfo]] = await connection.query('SELECT DATABASE() AS database_name, VERSION() AS mysql_version');
    console.log(`Local test-account setup target: ${dbInfo.database_name} (${dbInfo.mysql_version})`);
    await verifySchema(connection);
    await connection.beginTransaction();

    const ids = {};
    for (const account of DEFAULT_ACCOUNTS) ids[account.role] = await ensureUser(connection, account);

    // A deliberately limited sub-admin role, so permission boundaries can be tested.
    await connection.execute('DELETE FROM admin_user_permissions WHERE user_id = ?', [ids.subadmin]);
    for (const permission of SUBADMIN_PERMISSIONS) {
      await connection.execute(
        'INSERT INTO admin_user_permissions (user_id, permission_key, granted_by_user_id) VALUES (?, ?, ?)',
        [ids.subadmin, permission, ids.super_admin],
      );
    }

    const affiliateCode = 'SP-TEST-AFFILIATE';
    const [codeOwners] = await connection.execute(
      'SELECT user_id FROM affiliate_profiles WHERE referral_code = ? LIMIT 1 FOR UPDATE',
      [affiliateCode],
    );
    if (codeOwners[0] && codeOwners[0].user_id !== ids.affiliate) {
      throw new Error(`The fixed test referral code ${affiliateCode} is already assigned to another account. Resolve that local test-data conflict before seeding.`);
    }
    await connection.execute(
      `INSERT INTO affiliate_profiles
         (user_id, referral_code, commission_percent, payout_email, status, affiliate_type,
          website_url, commission_model, click_reward_paise)
       VALUES (?, ?, 10.00, ?, 'active', 'external_website', 'https://sportrz.com', 'pay_per_click', 200)
       ON DUPLICATE KEY UPDATE
         referral_code = VALUES(referral_code), commission_percent = VALUES(commission_percent),
         payout_email = VALUES(payout_email), status = 'active',
         affiliate_type = VALUES(affiliate_type), website_url = VALUES(website_url),
         commission_model = 'pay_per_click', click_reward_paise = 200,
         updated_at = UTC_TIMESTAMP()`,
      [ids.affiliate, affiliateCode, 'affiliate@sportrz.test'],
    );

    await connection.commit();

    console.log('\nCreated/updated four local test accounts. All are email-verified and password login does not request OTP.');
    console.log('QA sessions have no fixed application expiry while ENABLE_DEV_TEST_ACCOUNTS=true; the persistent cookie rolls forward on session checks. Use Sign out to switch roles.\n');
    for (const account of DEFAULT_ACCOUNTS) {
      console.log(`${account.role.toUpperCase()} | username: ${account.username} | password: ${account.password} | email: ${account.email}`);
    }
    console.log(`\nAffiliate referral code: ${affiliateCode}`);
    console.log('Affiliate earning model: Pay per valid click (CPC) | reward: ₹2.00 per billable click');
    console.log('Sub-admin permissions:', SUBADMIN_PERMISSIONS.join(', '));
    console.log('\nIMPORTANT: These credentials are for local testing only. Never enable this script or use these passwords in production.');
  } catch (error) {
    try { await connection.rollback(); } catch { /* ignore rollback failure */ }
    throw error;
  } finally {
    await connection.end();
  }
}

main().catch((error) => {
  console.error('\nTest-account seed failed:', error.message || error);
  process.exitCode = 1;
});
