import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PUBLIC_API_KEY, SITE_ORIGIN, PRODUCT, STRIPE_VERSION, WEBHOOK_EVENTS,
  validateCheckoutInput, assertPaidSession, publicOrder, verifyStripeSignature,
} from '../functions/_shared/throne-core.mjs';
import {
  createCheckoutHandler, createStatusHandler, createWebhookHandler,
  ensureWebhook, reconcileOrder, reconcileRefund,
} from '../functions/_shared/throne-service.mjs';

const NOW = 1_794_950_000_000;
const ID = '11111111-1111-4111-8111-111111111111';
const TOKEN = '22222222-2222-4222-8222-222222222222';
const REQUEST = '33333333-3333-4333-8333-333333333333';
const TEST_SIGNATURE_SECRET = 'whsec_fixtureForLocalTestsOnly';

function order(extra = {}) {
  return { id: ID, access_token: TOKEN, request_id: REQUEST, amount_cents: 10100,
    display_name: null, country: null, status: 'pending', currency: 'eur', crowned_at: null,
    stripe_checkout_session_id: 'cs_live_fixtureSession', stripe_payment_intent_id: null,
    created_at: new Date(NOW).toISOString(), paid_at: null, ...extra };
}
function session(extra = {}) {
  return { id: 'cs_live_fixtureSession', livemode: true, mode: 'payment', status: 'complete',
    payment_status: 'paid', currency: 'eur', amount_total: 10100, client_reference_id: ID,
    payment_intent: { id: 'pi_fixturePayment', livemode: true, status: 'succeeded', currency: 'eur', amount_received: 10100 },
    metadata: { product: PRODUCT, order_id: ID }, ...extra };
}
function state(extra = {}) {
  return { owner_name: 'Michael Merz', country: 'Slovakia', amount_cents: 10000,
    verified_payment: false, current_order_id: null, ...extra };
}
function endpoint(extra = {}) {
  return { id: 'we_fixtureEndpoint', livemode: true, status: 'enabled', api_version: STRIPE_VERSION,
    url: 'https://fixture.supabase.co/functions/v1/rich-throne-webhook', enabled_events: WEBHOOK_EVENTS,
    metadata: { integration: PRODUCT, project_ref: 'fixture' }, secret: TEST_SIGNATURE_SECRET, ...extra };
}
function runtime(extra = {}) {
  return { now: () => NOW, liveKey: true, projectRef: 'fixture',
    webhookUrl: 'https://fixture.supabase.co/functions/v1/rich-throne-webhook',
    cache: { ready: true, endpointId: 'we_fixtureEndpoint', checkedAt: NOW },
    log: () => {}, subjectHash: async () => 'a'.repeat(64),
    rpc: async name => {
      if (name === 'rich_throne_rate_limit') return { allowed: true };
      if (name === 'rich_throne_webhook_configuration') return { ready: true, endpoint_id: 'we_fixtureEndpoint', signing_secret: TEST_SIGNATURE_SECRET };
      throw new Error(`Unexpected RPC ${name}`);
    },
    stripe: async () => { throw new Error('Unexpected Stripe call'); }, ...extra };
}
function browserRequest(path, data, headers = {}) {
  return new Request(`https://fixture.supabase.co/functions/v1/${path}`, { method: 'POST',
    headers: { origin: SITE_ORIGIN, apikey: PUBLIC_API_KEY, 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(data) });
}
async function signedHeader(raw, timestamp = Math.floor(NOW / 1000)) {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', encoder.encode(TEST_SIGNATURE_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const digest = await crypto.subtle.sign('HMAC', key, encoder.encode(`${timestamp}.${raw}`));
  return `t=${timestamp},v1=${[...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('')}`;
}

test('checkout accepts optional public identity and a high free amount', () => {
  assert.deepEqual(validateCheckoutInput({ request_id: REQUEST, amount_cents: 500000, accepted_terms: true }),
    { request_id: REQUEST, amount_cents: 500000, display_name: null, country: null });
  assert.equal(validateCheckoutInput({ request_id: REQUEST, amount_cents: 10100, accepted_terms: true, display_name: '  ', country: '' }).display_name, null);
});

test('checkout rejects fractions, unsafe amounts, malformed identity and absent consent', () => {
  const good = { request_id: REQUEST, amount_cents: 10100, accepted_terms: true };
  for (const change of [{ amount_cents: 10100.1 }, { amount_cents: 10099 }, { amount_cents: 1e12 },
    { request_id: 'not-a-uuid' }, { display_name: 'A\nB' }, { country: 'x'.repeat(81) }, { accepted_terms: false }]) {
    assert.throws(() => validateCheckoutInput({ ...good, ...change }));
  }
});

test('payment verification rejects amount, mode, identity and unsettled PaymentIntent mismatches', () => {
  assert.doesNotThrow(() => assertPaidSession(session(), order()));
  for (const change of [{ livemode: false }, { amount_total: 10200 }, { currency: 'usd' },
    { metadata: { product: 'rich-gift', order_id: ID } }, { client_reference_id: TOKEN },
    { payment_status: 'unpaid' }, { payment_intent: { ...session().payment_intent, status: 'processing' } }]) {
    assert.throws(() => assertPaidSession(session(change), order()));
  }
});

test('signature verification authenticates the raw body and rejects stale/future/replaced signatures', async () => {
  const raw = '{"livemode":true}';
  const header = await signedHeader(raw);
  assert.equal(await verifyStripeSignature(raw, header, TEST_SIGNATURE_SECRET, NOW / 1000), true);
  assert.equal(await verifyStripeSignature(`${raw} `, header, TEST_SIGNATURE_SECRET, NOW / 1000), false);
  assert.equal(await verifyStripeSignature(raw, await signedHeader(raw, NOW / 1000 - 301), TEST_SIGNATURE_SECRET, NOW / 1000), false);
  assert.equal(await verifyStripeSignature(raw, await signedHeader(raw, NOW / 1000 + 301), TEST_SIGNATURE_SECRET, NOW / 1000), false);
  assert.equal(await verifyStripeSignature(raw, header.replace(/v1=.*/, `v1=${'0'.repeat(64)}`), TEST_SIGNATURE_SECRET, NOW / 1000), false);
});

test('order status requires the public key, an allowed origin and an unguessable order token', async () => {
  let databaseReads = 0;
  const handler = createStatusHandler(runtime({ rpc: async () => { databaseReads++; return null; } }));
  assert.equal((await handler(browserRequest('rich-throne-order-status', { order_token: TOKEN }, { apikey: 'wrong' }))).status, 401);
  assert.equal((await handler(browserRequest('rich-throne-order-status', { order_token: TOKEN }, { origin: 'https://attacker.example' }))).status, 403);
  assert.equal((await handler(browserRequest('rich-throne-order-status', { order_token: 'guess' }))).status, 400);
  assert.equal(databaseReads, 0);
});

test('unknown valid token returns404 and cannot trigger Stripe retrieval', async () => {
  let stripeCalls = 0;
  const handler = createStatusHandler(runtime({
    rpc: async name => name === 'rich_throne_rate_limit' ? { allowed: true } : null,
    stripe: async () => { stripeCalls++; },
  }));
  assert.equal((await handler(browserRequest('rich-throne-order-status', { order_token: TOKEN }))).status, 404);
  assert.equal(stripeCalls, 0);
});

test('a forged session hint never reaches Stripe or the settlement RPC', async () => {
  let calls = 0;
  await assert.rejects(reconcileOrder(runtime({ stripe: async () => { calls++; } }), order(), 'cs_live_someoneElse'), /does not belong/);
  assert.equal(calls, 0);
});

test('unpaid Checkout leaves an order pending and never writes ownership', async () => {
  let writes = 0;
  const original = order();
  const result = await reconcileOrder(runtime({ stripe: async () => session({ status: 'open', payment_status: 'unpaid', payment_intent: null }), rpc: async () => { writes++; } }), original);
  assert.equal(result, original);
  assert.equal(writes, 0);
});

test('a paid verified session passes exact server-retrieved values into the atomic RPC', async () => {
  const calls = [];
  const result = await reconcileOrder(runtime({ stripe: async () => session(), rpc: async (name, args) => {
    calls.push({ name, args });
    return { order: order({ status: 'paid', crowned_at: new Date(NOW).toISOString() }) };
  } }), order());
  assert.equal(result.status, 'paid');
  assert.deepEqual(calls, [{ name: 'rich_throne_confirm_payment', args: { p_order_id: ID,
    p_session_id: 'cs_live_fixtureSession', p_payment_intent_id: 'pi_fixturePayment', p_amount_cents: 10100, p_currency: 'eur', p_livemode: true } }]);
});

test('rechecking a previously crowned customer cannot crown or refund them again', async () => {
  const previous = order({ status: 'paid', crowned_at: new Date(NOW - 10000).toISOString() });
  const rt = runtime({ stripe: async () => { throw new Error('Should not call Stripe'); }, rpc: async () => { throw new Error('Should not write'); } });
  assert.equal(await reconcileOrder(rt, previous), previous);
  assert.equal(await reconcileRefund(rt, previous), previous);
  assert.equal(publicOrder(previous, state({ current_order_id: REQUEST })).is_current_owner, false);
  assert.equal(publicOrder(previous, state({ current_order_id: REQUEST })).crowned_at, previous.crowned_at);
});

test('minimum changes return409 and do not create a Stripe Checkout', async () => {
  let checkouts = 0;
  const base = runtime();
  const handler = createCheckoutHandler(runtime({ rpc: async (name, args) => name === 'rich_throne_prepare_order'
    ? { error: 'minimum_changed', next_minimum: 501 } : base.rpc(name, args),
  stripe: async () => { checkouts++; } }));
  const response = await handler(browserRequest('rich-throne-checkout', { request_id: REQUEST, amount_cents: 10100, accepted_terms: true }));
  assert.equal(response.status, 409);
  assert.equal((await response.json()).next_minimum, 501);
  assert.equal(checkouts, 0);
});

test('variable Checkout pins EUR, disables adaptive pricing and uses the same stable identity', async () => {
  const base = runtime();
  let stripeCall;
  const highOrder = order({ amount_cents: 50000, stripe_checkout_session_id: null });
  const rt = runtime({ rpc: async (name, args) => {
    if (name === 'rich_throne_prepare_order') return { order: highOrder };
    if (name === 'rich_throne_attach_session') return { ...highOrder, stripe_checkout_session_id: args.p_session_id };
    return base.rpc(name, args);
  }, stripe: async (method, path, params, key) => {
    stripeCall = { method, path, params, key };
    return session({ amount_total: 50000, status: 'open', payment_status: 'unpaid', payment_intent: null, url: 'https://checkout.stripe.com/c/pay/fixture' });
  } });
  const response = await createCheckoutHandler(rt)(browserRequest('rich-throne-checkout', { request_id: REQUEST, amount_cents: 50000, accepted_terms: true }));
  assert.equal(response.status, 200);
  assert.equal(stripeCall.params.line_items[0].price_data.unit_amount, 50000);
  assert.equal(stripeCall.params.line_items[0].price_data.currency, 'eur');
  assert.equal(stripeCall.params.adaptive_pricing.enabled, false);
  assert.equal(stripeCall.params.ui_mode, undefined);
  assert.equal(stripeCall.params.payment_method_types, undefined);
  assert.equal(stripeCall.key, `rich-throne-checkout-${ID}`);
  assert.match(stripeCall.params.integration_identifier, /[a-z]{8}$/);
  const body = await response.text();
  assert.equal(body.includes(TEST_SIGNATURE_SECRET), false);
});

test('webhook setup contention fails closed without creating another endpoint', async () => {
  let stripeCalls = 0;
  const rt = runtime({ rpc: async name => name === 'rich_throne_webhook_configuration' ? { ready: false } : { acquired: false },
    stripe: async () => { stripeCalls++; } });
  await assert.rejects(ensureWebhook(rt), /preparing/);
  assert.equal(stripeCalls, 0);
});

test('webhook creation retries reuse the same idempotency key after Vault acknowledgement failure', async () => {
  const keys = [];
  let saveAttempts = 0;
  let saved = false;
  const rt = runtime({ cache: { ready: false, checkedAt: 0 }, rpc: async (name, args) => {
    if (name === 'rich_throne_webhook_configuration') return { ready: false };
    if (name === 'rich_throne_acquire_webhook_setup') return { acquired: true, generation: REQUEST };
    if (name === 'rich_throne_release_webhook_setup') return null;
    if (name === 'rich_throne_save_webhook_setup') {
      assert.equal(args.p_signing_secret, TEST_SIGNATURE_SECRET);
      saveAttempts++;
      if (saveAttempts === 1) throw new Error('Simulated database outage');
      saved = true;
      return { ready: true };
    }
    throw new Error(name);
  }, stripe: async (method, path, params, key) => {
    if (path === '/v1/account') return { id: 'acct_fixtureAccount' };
    keys.push(key);
    return endpoint();
  } });
  await assert.rejects(ensureWebhook(rt));
  await ensureWebhook(rt);
  assert.equal(saved, true);
  assert.equal(keys.length, 2);
  assert.equal(keys[0], keys[1]);
});

test('refund recovery finds an accepted refund after a lost DB write, without another POST', async () => {
  const losing = order({ status: 'superseded', stripe_payment_intent_id: 'pi_fixturePayment', refund_status: 'pending' });
  let posts = 0;
  let recorded;
  const existing = { id: 're_fixtureRefund', amount: 10100, currency: 'eur', payment_intent: 'pi_fixturePayment',
    metadata: { product: PRODUCT, order_id: ID }, status: 'succeeded' };
  const result = await reconcileRefund(runtime({ stripe: async (method, path) => {
    if (method === 'POST') posts++;
    assert.equal(path, '/v1/refunds');
    return { data: [existing], has_more: false };
  }, rpc: async (name, args) => { recorded = args; return { ...losing, status: 'refunded', refund_status: 'succeeded' }; } }), losing);
  assert.equal(posts, 0);
  assert.equal(recorded.p_refund_id, 're_fixtureRefund');
  assert.equal(result.status, 'refunded');
});

test('a pending refund is persisted as pending and review states are not presented as completed', async () => {
  const losing = order({ status: 'superseded', stripe_payment_intent_id: 'pi_fixturePayment', stripe_refund_id: 're_fixtureRefund', refund_status: 'pending' });
  let persisted;
  await reconcileRefund(runtime({ stripe: async () => ({ id: 're_fixtureRefund', amount: 10100, currency: 'eur', payment_intent: 'pi_fixturePayment',
    metadata: { product: PRODUCT, order_id: ID }, status: 'pending' }), rpc: async (name, args) => { persisted = args; return losing; } }), losing);
  assert.equal(persisted.p_refund_status, 'pending');
  assert.equal(publicOrder(losing, state()).status, 'refund_pending');
  assert.equal(publicOrder({ ...losing, refund_status: 'failed' }, state()).status, 'superseded');
  assert.equal(publicOrder({ ...losing, refund_status: 'requires_action' }, state()).refund_status, 'requires_action');
});

test('signed test-mode and other-product events cannot look up or change a throne order', async () => {
  for (const event of [
    { livemode: false, type: 'checkout.session.completed', data: { object: session() } },
    { livemode: true, type: 'checkout.session.completed', data: { object: session({ metadata: { product: 'rich-gift', order_id: ID } }) } },
  ]) {
    let orderCalls = 0;
    const base = runtime();
    const handler = createWebhookHandler(runtime({ rpc: async (name, args) => { if (name !== 'rich_throne_webhook_configuration') orderCalls++; return base.rpc(name, args); } }));
    const raw = JSON.stringify(event);
    const result = await handler(new Request('https://fixture/webhook', { method: 'POST', headers: { 'stripe-signature': await signedHeader(raw) }, body: raw }));
    assert.equal(result.status, event.livemode ? 200 : 400);
    assert.equal(orderCalls, 0);
  }
});

test('a signed delayed-payment failure expires the unpaid attempt without changing ownership', async () => {
  const writes = [];
  const base = runtime();
  const rt = runtime({ rpc: async (name, args) => {
    if (name === 'rich_throne_get_order') return order();
    if (name === 'rich_throne_mark_expired') { writes.push(name); return order({ status: 'expired' }); }
    return base.rpc(name, args);
  }, stripe: async () => session({ status: 'complete', payment_status: 'unpaid', payment_intent: null }) });
  const raw = JSON.stringify({ livemode: true, type: 'checkout.session.async_payment_failed', data: { object: session() } });
  const result = await createWebhookHandler(rt)(new Request('https://fixture/webhook', { method: 'POST', headers: { 'stripe-signature': await signedHeader(raw) }, body: raw }));
  assert.equal(result.status, 200);
  assert.deepEqual(writes, ['rich_throne_mark_expired']);
});

test('unexpected internal errors cannot leak provider secrets or customer information', async () => {
  const logged = [];
  const rt = runtime({ log: code => logged.push(code), rpc: async () => { throw new Error(`${TEST_SIGNATURE_SECRET} customer@example.test`); } });
  const result = await createStatusHandler(rt)(browserRequest('rich-throne-order-status', { order_token: TOKEN }));
  const body = await result.text();
  assert.equal(result.status, 503);
  assert.equal(body.includes(TEST_SIGNATURE_SECRET), false);
  assert.equal(body.includes('customer@example.test'), false);
  assert.deepEqual(logged, ['service_unavailable']);
});
