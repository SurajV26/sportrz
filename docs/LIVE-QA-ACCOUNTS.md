# Live QA accounts (deployed testing)

This mode is for a private deployed QA/staging environment. It creates four persistent test identities in the configured Sportrz MySQL database and enables username/password login only for rows explicitly marked `users.is_test_account = 1`. Normal customer registration and email OTP login continue unchanged.

## Security first

- Preferred setup: deploy a separate QA hostname (for example `qa.sportrz.com` or a Vercel Preview deployment) against a separate QA database cloned from schema only or populated with synthetic data.
- Do not point a QA Super Admin account at a production database containing real customer/payment data unless you intentionally accept that this account can access and change live administrative data.
- The four passwords are generated randomly once if not supplied. The seed script prints newly generated passwords once; save them privately. They are not embedded in browser code or source files.
- The live QA login endpoint is protected by a database-backed lockout: five failed attempts for the same network/username pair cause a 30-minute lock. `AUTH_SECRET` must be a stable random secret (32+ characters).
- Set `ENABLE_DEV_TEST_ACCOUNTS=true` only on the deployed QA target. Set it to `false` or remove it on the public production deployment.
- Only the four `@sportrz.test` identities are eligible for password login. Real customer accounts continue to use email OTP.
- Never commit `.env.live-test`; it contains database credentials.

## 1. Prepare a private env file locally

Copy `.env.live-test.example` to `.env.live-test` and fill in the remote QA/staging MySQL credentials. Keep the exact database name and confirmation identical. Do not use a production database unless you have intentionally accepted the access risk.

## 2. Apply additive migrations and seed accounts

In PowerShell from the project root:

```powershell
$env:SPORTRZ_ENV_FILE = '.env.live-test'
npm run db:setup:live-test-accounts
```

The seed command refuses localhost, requires `ENABLE_DEV_TEST_ACCOUNTS=true`, requires `LIVE_TEST_SEED_CONFIRM` to exactly match the database name, and requires a database name containing `sportrz`. It creates/updates only these identities:

| Username | Email | Role |
|---|---|---|
| `superadmin` | `superadmin@sportrz.test` | Super Admin |
| `subadmin` | `subadmin@sportrz.test` | Restricted Sub Admin |
| `testuser` | `testuser@sportrz.test` | User |
| `affiliate` | `affiliate@sportrz.test` | External Affiliate (CPC, ₹2.00 per valid click) |

If the accounts do not exist, secure random passwords are generated and printed once. Save them immediately. If the accounts already exist and no password env vars are set, their existing password hashes are preserved. To rotate an account password, set the corresponding `LIVE_TEST_*_PASSWORD` value to a unique password of at least 24 characters and rerun the seeder.

The seed script refuses to overwrite a real user if one of the fixed `@sportrz.test` email addresses already exists without `is_test_account = 1`. It does not delete any existing customer, order, payment, game, plan, or affiliate data.

## 3. Enable the QA login UI on the deployed QA site

In the deployed app's server environment (for Vercel, Project → Settings → Environment Variables), set:

```env
ENABLE_DEV_TEST_ACCOUNTS=true
AUTH_SECRET=<same stable 32+ character session secret used by the app>
```

Redeploy after changing environment variables. The `/login` page will then show **Sign in with a fixed QA account**. Select one of the four usernames and enter the generated password. No OTP is used for these four seeded QA identities.

To disable QA password sign-in and block existing QA sessions, set `ENABLE_DEV_TEST_ACCOUNTS=false` and redeploy. Setting it back to `true` allows the still-valid QA cookie to work again if it has not been cleared. The normal customer email OTP flow is unaffected.

## 4. Fixed account behaviour

- Accounts are persistent in MySQL; deployments do not recreate or reset them.
- QA password sessions use a signed token with no fixed application-level expiry. The HttpOnly persistent cookie is renewed whenever `/api/auth/me` checks an active QA session. The browser cookie is stored with a long rolling lifetime (400 days); clearing browser data, signing out, disabling `ENABLE_DEV_TEST_ACCOUNTS`, changing `AUTH_SECRET`, or browser cookie policies can still end the session. Normal customer OTP sessions continue to use the standard 30-day lifetime.
- Sub Admin gets limited read-only permissions configured by the seed script.
- Affiliate account is active and uses CPC at ₹2.00 per billable click by default. Admin can change its earning model/rate in the affiliate management screen.
- `is_test_account` is an explicit marker used by the password-login route; a normal customer with a password hash is still not eligible for QA password login.
