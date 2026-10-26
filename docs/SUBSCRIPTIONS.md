# Monthly subscriptions and delivered-result billing

This adds optional Stripe-hosted monthly subscriptions to the existing Studio API, SQLite database and source workspace. Payments are disabled by default. Deploying the code does not start charging anyone, change existing credit balances or create subscriptions.

## Prices and cost reserves

| Plan | Monthly USD | Monthly credits with default reserves | Provider usage allowance |
| --- | ---: | ---: | ---: |
| Starter | 19.99 | 369 | 3.69 USD |
| Pro | 29.99 | 1,329 | 13.29 USD |
| Max | 49.99 | 3,249 | 32.49 USD |

One subscription credit represents 10,000 microdollars of recorded provider usage, or one US cent. It does not represent a message, a guaranteed build, withdrawable money or prepaid provider funds. The database records fractional credits in integer microdollars; splitting work into tiny requests cannot avoid deductions. These units are separate from historical owner-granted fixed-price testing credits. Those wallets and ledgers are preserved.

For each paid period, the allowance is calculated in cents:

```text
allowance = monthly price - 1000 profit target
            - ceil(monthly price * payment reserve basis points / 10000)
            - payment reserve fixed cents
            - overhead/support reserve cents
            - failed-provider-work reserve cents
```

The default payment reserve is 400 basis points plus 50 cents, overhead/support reserve is 300 cents, and failed-work reserve is 200 cents. These are planning assumptions, not verified processing fees or measured hosting/support costs. The resulting 10 USD retained amount is a target before income tax. It is not a guarantee: inaccurate model prices, unpriced usage, an unexpectedly expensive provider response, refunds, disputes, fees exceeding the reserves and higher actual overhead can reduce profit. Review provider invoices and actual business costs before launch. Monthly plans are snapshots, so changing reserve settings affects new checkouts, not an existing subscription's allowance or price.

## Customer behavior

- Plans and usage live at `/workspace.html#billing`.
- The customer explicitly acknowledges the monthly price, recurring payment and monthly allowance reset before opening Stripe Checkout. No card is charged by editing files or opening the workspace.
- A compatible coding model, healthy matching worker, a member-enabled coding tool and usable account limits are required before starting checkout. Existing daily submission and provider-spending limits are shown before purchase and still apply. Review those owner controls when setting launch capacity.
- Each generation reserves its captured model's maximum provider estimate. Successful validated delivery consumes recorded usage, including planning and repairs, then releases the unused reservation. A conflict that preserves validated downloadable output counts as delivery.
- An API failure, validation failure, cancellation, access revocation or expired worker lease without delivered output restores the full customer reservation, even if a provider may bill Studio. This restores allowance; it is not a cash refund of the subscription payment.
- Delivered output with unreconciled token pricing is preserved with its customer allowance charge waived. The full provider exposure remains recorded. Historical fixed-price jobs retain their captured fixed charge and reconciliation policy.
- Monthly allowance exhaustion blocks generation before another provider request. There are no automatic overage charges, top-ups or credit packs in this release. Editing, existing source, revision history and ZIP exports remain accessible.
- Unused monthly allowance does not roll over. Renewals grant a new period only after a paid invoice is verified. Expired periods cannot authorize new jobs. An already reserved job settles against its original invoice period.
- Cancellation stops the next renewal and preserves access to the paid period. Renewal can be resumed before the subscription ends. The Stripe billing portal supports payment-method changes, invoices and end-of-period cancellation. Plan changes and prorations are disabled; a different plan can be purchased after the current subscription and paid period end.
- Refunded or disputed invoice periods cannot authorize additional jobs. Revocation receipts survive out-of-order webhooks. Already queued revoked work is canceled before claim, and active worker access is rejected. Source files are preserved.

Full customer refund rights and subscription-payment refunds are distinct from the automatic failed-build allowance policy. This update does not set an all-sales-final policy or activate the existing legal drafts.

## Enable and deploy

Use the normal API/frontend deployment procedure in `deploy/STUDIO.md` from the current `/home/nd-ai-studio` checkout. The additive tables are created during API startup, without changing the base SQLite `user_version`. Back up the database before deploying. No worker source change, new database engine or npm runtime dependency is needed.

Configure these in the existing private API environment, never in source or the worker environment:

```text
STUDIO_SUBSCRIPTIONS_ENABLED=true
STRIPE_SECRET_KEY
STRIPE_WEBHOOK_SECRET
```

`STRIPE_SECRET_KEY` must be a valid Stripe test or live secret key. `STRIPE_WEBHOOK_SECRET` must be the signing secret for this Studio endpoint. Use test-mode credentials and a test-mode endpoint first. Do not share a store webhook secret or mix test and live customers in the same database. Leave `STUDIO_SUBSCRIPTIONS_ENABLED` unset until readiness is verified. Do not turn it off as a substitute for canceling active paid subscriptions: Stripe renewals must be managed in Stripe and cancellation access requires a running, configured service.

Optional integer cost-reserve environment settings:

| Setting | Default |
| --- | ---: |
| STUDIO_PAYMENT_RESERVE_BPS | 400 |
| STUDIO_PAYMENT_RESERVE_CENTS | 50 |
| STUDIO_OVERHEAD_RESERVE_CENTS | 300 |
| STUDIO_FAILURE_RESERVE_CENTS | 200 |

The private values stay on the API. Customers receive prices and allowances, not credentials or business-margin settings. Configuration that leaves a plan with no AI allowance is rejected. The public pricing version includes the plan/reserve configuration, rejecting stale checkout acknowledgment after a restart with changed terms.

Create a **snapshot** Stripe webhook destination at:

```text
https://ai.nightz.dev/api/studio/billing/webhook
```

Use API version **2024-06-20**, which is also pinned on outgoing Stripe requests. Subscribe to:

```text
checkout.session.completed
invoice.paid
customer.subscription.created
customer.subscription.updated
customer.subscription.deleted
charge.refunded
charge.dispute.created
```

Only the webhook is exempt from session/CSRF checks; it verifies an HMAC signature against the unmodified bounded request body with a five-minute timestamp tolerance. Checkout, cancellation, refresh and billing-portal creation require the signed-in account, origin and CSRF checks. Checkout receipts and Stripe idempotency keys prevent duplicate sessions on retry. Only a verified paid invoice grants allowance; the browser success URL does not. Return to Plans & usage and use **Refresh payment status** after checkout to reconcile delayed delivery.

Invoice and subscription objects are re-read from Stripe, matched to the server-created checkout/customer and checked for the expected currency, price, one monthly recurring item, quantity, paid amount and period. Duplicate event IDs and invoice periods cannot grant twice. Prorations, discounted or unexpected invoices fail closed for owner reconciliation. Do not add coupons, dashboard plan changes or extra invoice items without implementing their entitlement and margin handling first.

The dedicated portal configuration is created on demand and its ID is stored in SQLite. It enables payment-method changes, invoice history and end-of-period cancellation, while disabling plan updates. Configure applicable tax collection, customer receipts and merchant details in the Stripe account before accepting live payments; this code does not calculate sales tax or invent the business's tax obligations.

## Operations and recovery

`studio_subscription_periods` retains each paid invoice, price, allowance, successful usage, total provider exposure and revocation. `studio_subscription_jobs` retains per-job reservations and customer charges. `studio_billing_events` deduplicates signed deliveries. Provider exposure and customer allowance spending remain separate so restoring failed credits cannot erase business costs.

The maximum estimated provider exposure for new work is the remaining monthly allowance plus the captured failure reserve. Repeated billed failures or unpriced usage can exhaust that reserve; subsequent generation is paused with the unused customer allowance preserved. Review provider costs and resolve the service issue rather than retrying paid calls automatically. Existing daily safety limits remain independent and can pause work sooner.

An uncertain checkout creation keeps its receipt and idempotency key. Retry the same action while the one-hour checkout is valid. If a creation response was lost and its recorded expiry has passed, reconcile the Checkout Session in Stripe before changing that receipt. The service will not create another payment blindly.

Stripe refunds and disputes revoke access rather than erase history. The webhook revocation table prevents a later invoice-paid delivery from restoring a refunded period. Worker exposure already accepted by a provider can still be billed after cancellation or revocation.

If subscriptions must be paused, first prevent new sales and manage active renewals in Stripe, keep existing account billing access available, and reconcile outstanding webhooks. Reverting code does not cancel Stripe subscriptions. Keep the new code running through existing paid periods instead of reverting to a version that ignores purchased entitlements.

## Verification

Run `npm test` and `npm run build`, then verify test-mode checkout, signed paid invoice delivery, duplicate delivery, a successful build, a billed failed build, cancellation/resumption, payment-method update, renewal and refund/dispute handling before enabling live keys. Test fixtures do not contact Stripe or charge a card. Automated tests cover signature tampering, CSRF, stale pricing, cross-account access, precise one-time usage settlement, quota rejection, failure exposure, revoked periods, cancellation and checkout authorization races.

Official integration references:

- https://docs.stripe.com/payments/checkout/build-subscriptions
- https://docs.stripe.com/webhooks
- https://docs.stripe.com/api/billing_portal/configurations/create
- https://docs.stripe.com/api/invoices/object
