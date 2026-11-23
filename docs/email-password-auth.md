# Email, password and OTP authentication

- `POST /api/auth/email-options` takes `{ email }`, returns `{ exists, hasPassword }`. It never sends email or creates an account.
- `POST /api/auth/password` takes `{ email, password, action: "register" | "login", referralCode?, clickId? }`. Registration accepts 6–12 characters (no character composition requirement), stores a scrypt hash in `users.password_hash`, leaves email unverified and immediately sets the normal session cookie. Login verifies the saved hash. Existing accounts can never be overwritten through registration. Existing OTP-only users must use OTP.
- Both password actions respect account suspension, the QA-account switch, and registration settings. New accounts preserve referral attribution. Password failures are limited to five per email/network in 15 minutes with a 30 minute block, using the existing `live_test_login_attempts` table from the admin migration. OTP remains available during a password block.
- Password success returns `{ success: true, isNewUser, message }`. Errors: 400 invalid input, 401 incorrect credentials, 403 inactive account/registration disabled, 409 registration conflict, 429 password attempt limit, 500 server failure. No password or hash is returned.
- `POST /api/auth/send-otp` and `/api/auth/verify-otp` retain their existing contracts. Only selecting OTP sends a code. Valid OTP logs in an existing user or registers a new user and verifies their email; it never changes a saved password.

UI: email → method choice → create password / enter password / send OTP → session and redirect. Forgot password leads to OTP. OTP-only accounts see an explanation and an OTP option. Changing email clears password, code and account lookup state.

Verification: `npm run test:auth` runs isolated route and UI interaction tests with real scrypt hashing and an in-memory database substitute. It does not send emails or write live users. `npm run typecheck` checks TypeScript. For an isolated production build in PowerShell: `$env:SPORTRZ_BUILD_DIR='build/auth-validation'; npm run build`.

No new columns are required. The existing admin migration (`npm run db:migrate:admin`) must already have installed `is_test_account` and `live_test_login_attempts`, as required by the existing QA login implementation. No migration is run automatically by login requests.
