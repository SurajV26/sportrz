# Sportrz — S2S postbacks for Pay-per-Valid-Click

## What changed

- `plan_purchase` commissions continue sending the existing `conversion` S2S event.
- Every newly created `pay_per_click` commission now creates an outbox delivery for an active external affiliate with a saved postback URL.
- After the click commission transaction commits, Sportrz dispatches a signed `valid_click` event using the same POST/GET setting, HMAC signature, idempotency header, delivery history, retry handling, and SSRF-safe destination validation as plan purchases.
- CPC payloads include `click_id`, `commission`, `rate`, `click_reward`, `earning_model`, and `commission_model`. Sale `amount` is `0.00`; `order_id` and `payment_id` are empty because no sale/payment exists for a click reward.
- The admin ledger now shows postback status and allows retry for click commissions too. The external affiliate page also shows click and purchase postback history.
- Saving an active external affiliate's postback settings queues historical non-reversed commissions for both models if they do not already have a delivery row.

## Files to replace

Extract this ZIP into the root of your local `sportrz` project and replace the files, preserving the folder structure. The ZIP intentionally contains only the files changed for this feature; it does not include `.env*`, `node_modules`, `.next`, database credentials, or other project files.

## Database

No new migration is required for this change. It reuses the existing `affiliate_commissions` and `affiliate_postback_deliveries` schema already used by the plan-purchase S2S flow and the CPC commission ledger.

## Apply and verify

From the project directory:

```powershell
npm run typecheck
npm run build
```

Deploy the newly generated production/standalone build to cPanel using your existing deployment procedure, then restart the Node.js application.

After deployment:

1. In Admin → Affiliate marketing, edit the existing external CPC affiliate.
2. Confirm its postback URL/method are still saved. Click **Save profile** once. This queues any historical click-reward commissions that predate this patch.
3. For an endpoint smoke test, close and reopen the editor and use **Send test event**. The test payload includes `sample_event: valid_click` for CPC and does not create a commission.
4. Open the affiliate referral link using a new eligible visitor. A valid billable click should create one click commission and one S2S delivery. The receiving endpoint should see `event: valid_click` and `X-Sportrz-Event: valid_click`.
5. A 2xx response marks the delivery `sent`; non-2xx, DNS/TLS, or timeout errors remain visible as `failed` and can be retried from the admin ledger.

Only a click that passes the existing fraud/duplicate validation and actually creates a CPC commission sends a postback. Filtered, preview, duplicate, and self-click attempts do not send one.
