import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { BLACK_FRIDAY, BLACK_FRIDAY_START } from '../functions/_shared/black-friday.mjs';
import { validGiftPayment, giftOrganicFields } from '../functions/_shared/gift-payment.mjs';
import { writeOrganicOrder } from '../functions/_shared/organic-order.mjs';

const code = await readFile(new URL('../functions/rich-gift-order-status/index.ts', import.meta.url), 'utf8');
const handlerCode = stripTypeScriptTypes(code.replace(/^import[^\n]*;/gm, ''));
const html = await readFile(new URL('../../gift.html', import.meta.url), 'utf8');
const browserReport = html.slice(html.indexOf('const reportPurchase=async()=>{'), html.indexOf('void reportPurchase().catch('));
const eventId = 'f704310e-2bd9-4dac-9388-40741fcaa8b4';
const token = '30000000-0000-4000-8000-000000000001';

function receipt({ discount = false, orderStatus = 'paid', overrides = {}, receiptOverrides = {},
  chargeOverrides = {}, intentOverrides = {}, sessionOverrides = {}, stripeError = false, dbError = false } = {}) {
  const cents = discount ? 2450 : 4900;
  const order = { id: 'private-order', amount_cents: cents, status: orderStatus, gift_token: 'private-gift',
    stripe_checkout_session_id: 'cs_live_fixture', ...overrides };
  const receiptRow = { status: orderStatus, marketing_event_id: eventId, paid_at: '2026-11-27T12:00:00Z',
    stripe_payment_intent_id: 'pi_example', ...receiptOverrides };
  const charge = { amount: cents, amount_refunded: 0, refunded: false, disputed: false, currency: 'eur',
    livemode: true, paid: true, ...chargeOverrides };
  const session = { id: 'cs_live_fixture', client_reference_id: order.id, livemode: true, mode: 'payment',
    payment_status: 'paid', currency: 'eur', amount_total: cents, created: BLACK_FRIDAY_START,
    metadata: { product: 'rich-gift', order_id: order.id, ...(discount ? { campaign: BLACK_FRIDAY } : {}) },
    payment_intent: { id: 'pi_example', status: 'succeeded', amount_received: cents, latest_charge: charge,
      ...intentOverrides }, ...sessionOverrides };
  let handler;
  let stripeReads = 0;
  const db = { from() { return { select(fields) { return { eq() { return { single: async () => {
    if (!fields.includes('marketing_event_id')) return { data: order };
    return dbError ? { error: {} } : { data: receiptRow };
  }} }}; }}; }};
  runInNewContext(handlerCode, { createClient: () => db, validGiftPayment, giftOrganicFields, writeOrganicOrder, URL, Response, console,
    Deno: { env: { get: () => 'sk_live_fixture' }, serve: fn => { handler = fn; } },
    Stripe: class { checkout = { sessions: { retrieve: async (id, options) => {
      stripeReads++;
      assert.equal(id, order.stripe_checkout_session_id);
      assert.equal(options.expand[0], 'payment_intent.latest_charge');
      if (stripeError) throw Error('Offline');
      return session;
    } } }; }
  });
  return { get reads() { return stripeReads; }, async call({ param = 'cs_live_fixture', purchase = true } = {}) {
    const url = new URL('https://example.invalid/');
    url.searchParams.set('token', token);
    if (param) url.searchParams.set('session_id', param);
    if (purchase) url.searchParams.set('purchase', '1');
    return (await handler(new Request(url))).json();
  }};
}

test('validated full or discounted receipts return only the independent stable event ID and charged amount', async () => {
  for (const discount of [false, true]) {
    const source = receipt({ discount });
    const expected = { purchase: { eventId, value: discount ? 24.5 : 49, currency: 'EUR' } };
    assert.deepEqual(await source.call(), expected);
    assert.deepEqual(await source.call(), expected);
  }
});

test('consented Purchase does not disclose the organic campaign recorded on a verified Gift', async () => {
  const post = 'pinterest_christmas_2026_day-01';
  const source = receipt({
    overrides: {organic_post_id: post, organic_verified_at: '2026-12-02T09:00:00Z'},
    sessionOverrides: {metadata: {product: 'rich-gift', order_id: 'private-order', organic_post_id: post}},
  });
  assert.deepEqual(await source.call(), {purchase: {eventId, value: 49, currency: 'EUR'}});
});

test('ordinary paid gift delivery stays independent of advertising, and a recovery URL never creates a Purchase', async () => {
  const source = receipt({ dbError: true });
  const normal = await source.call({ purchase: false });
  assert.equal(normal.status, 'paid');
  assert.ok(normal.gift_url);
  assert.equal(normal.purchase, undefined);
  for (const param of ['', 'cs_test_fixture', 'cs_live_wrong']) {
    assert.deepEqual(await source.call({ param }), { purchase: null });
  }
  assert.equal(source.reads, 0);
});

test('missing identifiers, unpaid, sandbox, mismatched, refunded and disputed charges cannot emit Purchase', async () => {
  for (const args of [
    { orderStatus: 'pending' }, { orderStatus: 'refunded' }, { dbError: true }, { stripeError: true },
    { receiptOverrides: { marketing_event_id: null } }, { receiptOverrides: { paid_at: null } },
    { receiptOverrides: { stripe_payment_intent_id: 'other' } }, { receiptOverrides: { status: 'refunded' } },
    { chargeOverrides: { amount_refunded: 100 } }, { chargeOverrides: { refunded: true } },
    { chargeOverrides: { disputed: true } }, { chargeOverrides: { paid: false } },
    { sessionOverrides: { livemode: false } }, { sessionOverrides: { currency: 'usd' } },
    { sessionOverrides: { amount_total: 1 } }, { intentOverrides: { amount_received: 1 } },
    { sessionOverrides: { client_reference_id: 'another-private-order' } }
  ]) assert.deepEqual(await receipt(args).call(), { purchase: null });
});

test('browser requests just the event only on a consented real return; ignores unknown fields', async () => {
  async function simulate({ permission = true, missing = false, testToken = null, testMode = false,
    session = 'cs_live_fixture' } = {}) {
    const requests = [], events = [];
    const args = { testOrderToken: testToken, orderToken: token, RICH_GIFT_TEST_MODE: testMode,
      window: { richGiftAds: missing ? undefined : { canMeasurePurchase: () => permission, purchase: p => events.push(p) } },
      URL, URLSearchParams, location: { search: '?order=' + token + '&session_id=' + session },
      fetch: async (url, opts) => {
        assert.equal(url.searchParams.get('purchase'), '1');
        assert.equal(opts.referrerPolicy, 'no-referrer');
        requests.push(url);
        return { ok: true, json: async () => ({ purchase: { eventId, value: 24.5, currency: 'EUR', extraneous: 'omit-me' } }) };
      } };
    await runInNewContext(browserReport + '\nreportPurchase()', args);
    return { requests: requests.length, events: JSON.parse(JSON.stringify(events)) };
  }
  for (const args of [{ permission: false }, { missing: true }, { testToken: token }, { testMode: true },
    { session: '' }, { session: 'cs_test_fixture' }]) assert.deepEqual(await simulate(args), { requests: 0, events: [] });
  assert.deepEqual(await simulate(), { requests: 1, events: [{ eventId, value: 24.5, currency: 'EUR' }] });
});
