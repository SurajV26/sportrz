SPORTRZ REFERRAL URL FIX

1. Extract this folder anywhere.
2. Open PowerShell in the Sportrz project root (the folder containing package.json).
3. Run:
   powershell -ExecutionPolicy Bypass -File .\fix-referral-origin.ps1

The script:
- Updates src/lib/affiliate-links.ts and src/app/r/[code]/route.ts to prefer the server-side APP_URL.
- Creates backups next to both source files.
- Creates/updates .env.production.local with APP_URL and NEXT_PUBLIC_APP_URL set to https://sportrz.com.
- Does not edit .env.local, database files, authentication, Click ID generation, or commission logic.

Then run:
   npm run build

Only if build succeeds, deploy the generated .next build to cPanel and restart the Node.js app.
Keep the existing .next folder as a backup until production referral testing succeeds.
