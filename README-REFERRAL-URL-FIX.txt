SPORTRZ — REFERRAL / PUBLIC URL FIX

ROOT CAUSE
The referral route and affiliate link helper read NEXT_PUBLIC_APP_URL only.
In the deployed Next.js build this public variable had been compiled as
http://localhost:3000. Changing cPanel's environment variables after build
could not override that old compiled public value. The email helper also used
NEXT_PUBLIC_APP_URL only, which could produce local verification/reset links.

FILES IN THIS PATCH
- src/lib/app-origin.ts (new shared origin helper)
- src/lib/affiliate-links.ts (uses shared helper)
- src/app/r/[code]/route.ts (uses shared helper)
- src/lib/email.ts (uses shared helper for verify/reset links)
- .env.production.local (production build URL settings only; no secrets)

INSTALL LOCALLY
1. Extract this ZIP directly into the Sportrz project root, the folder with
   package.json (for example D:\next.js\sportrz).
2. Allow the four source files and .env.production.local to be replaced.
3. Keep your .env.local unchanged. Do not upload or share it.
4. Open PowerShell in the project root and run:
      npm run build
5. Only continue if the build succeeds.

WHAT THE FIX DOES
- Server runtime APP_URL is checked before NEXT_PUBLIC_APP_URL.
- Production accepts HTTPS only and falls back to https://sportrz.com.
- Local development continues to use NEXT_PUBLIC_APP_URL or the request origin,
  with http://localhost:3000 as the final fallback.
- Existing referral Click ID, cookie, fraud and commission logic is unchanged.
- OTP email verification and password-reset links use the canonical origin.

DEPLOY TO CPANEL
1. Back up the current /home/astrotri/sportrz_app/.next folder.
2. Stop the Node.js app in cPanel.
3. Upload the newly built local .next folder contents as a ZIP and extract it
   into /home/astrotri/sportrz_app so that .next/BUILD_ID exists at that level.
4. Do not replace cPanel's custom server.js, .htaccess, package.json, node_modules,
   or database files as part of this referral-only fix.
5. Confirm cPanel Node.js environment variables include:
      APP_URL=https://sportrz.com
      NEXT_PUBLIC_APP_URL=https://sportrz.com
6. Save and restart the Node.js application.
7. Test an active referral link. It must redirect to
   https://sportrz.com/login?ref=...&click_id=...
8. Keep the old .next backup until the live test succeeds.

NO DATABASE MIGRATION IS REQUIRED.
