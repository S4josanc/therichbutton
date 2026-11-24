// Full-page DOM integration, with no browser or network access.
// Install linkedom@0.18.12 in your test environment, then run:
// node --test supabase/tests/campaign-e2e.mjs
// CAMPAIGN_TEST_DOM_MODULE may alternatively point to the pinned worker.js ESM bundle.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { webcrypto } from 'node:crypto';
import vm from 'node:vm';
import test from 'node:test';

const { parseHTML } = await import(process.env.CAMPAIGN_TEST_DOM_MODULE || 'linkedom/worker');
const siteRoot = new URL('../../', import.meta.url);
const origin = 'https://therichbutton.com';
const mockStripe = 'https://checkout.stripe.com/c/pay/mock-only';
const ad = 'vault-v1-los-angeles';
const tags = 'utm_source=meta&utm_medium=paid_social&utm_campaign=christmas_2026&utm_content=' + ad + '&utm_term=los-angeles';
const settle = () => new Promise(resolve => setImmediate(resolve));

function render(url, { failedCheckout = false, offerActive = false, staleGiftQuote = false } = {}) {
  const location = new URL(url, origin);
  assert.equal(location.origin, origin);
  const name = location.pathname.slice(1) || 'index.html';
  assert.ok(['index.html', 'gift.html', 'rich-gift.html', 'open-gift.html'].includes(name));
  const { document, window: dom } = parseHTML(fs.readFileSync(new URL(name, siteRoot), 'utf8'));
  const events = [], checkouts = [], redirects = [];
  location.assign = location.replace = target => { redirects.push(target); };
  // Supply the browser properties required by the real purchase and gift handlers.
  for (const input of document.querySelectorAll('input')) input.checked = input.hasAttribute('checked');
  for (const select of document.querySelectorAll('select')) {
    Object.defineProperty(select, 'value', { writable: true, value: select.querySelector('option[selected], option')?.value });
  }
  const session = new Map();
  const context = vm.createContext({
    document, location, URL, URLSearchParams, CustomEvent: dom.CustomEvent, Event: dom.Event,
    AbortSignal, crypto: webcrypto, navigator: { userAgent: 'offline-test' }, matchMedia: () => ({ matches: true }),
    sessionStorage: { setItem(k,v) { session.set(k,v); }, getItem(k) { return session.get(k) ?? null; } },
    innerHeight: 1000, addEventListener() {}, setTimeout() {}, clearTimeout() {},
    fetch: async (input, options = {}) => {
      const endpoint = new URL(input).pathname.split('/').pop();
      if (endpoint === 'rich-edition-checkout') {
        if (options.method === 'POST') {
          checkouts.push({endpoint, payload:JSON.parse(options.body)});
          return Response.json({checkout_url:mockStripe});
        }
        return Response.json({active:offerActive, starts_at:'2026-11-26T23:00:00Z', ends_at:'2026-11-27T23:00:00Z',
          server_time:offerActive ? '2026-11-27T10:00:00Z' : '2026-11-24T10:00:00Z',
          prices:offerActive ? {'rich-gift':2450,gold:24950,platinum:99950,diamond:499950} : {'rich-gift':4900,gold:49900,platinum:199900,diamond:999900}
        });
      }
      if (endpoint === 'rich-analytics') {
        events.push(JSON.parse(options.body));
        return new Response(null, { status: 204 });
      }
      if (['rich-gift-checkout','rich-gift-test-checkout'].includes(endpoint)) {
        checkouts.push({ endpoint, payload: JSON.parse(options.body) });
        if (staleGiftQuote) { offerActive = false; return Response.json({code:'price_changed'}, {status:409}); }
        return failedCheckout ? Response.json({ error: 'Fixture failure' }, { status: 503 }) : Response.json({ checkout_url: mockStripe });
      }
      if (endpoint === 'rich-gift-redeem') return Response.json({ verified: true, paid: true, tier: 'rich-gift', name: 'Fixture recipient' });
      return Response.json({ error: 'Unavailable in this fixture' }, { status: 503 });
    }
  });
  context.window = context;
  // Ignore decorative homepage scripts. On other pages execute every local script.
  // Run deferred scripts after inline scripts, as a browser does.
  const scripts = [...document.querySelectorAll('script')].filter(script => name !== 'index.html' ||
    ['campaign.js','shop-offer.js'].includes(script.getAttribute('src')?.split('?')[0]) || script.textContent.includes('/rich-analytics'));
  scripts.sort((a,b) => Number(a.hasAttribute('defer')) - Number(b.hasAttribute('defer')));
  for (const script of scripts) {
    const src = script.getAttribute('src');
    let source = script.textContent;
    if (src) {
      const asset = new URL(src, location);
      assert.equal(asset.origin, origin);
      assert.ok(['/campaign.js','/shop-offer.js'].includes(asset.pathname));
      source = fs.readFileSync(new URL(asset.pathname.slice(1), siteRoot), 'utf8');
    }
    vm.runInContext(source, context, { filename: src || name });
  }
  function link(selector) {
    const anchor = document.querySelector(selector);
    assert.ok(anchor, 'Missing link: ' + selector);
    return new URL(anchor.getAttribute('href'), location).href;
  }
  async function submit() {
    document.querySelector('#name').value = 'Fixture recipient';
    document.querySelector('#buyRichGift').click();
    await settle();
  }
  return { document, events, checkouts, redirects, link, submit };
}

test('tagged home → gift explainer → checkout, without leaking the full URL or a personal value', async () => {
  const home = render('/?' + tags + '&fbclid=mock-click&email=mock-personal-value');
  assert.deepEqual(home.events, [{ event: 'page_view', page: 'home', campaign_ad: ad }]);
  for (const a of home.document.querySelectorAll('a[href*="buy.stripe.com"], a[href*="admin.html"], a[href*="vault.html"]')) {
    assert.equal(new URL(a.href, origin).searchParams.has('trb_ad'), false);
  }
  const explainerUrl = home.link('.gift-feature__link');
  assert.equal(explainerUrl, origin + '/rich-gift.html?trb_ad=' + ad);
  const explainer = render(explainerUrl);
  assert.deepEqual(explainer.events, []);
  const giftUrl = explainer.link('a.button[href*="gift.html?tier="]');
  assert.equal(giftUrl, origin + '/gift.html?tier=rich-gift&trb_ad=' + ad);
  const gift = render(giftUrl);
  await gift.submit();
  assert.deepEqual(gift.checkouts, [{ endpoint: 'rich-gift-checkout', payload: {
    recipient: 'Fixture recipient', sender: '', message: '', expected_amount_cents:4900, campaign_ad: ad, wall_opt_in: false, wall_alias: null
  } }]);
  assert.deepEqual(gift.redirects, [mockStripe]);
  assert.deepEqual(gift.events, []);
});

test('an ordinary visit and its checkout have no ad association', async () => {
  const home = render('/');
  assert.deepEqual(home.events, [{ event: 'page_view', page: 'home' }]);
  const url = home.link('.hero__gift-cta');
  assert.equal(url, origin + '/gift.html?tier=rich-gift');
  const gift = render(url);
  await gift.submit();
  assert.equal(gift.checkouts.length, 1);
  assert.equal(Object.hasOwn(gift.checkouts[0].payload, 'campaign_ad'), false);
  assert.deepEqual(gift.redirects, [mockStripe]);
});

test('private and ambiguous landing URLs leave events and purchase links untagged', () => {
  for (const suffix of ['&gift_token=mock-private', '&utm_term=london', '&order=mock-private', '#gift=mock-private']) {
    const home = render('/?' + tags + suffix);
    assert.equal(new URL(home.link('.hero__gift-cta')).searchParams.has('trb_ad'), false);
    assert.deepEqual(home.events, [{ event: 'page_view', page: 'home' }]);
  }
});

test('a verified private gift still reports its existing open and reveal without campaign fields', async () => {
  const token = '00000000-0000-4000-8000-000000000001';
  const gift = render('/open-gift.html?gift_token=' + token + '&' + tags);
  await settle();
  gift.document.querySelector('#envelope').click();
  assert.deepEqual(gift.events, [
    { event: 'page_view', page: 'open-gift' },
    { event: 'gift_open', page: 'open-gift', kind: 'paid', id: token },
    { event: 'gift_reveal', page: 'open-gift', kind: 'paid', id: token }
  ]);
  assert.deepEqual(gift.checkouts, []);
});

test('a failed checkout after cancellation remains retryable without a purchase event', async () => {
  const gift = render('/gift.html?tier=rich-gift&checkout=cancelled&trb_ad=' + ad, { failedCheckout: true });
  assert.match(gift.document.querySelector('#checkoutNote').textContent, /closed/i);
  await gift.submit();
  assert.equal(gift.checkouts[0].payload.campaign_ad, ad);
  assert.match(gift.document.querySelector('#checkoutNote').textContent, /could not confirm/i);
  assert.equal(gift.document.querySelector('#buyRichGift').disabled, false);
  assert.deepEqual(gift.redirects, []);
  assert.deepEqual(gift.events, []);
});

test('the direct gift CTA keeps the tag but an incomplete form never starts checkout', async () => {
  const home = render('/?' + tags);
  const gift = render(home.link('.hero__gift-cta'));
  gift.document.querySelector('#buyRichGift').click();
  await settle();
  assert.deepEqual(gift.checkouts, []);
  assert.match(gift.document.querySelector('#checkoutNote').textContent, /enter the recipient/i);
  await gift.submit();
  assert.equal(gift.checkouts[0].payload.campaign_ad, ad);
});

test('Black Friday displays verified prices on the three purchase pages and sends the quoted Gift amount', async () => {
  const home = render('/', {offerActive:true});
  const overview = render('/rich-gift.html', {offerActive:true});
  const gift = render('/gift.html?tier=rich-gift', {offerActive:true});
  await settle();
  for (const page of [home,overview,gift]) assert.equal(page.document.querySelector('[data-bf-banner]').hidden,false);
  assert.equal(overview.document.querySelector('.price ins').textContent, '€24.50');
  assert.deepEqual([...home.document.querySelectorAll('.tier__price ins')].map(x=>x.textContent), ['€249.50','€999.50','€4,999.50']);
  assert.match(gift.document.querySelector('#buyRichGift').textContent,/€24.50/);
  await gift.submit();
  assert.equal(gift.checkouts[0].payload.expected_amount_cents,2450);
});

test('a stale Black Friday Gift price restores the current quote and retains the dedication', async () => {
  const gift = render('/gift.html?tier=rich-gift', {offerActive:true,staleGiftQuote:true});
  await settle();
  gift.document.querySelector('#message').value='You asked for nothing.';
  await gift.submit();
  assert.deepEqual(gift.redirects,[]);
  assert.match(gift.document.querySelector('#checkoutNote').textContent,/price has changed/i);
  assert.match(gift.document.querySelector('#buyRichGift').textContent,/€49/);
  assert.equal(gift.document.querySelector('#message').value,'You asked for nothing.');
});

test('the promotional edition CTA uses the selected product and an idempotency key while the regular URL remains available outside the offer', async () => {
  const gift = render('/gift.html?tier=platinum', {offerActive:true});
  await settle();
  const tier = gift.document.getElementById('tier');
  tier.value = 'diamond';
  tier.dispatchEvent(new gift.document.defaultView.Event('change'));
  assert.match(gift.document.getElementById('editionPurchaseLink').textContent, /4,999\.50/);
  assert.equal(gift.link('#editionPurchaseLink'),origin + '/gift.html?tier=diamond#editionCheckoutBox');
  gift.document.getElementById('editionPurchaseLink').click();
  await settle();
  assert.equal(gift.checkouts[0].endpoint,'rich-edition-checkout');
  assert.equal(gift.checkouts[0].payload.edition,'diamond');
  assert.match(gift.checkouts[0].payload.request_id,/^[0-9a-f-]{36}$/);
  assert.deepEqual(gift.redirects,[mockStripe]);
  const regular = render('/gift.html?tier=gold');
  await settle();
  assert.equal(regular.link('#editionPurchaseLink'),'https://buy.stripe.com/9B67sMabl99RcJV4IR9AA0n');
  assert.equal(regular.document.querySelector('[data-bf-banner]').hidden,true);
});
