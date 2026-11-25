import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { BLACK_FRIDAY, BLACK_FRIDAY_START } from '../functions/_shared/black-friday.mjs';
import { writeOrganicOrder } from '../functions/_shared/organic-order.mjs';
import { PUBLIC_API_KEY, SITE_ORIGIN } from '../functions/_shared/throne-core.mjs';
import { createHandler as createAccess, editionOrganicFields } from '../functions/rich-edition-access/handler.js';
import { createEditionCheckoutHandler } from '../functions/rich-edition-checkout/handler.mjs';

const gift = 'rich_gift_orders', edition = 'rich_edition_orders';
const post = 'pinterest_christmas_2026_day-01', profile = 'youtube_christmas_2026_profile';
const sessionId = 'cs_live_12345678901234567890';
const token = '10000000-0000-4000-8000-000000000001';
const goldLink = 'plink_1Uc13YLqa85X23XWz0MWwicl';
const request = (body, extra = {}) => new Request('https://fixture.invalid/', {
  method: 'POST', headers: {origin: SITE_ORIGIN, 'content-type': 'application/json', apikey: PUBLIC_API_KEY, ...extra},
  body: JSON.stringify(body),
});

async function edge(name, db, stripe) {
  const path = new URL('../functions/' + name + '/index.ts', import.meta.url);
  const source = await readFile(path, 'utf8');
  let handle;
  const globals = {
    Deno: {serve(fn) { handle = fn; }, env: {get: k => k === 'STRIPE_SECRET_KEY' ? 'sk_live_fixture' : 'fixture'}},
    Stripe: class { constructor() { return stripe; } static createSubtleCryptoProvider() { return {}; } },
    createClient: () => db, console, crypto: globalThis.crypto, Response, URL,
    Date: class extends Date { static now() { return BLACK_FRIDAY_START * 1000; } },
  };
  for (const [, imports, file] of source.matchAll(/^import\s*\{([^}]+)\}\s*from\s*"([^"]+)"/gm)) {
    if (!file.startsWith('.')) continue;
    const module = await import(new URL(file, path));
    for (const item of imports.split(',').map(s => s.trim())) globals[item] = module[item];
  }
  runInNewContext(stripTypeScriptTypes(source.replace(/^import[^\n]*;/gm, '')), globals);
  return handle;
}

function database() {
  const tables = {[gift]: [], [edition]: []};
  return {tables, from(table) {
    assert.ok(table in tables);
    const rows = tables[table], filters = [];
    let action = 'select', values;
    function execute() {
      let matches = rows.filter(row => filters.every(([key, value]) => row[key] === value));
      if (action === 'insert' || action === 'upsert') {
        if (table === edition && rows.some(row => row.stripe_session_id === values.stripe_session_id)) {
          return {data: null, error: action === 'insert' ? {code: '23505'} : null};
        }
        const row = {id: 'order-1', access_token: token, status: 'pending', email_sent_at: 'already-sent', ...values};
        rows.push(row);
        matches = [row];
      } else if (action === 'update') {
        for (const row of matches) Object.assign(row, values);
      }
      return {data: matches[0] ? {...matches[0]} : null, error: null};
    }
    return {
      select() { return this; }, eq(key, value) { filters.push([key, value]); return this; },
      insert(data) { action = 'insert'; values = data; return this; },
      upsert(data) { action = 'upsert'; values = data; return this; },
      update(data) { action = 'update'; values = data; return this; },
      single: async () => execute(), maybeSingle: async () => execute(),
      then(yes, no) { return Promise.resolve(execute()).then(yes, no); },
    };
  }};
}

const sessions = () => {
  const fixture = {current: null, params: null};
  return Object.assign(fixture, {
    webhooks: {async constructEventAsync(raw, signature) {
      if (signature !== 'signed-fixture') throw Error('bad signature');
      return JSON.parse(raw);
    }},
    checkout: {sessions: {
      async create(params) {
        fixture.params = params;
        fixture.current = {id: sessionId, created: BLACK_FRIDAY_START, url: 'https://checkout.stripe.com/c/pay/fixture',
          mode: 'payment', status: 'open', livemode: true, payment_status: 'unpaid', currency: 'eur',
          amount_total: params.line_items[0].price_data.unit_amount,
          metadata: params.metadata, client_reference_id: params.client_reference_id};
        return fixture.current;
      },
      async retrieve(id) { assert.equal(id, sessionId); return fixture.current; },
    }},
  });
};

async function notify(handler, session, type = 'checkout.session.completed', signature = 'signed-fixture') {
  const response = await handler(request({type, created: BLACK_FRIDAY_START + 100, livemode: true, data: {object: session}},
    {'stripe-signature': signature}));
  return response.status;
}

test('gift order gains proof only after Stripe payment, with both return orders and delayed callbacks', async () => {
  for (const returnFirst of [true, false]) {
    const db = database(), stripe = sessions();
    const checkout = await edge('rich-gift-checkout', db, stripe);
    const webhook = await edge('stripe-gift-webhook', db, stripe);
    const status = await edge('rich-gift-order-status', db, stripe);
    const returned = () => status(new Request('https://fixture.invalid/?token=' + token + '&session_id=' + sessionId));
    assert.equal((await checkout(request({recipient: 'Fixture', organic_post_id: post}))).status, 200);
    const [order] = db.tables[gift];
    assert.equal(order.organic_post_id, post);
    assert.equal(stripe.params.metadata.campaign, BLACK_FRIDAY);
    assert.equal(stripe.params.metadata.organic_post_id, post);
    assert.equal(new URL(stripe.params.cancel_url).searchParams.get('trb_post'), post);
    assert.equal(new URL(stripe.params.success_url).searchParams.has('trb_post'), false);
    assert.equal(await notify(webhook, stripe.current), 200);
    assert.equal((await returned()).status, 200);
    assert.equal(order.organic_verified_at, undefined);
    assert.equal(order.status, 'pending');
    Object.assign(stripe.current, {status: 'complete', payment_status: 'paid'});
    assert.equal(await notify(webhook, stripe.current, 'checkout.session.async_payment_succeeded', 'invalid'), 400);
    assert.equal(order.organic_verified_at, undefined);
    if (returnFirst) await returned();
    else await notify(webhook, stripe.current, 'checkout.session.async_payment_succeeded');
    const proof = order.organic_verified_at, giftToken = order.gift_token;
    assert.ok(Date.parse(proof));
    assert.equal(order.organic_post_id, post);
    assert.equal(order.status, 'paid');
    await returned();
    await notify(webhook, stripe.current, 'checkout.session.async_payment_succeeded');
    assert.equal(order.organic_verified_at, proof);
    assert.equal(order.gift_token, giftToken);
    assert.equal(db.tables[gift].length, 1);
    order.status = 'refunded';
    await notify(webhook, stripe.current);
    assert.equal(order.status, 'refunded');
  }
});

test('invalid labels, recipient referrals, and paid ads never attach an organic label to a Gift session', async () => {
  for (const [extra, ad] of [[{organic_post_id: 'anything'}, undefined],
    [{organic_post_id: post, referral_kind: 'paid'}, undefined],
    [{organic_post_id: post, campaign_ad: 'vault-v1-miami'}, 'vault-v1-miami']]) {
    const db = database(), stripe = sessions();
    assert.equal((await (await edge('rich-gift-checkout', db, stripe))(request({recipient: 'Fixture', ...extra}))).status, 200);
    const [order] = db.tables[gift];
    assert.equal(order.organic_post_id, undefined);
    assert.equal(stripe.params.metadata.organic_post_id, undefined);
    assert.equal(order.campaign_ad, ad);
    assert.equal(stripe.params.cancel_url.includes('trb_post'), false);
  }
});

test('verified editions credit a profile or post once through regular Payment Links and Black Friday Checkout', async () => {
  for (const isOffer of [true, false]) for (const returnFirst of [true, false]) {
    const db = database(), stripe = sessions();
    const webhook = await edge('stripe-gift-webhook', db, stripe);
    const access = createAccess({db, stripe});
    if (isOffer) {
      const checkout = createEditionCheckoutHandler({stripe, now: () => BLACK_FRIDAY_START});
      assert.equal((await checkout(request({edition: 'gold', organic_post_id: post}))).status, 200);
      assert.equal(stripe.params.metadata.campaign, BLACK_FRIDAY);
      assert.equal(stripe.params.metadata.organic_post_id, post);
      assert.equal(new URL(stripe.params.cancel_url).searchParams.get('trb_post'), post);
      assert.equal(stripe.params.payment_intent_data.metadata.organic_post_id, post);
    } else {
      stripe.current = {id: sessionId, livemode: true, payment_status: 'unpaid', status: 'open', mode: 'payment',
        currency: 'eur', amount_total: 49900, payment_link: goldLink, client_reference_id: 'trb_org_' + profile};
    }
    const returned = () => access(request({session_id: sessionId, organic_post_id: 'forged'}));
    stripe.current.status = 'complete';
    assert.equal((await returned()).status, 202);
    await notify(webhook, stripe.current);
    assert.equal(db.tables[edition].length, 0);
    stripe.current.payment_status = 'paid';
    if (returnFirst) assert.equal((await returned()).status, 200);
    else assert.equal(await notify(webhook, stripe.current, 'checkout.session.async_payment_succeeded'), 200);
    const [row] = db.tables[edition], proof = row.organic_verified_at, accessToken = row.access_token;
    assert.ok(Date.parse(proof));
    await notify(webhook, stripe.current, 'checkout.session.async_payment_succeeded');
    assert.equal((await returned()).status, 200);
    assert.equal(row.organic_verified_at, proof);
    assert.equal(row.organic_post_id, isOffer ? post : profile);
    assert.equal(row.access_token, accessToken);
    assert.equal(db.tables[edition].length, 1);
    row.status = 'refunded';
    await notify(webhook, stripe.current);
    assert.equal(row.status, 'refunded');
  }
});

test('Payment Link attribution accepts only the reserved reference; BF trusts only checkout metadata', () => {
  for (const ref of ['other', post, 'trb_org_arbitrary', {}, null]) {
    assert.deepEqual(editionOrganicFields({payment_link: goldLink, client_reference_id: ref, metadata: {organic_post_id: post}}, 'now'), {});
  }
  assert.deepEqual(editionOrganicFields({client_reference_id:'trb_org_' + post, metadata: {}}, 'now'), {});
});

test('only rejected attribution fields can retry the same order write without its optional fields', async () => {
  const columns = {organic_post_id: post, organic_verified_at: 'verified'};
  for (const [error, retry] of [
    [{code: 'PGRST204', message: 'missing organic_post_id in schema cache'}, true],
    [{code: '42703', message: 'column "organic_verified_at" does not exist'}, true],
    [{code: '23503', message: 'violates "rich_edition_orders_organic_post_id_fkey"'}, true],
    [{code: '23503', message: 'violates "other_organic_post_id_fkey"'}, false],
    [{code: 'XX000', message: 'connection lost'}, false],
  ]) {
    const attempts = [];
    const result = await writeOrganicOrder(edition, columns, async fields => {
      attempts.push(fields);
      return {error: attempts.length === 1 ? error : null};
    });
    assert.deepEqual(attempts, retry ? [columns, {}] : [columns]);
    assert.deepEqual(result.error, retry ? null : error);
  }
});
