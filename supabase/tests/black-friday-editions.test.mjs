import assert from 'node:assert/strict';
import test from 'node:test';
import { BLACK_FRIDAY, BLACK_FRIDAY_START as start, BLACK_FRIDAY_END as end, isBlackFriday, quotePrice } from '../functions/_shared/black-friday.mjs';
import { PUBLIC_API_KEY, SITE_ORIGIN } from '../functions/_shared/throne-core.mjs';
import { createEditionCheckoutHandler } from '../functions/rich-edition-checkout/handler.mjs';
import { createHandler, validatePaidSession, matchEditionPrice } from '../functions/rich-edition-access/handler.js';

const editions = [
  ['gold', 24950, 'plink_1Uc13YLqa85X23XWz0MWwicl'],
  ['platinum', 99950, 'plink_1Uc15QLqa85X23XWoPHuBvGf'],
  ['diamond', 499950, 'plink_1Uc16lLqa85X23XWZ2ewpcpd'],
];
const sessionId = 'cs_live_12345678901234567890';
const requestId = 'b52febe1-31f0-4b25-b796-2c76274d3af7';

function request(body, headers) {
  return new Request('https://api.example/functions/v1/rich-edition-checkout', { method: 'POST',
    headers: { 'content-type': 'application/json', origin: SITE_ORIGIN, apikey: PUBLIC_API_KEY, ...headers },
    body: JSON.stringify(body) });
}

function fixture(seconds, sessionOverrides = {}) {
  const created = [], expired = [];
  const sessions = {
    async create(params, options) {
      created.push({ params, options });
      return { id: sessionId, status: 'open', livemode: true, created: seconds,
        amount_total: params.line_items[0].price_data.unit_amount, currency: 'eur',
        url: 'https://checkout.stripe.com/c/pay/' + sessionId, ...sessionOverrides };
    },
    async expire(id) { expired.push(id); },
  };
  return { created, expired, handle: createEditionCheckoutHandler({ stripe: {checkout:{sessions}}, now: () => seconds }) };
}

test('the authoritative price changes at both Bratislava midnights, including gift', async () => {
  for (const [seconds,active] of [[start-1,false],[start,true],[end-1,true],[end,false]]) {
    const { handle } = fixture(seconds);
    const reply = await handle(new Request('https://api.example/status'));
    assert.equal(reply.headers.get('cache-control'), 'no-store');
    const state = await reply.json();
    assert.equal(state.active, active);
    assert.equal(state.server_time, new Date(seconds*1000).toISOString());
    assert.deepEqual(state.prices, Object.fromEntries([...editions,['rich-gift',2450]].map(([e,p]) => [e,active?p:p*2])));
    assert.equal(state.starts_at, '2026-11-26T23:00:00.000Z');
    assert.equal(state.ends_at, '2026-11-27T23:00:00.000Z');
  }
  assert.equal(isBlackFriday('1795720000'), false);
  assert.equal(quotePrice('rich-throne',start), null);
});

test('each discounted checkout charges and fulfills the exact EUR total even on later confirmation', async () => {
  for (const [edition,cents] of editions) {
    const { handle, created } = fixture(end-1);
    const res = await handle(request({ edition, request_id: requestId, amount_cents: 1, campaign: 'ignored' }));
    assert.equal(res.status, 200);
    assert.ok((await res.json()).checkout_url.startsWith('https://checkout.stripe.com/'));
    const {params,options} = created[0];
    assert.equal(options.idempotencyKey, BLACK_FRIDAY + ':' + edition + ':' + requestId);
    assert.equal(params.line_items.length, 1);
    assert.equal(params.line_items[0].quantity, 1);
    assert.equal(params.line_items[0].price_data.currency, 'eur');
    assert.equal(params.line_items[0].price_data.unit_amount, cents);
    assert.deepEqual(params.metadata, {product:'rich-edition',edition,campaign:BLACK_FRIDAY});
    assert.equal(params.adaptive_pricing.enabled, false);
    assert.equal(params.success_url,SITE_ORIGIN+'/edition-access.html?session_id={CHECKOUT_SESSION_ID}');
    const session = { id: sessionId, mode:'payment', payment_link:null, status:'complete', payment_status:'paid',
      livemode:true, currency:'eur', created:end-1, amount_total:cents, metadata:params.metadata, payment_intent:'pi_example' };
    assert.deepEqual(validatePaidSession(session), { edition, cents });
    // Exercise the return-page issuance path incl. re-use of the same access token.
    const rows = [];
    const db = {from: table => {
      assert.equal(table,'rich_edition_orders');
      return { select() {return this;}, eq() {return this;}, async maybeSingle() {return {data:rows[0]||null};},
        async insert(row) {rows.push({...row, access_token:requestId});return {};} };
    }};
    const issue = createHandler({db, stripe:{checkout:{sessions:{retrieve:async()=>session}}}});
    for(let n=0; n<2; n++) {
      const result = await issue(request({session_id:sessionId}));
      assert.equal(result.status,200);
      assert.deepEqual(await result.json(),{edition,token:requestId});
    }
    assert.equal(rows.length,1);
    assert.equal(rows[0].amount_cents,cents);
    for (const changes of [
      {created:start-1},{created:end},{currency:'usd'},{amount_total:cents+1},{amount_total:cents*2},
      {payment_link:'unrecognised'},{payment_link:{id:'unrecognised'}},{livemode:false},{status:'open'},
      {payment_status:'unpaid'},{metadata:{...params.metadata,product:'rich-gift'}},
      {metadata:{...params.metadata,campaign:'unknown'}},{metadata:{...params.metadata,edition:'rich-gift'}},
    ]) assert.equal(validatePaidSession({...session,...changes}),null,JSON.stringify(changes));
    assert.deepEqual(matchEditionPrice({...session,status:'open',payment_status:'unpaid'}),{edition,cents});
  }
});

test('existing Stripe Payment Links continue to validate at full price on and off the campaign date', () => {
  for (const [edition,half,link] of editions) {
    for (const created of [start-1,start,end]) {
      const base={livemode:true,mode:'payment',currency:'eur',status:'complete',payment_status:'paid',created,
        payment_link:{id:link},amount_total:half*2};
      assert.deepEqual(validatePaidSession(base),{edition,cents:half*2});
      assert.equal(validatePaidSession({...base,amount_total:half,metadata:{campaign:BLACK_FRIDAY,product:'rich-edition',edition}}),null);
    }
  }
});

test('checkout refuses invalid products, origins, public keys and closed offers; a session created at midnight is expired', async () => {
  for (const [seconds,body,headers,expected] of [
    [start-1,{edition:'gold'},{},409],[end,{edition:'diamond'},{},409],
    [start,{edition:'rich-throne'},{},400],[start,{edition:'gold',request_id:'x'},{},400],
    [start,{edition:'gold'},{origin:'https://unrelated.example'},403],[start,{edition:'gold'},{apikey:''},401],
  ]) {
    const f=fixture(seconds);
    const res=await f.handle(request(body,headers));
    assert.equal(res.status, expected);assert.equal(f.created.length,0);
  }
  for (const [override,expected] of [[{created:end},409],[{amount_total:49900},503],[{livemode:false},503]]) {
    const f=fixture(end-1,override);
    const res=await f.handle(request({edition:'gold'}));
    assert.equal(res.status,expected);assert.deepEqual(f.expired,[sessionId]);
  }
});
