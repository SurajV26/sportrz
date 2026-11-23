# Sportrz Affiliate Commission Models

This project supports two administrator-controlled earning models. An affiliate cannot select or change their own model or rate. A Super Admin (or a staff account with the `affiliates.manage` permission) chooses the model when creating an affiliate, approving an application, or editing an existing affiliate profile.

## 1. Plan purchase (revenue share)

- Rate: a percentage of an eligible plan payment.
- A commission is created only after the payment is verified as `captured` by the Razorpay settlement/verification flow.
- Clicks and sign-ups are analytics only; they do not earn money in this model.
- Example: a customer pays ₹1,000 for a plan and the admin rate is 10%. The commission is ₹100.
- The commission row stores the payment record, order ID, payment ID, paid amount, percentage, commission amount and status.
- For external website affiliates, an administrator-configured S2S destination can receive a signed `conversion` postback.

## 2. Pay per valid click (CPC)

- Rate: a fixed rupee amount per valid click, not a percentage of clicks.
- The `/r/:referralCode` route creates a first-party Click ID and records the visit before redirecting the visitor to login.
- A click is billable at most once per affiliate, per browser visitor, per UTC calendar day. Repeat visits from that browser to the same affiliate on that day remain analytics-only.
- Known crawler, link-preview and monitoring user agents are recorded as non-billable.
- A click reward is created immediately for an eligible billable click; a customer registration or plan purchase is not required.
- Example: the admin sets ₹1.50 per valid click. 100 valid clicks produce ₹150 in click rewards. 20 repeat visits do not add another 20 rewards.
- Click rewards are stored in `affiliate_commissions` with `commission_model = 'pay_per_click'`, the click record ID, fixed rate and reward amount. They have no customer payment/order record by design.
- For an active external website affiliate with an administrator-configured S2S URL, each new valid-click reward queues a signed `valid_click` postback. The payload includes the Click ID and click reward; it has no sale amount, order ID, or payment ID.
- Historical CPC commission rows are also queued when an admin saves the affiliate's S2S settings, using the same outbox and retry ledger as plan-purchase conversions.

## Valid-click policy and fraud limitations

The first-party policy uses an HTTP-only random browser cookie, a per-affiliate/per-UTC-day unique visitor key, and a second privacy-preserving HMAC fingerprint based on trusted client IP + user-agent. The second key stops a visitor from obtaining extra daily rewards just by opening new Incognito windows or clearing cookies on the same network/device/browser. Raw IP addresses and raw user-agent values are not stored. Common bots, link previews, monitoring agents, and an affiliate's own authenticated clicks are not billable. Duplicate attempts remain analytics records with a risk reason and no commission.

This is abuse reduction, not perfect human identity verification. VPN/IP rotation, device changes, mobile-network changes, headless-browser evasion, and multiple real users behind the same public IP + user-agent can still affect matching. Keep CPC rewards Pending until reviewed/approved and monitor click bursts. Configure trusted proxy IP headers in production and keep `AFFILIATE_FRAUD_SALT` stable and private. See `docs/LOCAL-TEST-ACCOUNTS.md` for local CPC testing notes.

## Admin workflow

1. **Create affiliate:** choose account type, affiliate type, earning model and the matching rate.
2. **Approve application:** select the earning model and rate before approval.
3. **Edit affiliate:** change the model/rate for future activity. Existing ledger entries remain unchanged.
4. **Review performance:** the admin list shows visits, valid clicks, referrals, paid conversions, conversion ratio, total commission and pending commission.
5. **Payout:** approve the commission, then mark it paid only after the actual payout has been completed. The admin panel does not transfer money automatically.

## Affiliate dashboard

The affiliate sees only the earning model and rate selected by the admin, along with their own referral link, clicks, referred users, transactions and commissions. The model selector and S2S endpoint settings are not exposed to the affiliate.

## Database update

Run the additive migration (preserves current users, games, plans, payments and affiliate records):

```powershell
npm run db:migrate:admin
```

Do **not** use `npm run db:migrate:fresh` on a populated database; that command drops and rebuilds all tables and deletes all data.
