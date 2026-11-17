'use strict';

// Explicitly gated QA account seeder for a deployed Sportrz QA/staging environment.
// It never resets tables and refuses to take over any existing non-test user.
const path = require('node:path');
const dotenv = require('dotenv');
const mysql = require('mysql2/promise');
const { randomBytes, randomUUID, scrypt: scryptCallback } = require('node:crypto');
const { promisify } = require('node:util');
const scrypt = promisify(scryptCallback);
const root = process.cwd();

const explicitEnvFile = process.env.SPORTRZ_ENV_FILE;
if (explicitEnvFile) {
  dotenv.config({ path: path.resolve(root, explicitEnvFile), override: true });
} else {
  dotenv.config({ path: path.join(root, '.env.local') });
  dotenv.config({ path: path.join(root, '.env') });
}

const SUBADMIN_PERMISSIONS = [
  'dashboard.view', 'users.view', 'subscriptions.view', 'payments.view',
  'affiliates.view', 'messages.view', 'feedback.view',
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
    host: process.env.MYSQL_HOST,
    port: Number(process.env.MYSQL_PORT || 3306),
    user: process.env.MYSQL_USER,
    password: process.env.MYSQL_PASSWORD || '',
    database: process.env.MYSQL_DATABASE,
  };
}

function validateLiveSetup(config) {
  if (process.env.ENABLE_DEV_TEST_ACCOUNTS !== 'true') {
    throw new Error('Set ENABLE_DEV_TEST_ACCOUNTS=true in the private QA env file before seeding QA accounts.');
  }
  if (process.env.LIVE_TEST_SEED_CONFIRM !== config.database) {
    throw new Error(`For safety, set LIVE_TEST_SEED_CONFIRM to the exact database name: ${config.database || '(missing)'}`);
  }
  if (!config.host || !config.user || !config.database) {
    throw new Error('Database connection is incomplete. Set DATABASE_URL or MYSQL_HOST, MYSQL_USER, MYSQL_DATABASE and MYSQL_PASSWORD.');
  }
  if (['localhost', '127.0.0.1', '::1'].includes(String(config.host).toLowerCase())) {
    throw new Error('This is the LIVE seeder and refuses a local database. Use your deployed QA/staging MySQL host.');
  }
  if (!String(config.database).toLowerCase().includes('sportrz')) {
    throw new Error('Refusing to seed: database name must contain "sportrz".');
  }
}

function buildAccounts() {
  const items = [
    ['superadmin', 'superadmin@sportrz.test', 'Sportrz QA Super Admin', 'super_admin', 1, 'LIVE_TEST_SUPERADMIN_PASSWORD'],
    ['subadmin', 'subadmin@sportrz.test', 'Sportrz QA Sub Admin', 'subadmin', 1, 'LIVE_TEST_SUBADMIN_PASSWORD'],
    ['testuser', 'testuser@sportrz.test', 'Sportrz QA User', 'user', 0, 'LIVE_TEST_USER_PASSWORD'],
    ['affiliate', 'affiliate@sportrz.test', 'Sportrz QA Affiliate', 'affiliate', 1, 'LIVE_TEST_AFFILIATE_PASSWORD'],
  ];
  const accounts = items.map(([username, email, displayName, role, isAdmin, envName]) => {
    const password = process.env[envName] || '';
    if (password && password.length < 24) throw new Error(`${envName} must be at least 24 characters. Set a unique, random value; do not reuse a production password.`);
    return { username, email, displayName, role, isAdmin, password, generatedPassword: null };
  });
  const suppliedPasswords = accounts.map((item) => item.password).filter(Boolean);
  if (new Set(suppliedPasswords).size !== suppliedPasswords.length) {
    throw new Error('Each supplied QA account password must be different.');
  }
  return accounts;
}

async function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  const derivedKey = await scrypt(password, salt, 64);
  return `scrypt$${salt}$${Buffer.from(derivedKey).toString('hex')}`;
}

async function requireColumn(connection, table, column) {
  const [rows] = await connection.execute(
    'SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ? LIMIT 1',
    [table, column],
  );
  if (!rows.length) throw new Error(`Missing ${table}.${column}. Run npm run db:migrate:admin first.`);
}

async function upsertQaUser(connection, account) {
  const [rows] = await connection.execute(
    'SELECT id, is_test_account, password_hash FROM users WHERE email = ? LIMIT 1 FOR UPDATE',
    [account.email],
  );
  let id = rows[0]?.id;
  if (id && Number(rows[0].is_test_account) !== 1) {
    throw new Error(`Refusing to overwrite ${account.email}: that email belongs to a non-test user.`);
  }

  let password = account.password;
  if (!password && !id) {
    password = randomBytes(32).toString('base64url');
    account.generatedPassword = password;
  }
  const passwordHash = password ? await hashPassword(password) : null;

  if (id) {
    if (passwordHash) {
      await connection.execute(
        `UPDATE users SET password_hash = ?, display_name = ?, is_admin = ?, account_role = ?,
           is_test_account = 1, status = 'active', email_verified_at = COALESCE(email_verified_at, UTC_TIMESTAMP()),
           updated_at = UTC_TIMESTAMP() WHERE id = ?`,
        [passwordHash, account.displayName, account.isAdmin, account.role, id],
      );
    } else {
      await connection.execute(
        `UPDATE users SET display_name = ?, is_admin = ?, account_role = ?, is_test_account = 1,
           status = 'active', email_verified_at = COALESCE(email_verified_at, UTC_TIMESTAMP()),
           updated_at = UTC_TIMESTAMP() WHERE id = ?`,
        [account.displayName, account.isAdmin, account.role, id],
      );
    }
  } else {
    id = randomUUID();
    await connection.execute(
      `INSERT INTO users (id, email, password_hash, display_name, avatar, is_admin, account_role,
         is_test_account, status, email_verified_at)
       VALUES (?, ?, ?, ?, 'avatar1', ?, ?, 1, 'active', UTC_TIMESTAMP())`,
      [id, account.email, passwordHash, account.displayName, account.isAdmin, account.role],
    );
  }
  return id;
}

async function main() {
  const db = resolveDbConfig();
  validateLiveSetup(db);
  const accounts = buildAccounts();
  const connection = await mysql.createConnection({
    ...db,
    connectTimeout: 15000,
    charset: 'utf8mb4',
    multipleStatements: false,
    ...(process.env.MYSQL_SSL === 'true' ? { ssl: { rejectUnauthorized: true } } : {}),
  });

  try {
    const [[info]] = await connection.query('SELECT DATABASE() AS database_name, VERSION() AS mysql_version');
    console.log(`\nLIVE QA seeding target: ${info.database_name} (${info.mysql_version})`);
    console.log('Only the four @sportrz.test accounts below may be created/updated. No other user or table will be deleted.');
    await requireColumn(connection, 'users', 'account_role');
    await requireColumn(connection, 'users', 'password_hash');
    await requireColumn(connection, 'users', 'email_verified_at');
    await requireColumn(connection, 'users', 'is_test_account');
    await requireColumn(connection, 'affiliate_profiles', 'commission_model');
    await requireColumn(connection, 'affiliate_profiles', 'click_reward_paise');

    await connection.beginTransaction();
    try {
      const ids = {};
      for (const account of accounts) ids[account.role] = await upsertQaUser(connection, account);

      await connection.execute('DELETE FROM admin_user_permissions WHERE user_id = ?', [ids.subadmin]);
      for (const permission of SUBADMIN_PERMISSIONS) {
        await connection.execute(
          'INSERT INTO admin_user_permissions (user_id, permission_key, granted_by_user_id) VALUES (?, ?, ?)',
          [ids.subadmin, permission, ids.super_admin],
        );
      }

      const referralCode = 'SP-LIVE-TEST-AFFILIATE';
      const [owners] = await connection.execute(
        'SELECT user_id FROM affiliate_profiles WHERE referral_code = ? LIMIT 1 FOR UPDATE',
        [referralCode],
      );
      if (owners[0] && owners[0].user_id !== ids.affiliate) {
        throw new Error(`Referral code ${referralCode} already belongs to another user. Resolve that conflict before seeding.`);
      }
      await connection.execute(
        `INSERT INTO affiliate_profiles
          (user_id, referral_code, commission_percent, payout_email, status, affiliate_type,
           website_url, commission_model, click_reward_paise)
         VALUES (?, ?, 10.00, ?, 'active', 'external_website', ?, 'pay_per_click', 200)
         ON DUPLICATE KEY UPDATE referral_code = VALUES(referral_code), commission_percent = 10.00,
           payout_email = VALUES(payout_email), status = 'active', affiliate_type = 'external_website',
           website_url = VALUES(website_url), commission_model = 'pay_per_click', click_reward_paise = 200,
           updated_at = UTC_TIMESTAMP()`,
        [ids.affiliate, referralCode, 'affiliate@sportrz.test', process.env.LIVE_TEST_AFFILIATE_WEBSITE || 'https://sportrz.com'],
      );

      await connection.commit();
      console.log('\nLIVE QA accounts created/updated successfully:');
      for (const account of accounts) {
        console.log(`${account.role.toUpperCase()} | username: ${account.username} | email: ${account.email}`);
        if (account.generatedPassword) console.log(`  ONE-TIME PASSWORD (save it now): ${account.generatedPassword}`);
        else if (account.password) console.log('  Password: updated from configured environment value.');
        else console.log('  Password: existing hash retained; not changed.');
      }
      console.log(`Affiliate referral code: ${referralCode}`);
      console.log('Affiliate model: CPC | ₹2.00 per valid click');
      console.log('\nNewly generated passwords are printed exactly once above. Save them now; rerunning this script without password env values preserves existing hashes.');
      console.log('Normal customer email OTP registration/login remains unchanged.');
    } catch (error) {
      await connection.rollback();
      throw error;
    }
  } finally {
    await connection.end();
  }
}

main().catch((error) => {
  console.error('\nLIVE QA seed failed:', error.message || error);
  process.exitCode = 1;
});
