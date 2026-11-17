# Local development test accounts

These fixed accounts are intended for a local developer database. The same `ENABLE_DEV_TEST_ACCOUNTS` switch is used on local and deployed QA environments. For deployed setup, use `docs/LIVE-QA-ACCOUNTS.md`.

## One-time setup

1. Make sure `.env.local` points to your local MySQL database (`localhost`, `127.0.0.1`, or `::1`).
2. Add this explicit opt-in to `.env.local`:

   ```env
   ENABLE_DEV_TEST_ACCOUNTS=true
   ```

3. Apply additive migrations and seed the four local accounts:

   ```powershell
   npm run db:setup:test-accounts
   ```

The seed command refuses production and remote database hosts. It is idempotent and never deletes tables.

## Fixed local credentials

| Role | Username | Password | Email |
|---|---|---|---|
| Super Admin | `superadmin` | `Sportrz@SuperAdmin2026` | `superadmin@sportrz.test` |
| Sub Admin | `subadmin` | `Sportrz@SubAdmin2026` | `subadmin@sportrz.test` |
| Test User | `testuser` | `Sportrz@TestUser2026` | `testuser@sportrz.test` |
| Affiliate | `affiliate` | `Sportrz@Affiliate2026` | `affiliate@sportrz.test` |

On `/login` in local development, select **Sign in with a fixed QA account**, choose a role, enter its password, and sign in without OTP. QA test-account sessions have no fixed application-level expiry. Their HttpOnly cookie is renewed when `/api/auth/me` checks the session (400-day rolling browser-cookie lifetime). Sign out, clear cookies, set `ENABLE_DEV_TEST_ACCOUNTS=false`, change `AUTH_SECRET`, or browser cookie policies can end the session. Normal customer OTP sessions remain 30 days.

The seeded affiliate is an active external affiliate with CPC enabled at ₹2.00 per billable click. Its referral code is `SP-TEST-AFFILIATE`. The sub-admin has limited read-only permissions for dashboard, users, subscriptions, payments, affiliates, messages, and feedback. The normal user has no admin access.

These known local credentials must never be reused in a deployed environment.
