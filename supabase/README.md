# The Richest Button backend

This directory implements only The Richest Button. Gift purchases, gift sharing,
gift email and all existing gift functions are unchanged.

## Deploy

Apply `sql/activate-rich-throne.sql` through the database deployment workflow. It
extends the existing throne tables, keeps them private, and adds service-role-only
RPCs. It does not mark the inaugural cash contribution as received or Stripe-verified.

Deploy the four `functions/rich-throne-*` entrypoints with their `_shared` files.
All use `verify_jwt = false` as documented in `config.toml`. Checkout requires the
published site API key, an allowed Origin, consent and a rate-limit check. Status
also requires its random private order token. The webhook uses Stripe HMAC and
rejects test-mode events. The public state function is deliberately public.

Existing environment values used only inside Edge Functions:

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `STRIPE_SECRET_KEY` (a live key with Checkout, PaymentIntent reads, webhook endpoint
  creation/read and refund creation/read permissions)

No key belongs in these files or browser code. The public publishable key in
`throne-core.mjs` is not a credential granting private data access.

The first valid checkout request registers a separate Stripe webhook, using a
database lease and stable Stripe idempotency key. It saves the returned signing
secret into the installed Supabase Vault through a private RPC before opening a
checkout. An interrupted setup can retry the same operation. Setup older than22h
fails closed for review instead of risking an orphan duplicate endpoint.

`rich_throne_webhook_configuration()` is PRIVATE and returns the dedicated signing
secret to service_role. Never print its response in tooling or logs. No secret
is returned by an HTTP response or the public state endpoint.

Before publishing the purchase UI, bootstrap once with a valid unpaid checkout
and verify `purchases_enabled: true` in the public response. Public health is
cached for30 seconds and fails closed when the configured live webhook cannot
be verified. Opening Checkout does not charge a card.

## Payment behavior

The amount is checked against the live minimum at checkout and again atomically
when a paid Stripe session is confirmed. The singleton row lock serializes crown
changes. A previously crowned purchaser retains their keepsake and is never
automatically refunded when a later higher purchase overtakes them.

A paid purchase that has already been overtaken before receiving the title is
refunded. Pending refunds stay pending. Failed, canceled or action-required refunds
are shown with `status: superseded` and an explicit `refund_status` for support.
Refund recovery looks up existing Stripe refunds before another POST, including
after a lost database acknowledgement beyond Stripe's idempotency retention.

The dedicated signed webhook and the order-return page use the same verification
routine. Closing the browser does not stop webhook processing. Delayed payment
success/failure events are handled. No email is required for fulfillment.

## Verification

Run the local tests with:

```sh
node --test supabase/tests/throne.test.mjs
```

`tests/rollback.sql` checks the actual installed RPCs, privileges, both race
orderings, duplicate confirmations, token/session forgery, dynamic minimum and
refund restrictions in a transaction that rolls all fixtures back. It never
calls Stripe, writes Vault secrets or sends email. Run the whole file together;
if the SQL runner stops at an assertion error, explicitly roll the transaction
back before continuing.

Live smoke checks should create unpaid checkouts at101 and500 euros, inspect the
Stripe-returned amounts, then expire those checkouts. Do not pay or change the
inaugural owner during a smoke check. Test payment success in an isolated Stripe
sandbox/branch, or observe the first authorized real payment.
