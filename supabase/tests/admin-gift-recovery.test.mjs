import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { BLACK_FRIDAY, BLACK_FRIDAY_START } from '../functions/_shared/black-friday.mjs';
import { recoverPaidGift } from '../functions/rich-admin/gift-recovery.mjs';

const buyer = 'purchaser@example.invalid';
const otherEmail = 'recipient@example.invalid';
const orderId = '10000000-0000-4000-8000-000000000001';
const accessToken = '20000000-0000-4000-8000-000000000002';
const giftToken = '30000000-0000-4000-8000-000000000003';
const admin = await readFile(new URL('../functions/rich-admin/index.ts', import.meta.url), 'utf8');
const handlerSource = stripTypeScriptTypes(admin.replace(/^import[^\n]*;\r?$/gm, ''));
const request = { action: 'recover_paid_gift', order_id: orderId, buyer_email: buyer, mailbox_verified: true };

function fixture(discounted = false) {
  const cents = discounted ? 2450 : 4900;
  const order = {
    id: orderId, access_token: accessToken, gift_token: giftToken, buyer_email: buyer,
    status: 'paid', amount_cents: cents, currency: 'eur', paid_at: '2026-11-27T13:50:00Z',
    stripe_checkout_session_id: 'cs_live_fixture', stripe_payment_intent_id: 'pi_fixture',
  };
  const charge = {
    id: 'ch_fixture', payment_intent: order.stripe_payment_intent_id, status: 'succeeded',
    livemode: true, captured: true, paid: true, amount: cents, amount_captured: cents,
    currency: 'eur', refunded: false, amount_refunded: 0, disputed: false,
    refunds: { data: [], has_more: false },
  };
  const intent = {
    id: order.stripe_payment_intent_id, status: 'succeeded', livemode: true,
    currency: 'eur', amount: cents, amount_received: cents, latest_charge: charge,
  };
  const session = {
    id: order.stripe_checkout_session_id, livemode: true, mode: 'payment',
    client_reference_id: order.id, status: 'complete', payment_status: 'paid',
    amount_total: cents, currency: 'eur', customer_details: { email: buyer },
    metadata: { product: 'rich-gift', order_id: order.id, ...(discounted ? { campaign: BLACK_FRIDAY } : {}) },
    created: BLACK_FRIDAY_START + (discounted ? 1 : -1), payment_intent: intent,
  };
  const audit = [];
  const dependencies = {
    async loadOrder(id) { assert.equal(id, orderId); return structuredClone(order); },
    async loadSession(id) { assert.equal(id, order.stripe_checkout_session_id); return structuredClone(session); },
    async recordAudit(...args) { audit.push(args); },
  };
  return { order, session, intent, charge, audit, dependencies };
}

function assertWithheld(result, label) {
  assert.ok(result.status >= 400, label);
  assert.equal(result.body.recovery_url, undefined, label);
  assert.equal(result.body.buyer_email, undefined, label);
  const response = JSON.stringify(result.body);
  for (const privateValue of [accessToken, giftToken, buyer, 'private diagnostic']) {
    assert.equal(response.includes(privateValue), false, label);
  }
}

test('a verified buyer who closed Checkout recovers the same existing order link at either price', async () => {
  for (const discounted of [false, true]) {
    const f = fixture(discounted);
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = await recoverPaidGift(request, f.dependencies);
      assert.equal(result.status, 200);
      assert.deepEqual(result.body, { recovery_url: 'https://therichbutton.com/gift.html?order=' + accessToken, buyer_email: buyer });
    }
    assert.deepEqual(f.audit, [[orderId], [orderId]]);
  }
});

test('a mailbox attestation and a match with the checkout email are both required', async () => {
  for (const changes of [{ mailbox_verified: false }, { mailbox_verified: 'true' }, { buyer_email: otherEmail }, { order_id: 'unknown' }]) {
    const f = fixture();
    assertWithheld(await recoverPaidGift({ ...request, ...changes }, f.dependencies));
    assert.deepEqual(f.audit, []);
  }
  const alias = fixture();
  alias.order.buyer_email = alias.session.customer_details.email = 'purchaser+gift@example.invalid';
  assertWithheld(await recoverPaidGift(request, alias.dependencies));
  const changed = fixture();
  changed.session.customer_details.email = otherEmail;
  assertWithheld(await recoverPaidGift(request, changed.dependencies));
  assert.deepEqual(changed.audit, []);
});

test('pending, refunded or incomplete local orders never expose a link', async () => {
  for (const patch of [
    { status: 'pending' }, { status: 'refunded' }, { gift_token: null }, { access_token: null },
    { stripe_checkout_session_id: null }, { stripe_payment_intent_id: null },
  ]) {
    const f = fixture();
    Object.assign(f.order, patch);
    assertWithheld(await recoverPaidGift(request, f.dependencies), Object.keys(patch).join(','));
    assert.deepEqual(f.audit, []);
  }
});

test('a mismatched, incomplete, refunded or disputed Stripe payment never authorizes recovery', async () => {
  const cases = [
    ['session', { payment_status: 'unpaid' }], ['session', { status: 'open' }],
    ['session', { livemode: false }], ['session', { amount_total: 4900 }],
    ['session', { id: 'cs_live_other' }], ['session', { client_reference_id: 'other' }],
    ['session', { metadata: { order_id: orderId, product: 'rich-edition' } }],
    ['session', { metadata: { order_id: orderId, product: 'rich-gift' } }],
    ['session', { currency: 'usd' }], ['session', { payment_intent: 'pi_fixture' }],
    ['intent', { id: 'pi_other' }], ['intent', { status: 'processing' }],
    ['intent', { amount_received: 1 }], ['intent', { latest_charge: null }],
    ['charge', { paid: false }], ['charge', { captured: false }], ['charge', { livemode: false }],
    ['charge', { refunded: true }], ['charge', { amount_refunded: 100 }],
    ['charge', { disputed: true }], ['charge', { currency: 'usd' }],
    ['charge', { refunds: { data: [{ status: 'pending' }], has_more: false } }],
    ['charge', { refunds: { data: [], has_more: true } }],
    ['charge', { amount_captured: 1 }], ['charge', { payment_intent: 'pi_other' }],
  ];
  for (const [record, patch] of cases) {
    const f = fixture(true);
    Object.assign(f[record], patch);
    const scenario = record + ' ' + JSON.stringify(patch);
    assertWithheld(await recoverPaidGift(request, f.dependencies), scenario);
    assert.deepEqual(f.audit, [], scenario);
  }
});

test('database, Stripe or audit failures withhold the link and diagnostic details', async () => {
  for (const operation of ['loadOrder', 'loadSession', 'recordAudit']) {
    const f = fixture();
    f.dependencies[operation] = async () => { throw new Error('private diagnostic ' + accessToken); };
    assertWithheld(await recoverPaidGift(request, f.dependencies), operation);
  }
  const f = fixture();
  f.dependencies.loadOrder = async () => null;
  assertWithheld(await recoverPaidGift(request, f.dependencies));
  assert.deepEqual(f.audit, []);
});

test('the recovery endpoint rejects missing authentication, non-admins and unconfirmed accounts before lookup', async () => {
  let handler, user, lookups = 0;
  const failLookup = () => { lookups++; throw new Error('Unexpected order lookup'); };
  const db = { auth: { async getUser() { return { data: { user } }; } }, from: failLookup };
  runInNewContext(handlerSource, {
    Deno: { serve(fn) { handler = fn; }, env: { get: () => 'fixture' } },
    createClient: () => db, recoverPaidGift: failLookup, Response,
  });
  async function post(authorization, origin = 'https://therichbutton.com') {
    return handler(new Request('https://fixture.invalid', {
      method: 'POST', headers: { origin, authorization }, body: JSON.stringify(request),
    }));
  }
  for (const [authorization, account, status] of [
    ['', null, 401], ['Bearer fixture', null, 403],
    ['Bearer fixture', { email: buyer, email_confirmed_at: 'confirmed' }, 403],
    ['Bearer fixture', { email: 'info@akademiaene.com', email_confirmed_at: null }, 403],
  ]) {
    user = account;
    const denied = await post(authorization);
    assert.equal(denied.status, status);
    assert.equal(denied.headers.get('cache-control'), 'no-store');
  }
  user = { email: 'info@akademiaene.com', email_confirmed_at: 'confirmed' };
  assert.equal((await post('Bearer fixture', 'https://other.invalid')).status, 403);
  assert.equal(lookups, 0);
});

test('a revocation recorded while Stripe is being checked prevents disclosure', async () => {
  const f = fixture();
  f.dependencies.loadSession = async () => {
    f.order.status = 'refunded';
    return f.session;
  };
  assertWithheld(await recoverPaidGift(request, f.dependencies));
  assert.deepEqual(f.audit, []);
});

test('the authenticated endpoint reads one exact order, uses a live key, requests refund details and writes a limited audit entry', async () => {
  const f = fixture();
  const actor = 'info@akademiaene.com';
  const calls = [];
  const db = {
    auth: { async getUser() { return { data: { user: { email: actor, email_confirmed_at: 'confirmed' } } }; } },
    from(table) {
      if (table === 'rich_admin_audit') return { async insert(entry) { calls.push(['audit', entry]); return {}; } };
      assert.equal(table, 'rich_gift_orders');
      return { select(fields) {
        const row = Object.fromEntries(fields.split(',').map(name => [name, f.order[name]]));
        return { eq(field, value) {
          assert.deepEqual([field, value], ['id', orderId]);
          calls.push(['lookup', value]);
          return { async maybeSingle() { return { data: row }; } };
        } };
      } };
    },
  };
  let handler, key = 'sk_test_fixture';
  class Stripe {
    constructor(secret) { assert.equal(secret, 'sk_live_fixture'); }
    checkout = { sessions: { async retrieve(id, options) {
      assert.equal(id, f.order.stripe_checkout_session_id);
      assert.equal(options.expand.length, 1);
      assert.equal(options.expand[0], 'payment_intent.latest_charge.refunds');
      calls.push(['stripe', id]);
      return f.session;
    } } };
  }
  runInNewContext(handlerSource, {
    Deno: { serve(fn) { handler = fn; }, env: { get: name => name === 'STRIPE_SECRET_KEY' ? key : 'fixture' } },
    createClient: () => db, recoverPaidGift, Stripe, Response,
  });
  const post = () => handler(new Request('https://fixture.invalid', {
    method: 'POST', headers: { origin: 'https://therichbutton.com', authorization: 'Bearer fixture' },
    body: JSON.stringify(request),
  }));
  assert.equal((await post()).status, 503);
  assert.deepEqual(calls, []);
  key = 'sk_live_fixture';
  const result = await post();
  assert.equal(result.status, 200);
  assert.equal(result.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await result.json(), { recovery_url: 'https://therichbutton.com/gift.html?order=' + accessToken, buyer_email: buyer });
  assert.deepEqual(calls.map(([kind]) => kind), ['lookup', 'stripe', 'lookup', 'audit']);
  const entry = JSON.parse(JSON.stringify(calls.at(-1)[1]));
  assert.equal(entry.actor_email, actor);
  assert.deepEqual(entry.new_value, { order_id: orderId });
  for (const secret of [accessToken, giftToken, buyer]) assert.equal(JSON.stringify(entry).includes(secret), false);
});

test('the ordinary dashboard retains aggregate paid and complimentary metrics without returning paid gift tokens', async () => {
  const complimentaryToken = '40000000-0000-4000-8000-000000000004';
  const { order } = fixture();
  const actor = 'info@akademiaene.com';
  const rows = {
    rich_gift_orders: [
      { ...order, referral_kind: 'paid', referral_token: giftToken },
      { ...order, id: '50000000-0000-4000-8000-000000000005', referral_kind: 'complimentary', referral_token: complimentaryToken },
    ],
    rich_throne_state: [{ id: 1 }],
    rich_admin_audit: [],
    rich_complimentary_gifts: [{ id: 'promo', token: complimentaryToken, revoked_at: null }],
    rich_analytics_events: [
      ['complimentary', complimentaryToken, 'gift_reveal'],
      ['complimentary', complimentaryToken, 'gift_open'],
      ['paid', giftToken, 'gift_open'],
      ['complimentary', giftToken, 'gift_open'],
    ].map(([gift_kind, gift_id, event_type]) => ({ gift_kind, gift_id, event_type, created_at: '2026-11-27T13:55:00Z' })),
  };
  const db = {
    auth: { async getUser() { return { data: { user: { email: actor, email_confirmed_at: 'confirmed' } } }; } },
    from(table) {
      return { select(fields) {
        const selected = rows[table].map(row => fields === '*' ? row : Object.fromEntries(fields.split(',').map(name => [name, row[name]])));
        return {
          eq() { return this; }, order() { return this; }, in() { return this; }, gte() { return this; },
          async limit(n) { return { data: selected.slice(0, n) }; },
          async single() { return { data: selected[0] }; },
        };
      } };
    },
  };
  let handler;
  runInNewContext(handlerSource, {
    Deno: { serve(fn) { handler = fn; }, env: { get: () => 'fixture' } },
    createClient: () => db, Response,
  });
  const result = await handler(new Request('https://fixture.invalid', {
    method: 'POST', headers: { origin: 'https://therichbutton.com', authorization: 'Bearer fixture' },
    body: JSON.stringify({ action: 'overview' }),
  }));
  assert.equal(result.status, 200);
  const overview = await result.json();
  assert.equal(JSON.stringify(overview).includes(giftToken), false);
  assert.equal(JSON.stringify(overview).includes(accessToken), false);
  assert.ok(overview.orders.every(row => !Object.hasOwn(row, 'referral_token')));
  assert.equal(overview.analytics.gift_opens, 3);
  assert.equal(overview.analytics.reveals, 1);
  const bucket = 'complimentary:' + complimentaryToken;
  assert.deepEqual(overview.analytics.by_gift, { [bucket]: { opens: 1, reveals: 1, cta_clicks: 0 } });
  assert.deepEqual(overview.analytics.referral_paid, { [bucket]: 1 });
  assert.equal(overview.summary.paid, 2);
});
