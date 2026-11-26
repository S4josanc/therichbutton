import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { approvedAd } from '../functions/_shared/campaign-ad.mjs';

const read = name => readFileSync(new URL('../../' + name, import.meta.url), 'utf8');
const campaign = read('campaign.js');
const home = read('index.html');
const gift = read('gift.html');
const overview = read('rich-gift.html');
const cityNames = ['miami', 'new-york', 'los-angeles', 'dubai', 'london'];
const base = 'https://therichbutton.com';
const sampleAnchors = html => [...html.matchAll(/<a\b[^>]*?\bhref="([^"]+)"/gi)].map(match => match[1]);
function tag(city) {
  return new URLSearchParams({utm_source:'meta', utm_medium:'paid_social', utm_campaign:'christmas_2026',
    utm_content:'vault-v1-' + city, utm_term:city});
}

function runPage(path, hrefs = [], loadScript = true) {
  const href = new URL(path, base).href;
  const window = { location:{href} };
  const anchors = hrefs.map(link => ({href:new URL(link, href).href}));
  const requests = [];
  const context = {window, URL, URLSearchParams, document:{querySelectorAll:() => anchors,getElementById:() => null},
    fetch:(url, options) => { requests.push({url, ...options});return Promise.resolve(); }};
  if (loadScript) vm.runInNewContext(campaign, context);
  if (['/', '/index.html'].includes(new URL(href).pathname)) {
    const track = home.match(/<script>(const richTrack=[\s\S]+?)<\/script>/)[1];
    vm.runInNewContext(track, context);
  }
  return {window, requests, links:anchors.map(anchor => anchor.href)};
}

// Execute the live checkout request body from gift.html with fictional form values.
function checkoutBody(page, test = false) {
  const expr = gift.match(/body:JSON\.stringify\((\{recipient,sender,message:dedication,[^}]+\})\)/)[1];
  const context = {window:page.window, RICH_GIFT_TEST_MODE:test, wantsRecovery:false, recipient:'Test recipient', sender:'Test sender',
    dedication:'Test message', wallOptIn:{checked:false}, wallAlias:{value:''}};
  return JSON.parse(vm.runInNewContext('JSON.stringify(' + expr + ')', context));
}

test('each tagged landing records one existing page view with one public ad code', () => {
  for (const city of cityNames) {
    const {requests} = runPage('/?' + tag(city) + '&fbclid=discard-me&extra=also-ignored');
    assert.equal(requests.length, 1);
    assert.equal(new URL(requests[0].url).pathname, '/functions/v1/rich-analytics');
    assert.deepEqual(JSON.parse(requests[0].body), {event:'page_view',page:'home',campaign_ad:'vault-v1-' + city});
  }
});

test('every published CSV destination resolves to its own browser, edge and database ad label', () => {
  const entries = read('campaigns/christmas-2026.csv').trim().split('\n').slice(1);
  const catalogueSQL = read('supabase/sql/campaign-attribution.sql') + '\n' + read('supabase/sql/christmas-2026-cities.sql');
  const seen = new Set();
  for (const entry of entries) {
    const [campaignName, ad, city, destination] = entry.split(',');
    const url = new URL(destination);
    assert.equal(url.origin, base);
    assert.equal(url.pathname, '/');
    assert.equal(url.searchParams.get('utm_campaign'), campaignName);
    assert.equal(url.searchParams.get('utm_content'), ad);
    assert.equal(url.searchParams.get('utm_term'), city.toLowerCase().replaceAll(' ', '-'));
    assert.equal(url.searchParams.size, 5);
    const request = runPage(url.pathname + url.search).requests[0];
    assert.equal(JSON.parse(request.body).campaign_ad, ad);
    assert.equal(approvedAd(ad), ad);
    assert.ok(catalogueSQL.includes(`('${ad}', 'meta', 'paid_social', '${campaignName}', 'Vault Reveal v1', '${city}')`));
    seen.add(ad);
  }
  assert.equal(entries.length, 5);
  assert.equal(seen.size, entries.length);
});

test('organic, incomplete, duplicate, unknown, mismatched, test and private entries keep the old payload', () => {
  const bad = ['', 'trb_ad=vault-v1-dubai', 'utm_campaign=christmas_2026',
    tag('miami') + '&utm_source=meta', tag('london') + '&utm_content=vault-v1-london', tag('paris').toString(),
    tag('singapore').toString(), tag('sydney').toString(),
    tag('dubai').toString().replace('utm_term=dubai','utm_term=miami'), tag('dubai') + '&order=test-token',
    tag('dubai') + '&stripe_test=1', tag('miami') + '#gift=private',
    tag('miami') + '&referral=test-ref', tag('miami') + '&referral_kind=paid',
    tag('dubai').toString().replace('vault-v1-dubai','person%40example.com')];
  for (const query of bad) {
    const result = runPage('/?' + query, ['gift.html?tier=rich-gift']);
    assert.deepEqual(JSON.parse(result.requests[0].body), {event:'page_view',page:'home'});
    assert.equal(result.links[0], base + '/gift.html?tier=rich-gift');
  }
});

test('all three direct and both indirect Rich Gift CTAs carry the code; unrelated links and tiers are untouched', () => {
  const anchors = sampleAnchors(home);
  const {links} = runPage('/?' + tag('dubai') + '&fbclid=discard-me', anchors);
  assert.equal(anchors.filter(link => link === 'gift.html?tier=rich-gift').length, 3);
  assert.equal(anchors.filter(link => link === 'rich-gift.html').length, 2);
  for (const [i, original] of anchors.entries()) {
    // Fragment-only links resolve against the incoming page URL.
    const expected = new URL(original, base + '/?' + tag('dubai') + '&fbclid=discard-me');
    if (['gift.html?tier=rich-gift','rich-gift.html'].includes(original)) expected.searchParams.set('trb_ad','vault-v1-dubai');
    assert.equal(links[i],expected.href);
  }
  const overviewLinks = runPage('/rich-gift.html?trb_ad=vault-v1-dubai',sampleAnchors(overview)).links;
  assert.ok(overviewLinks.includes(base + '/gift.html?tier=rich-gift&trb_ad=vault-v1-dubai'));
  assert.ok(overviewLinks.includes(base + '/rich-gift-button.html'));
});

test('no ad code crosses origins, goes into a gift, or overrides a checkout or referral link', () => {
  const sensitive = ['https://example.com/gift.html?tier=rich-gift','gift.html?e=r&n=Test',
    'gift.html?tier=rich-gift&referral_token=fake', 'gift.html?tier=rich-gift&order=token',
    'gift.html?tier=rich-gift&stripe_test=1', 'gift.html#gift=token',
    'open-gift.html?complimentary=token','gift-delivery.html?order=token','mailto:example@example.org'];
  const tagged = runPage('/?' + tag('miami'), sensitive);
  assert.deepEqual(tagged.links, sensitive.map(link => new URL(link, base).href));
});

test('paid gift checkout carries the allowed code including after cancellation; test and private flows omit it', () => {
  const regular = '/gift.html?tier=rich-gift&trb_ad=vault-v1-new-york';
  const bare = checkoutBody(runPage('/gift.html'));
  assert.deepEqual(bare, {recipient:'Test recipient',sender:'Test sender',message:'Test message',wall_opt_in:false,wall_alias:null});
  for (const suffix of ['', '&checkout=cancelled']) {
    assert.deepEqual(checkoutBody(runPage(regular + suffix)), {...bare,campaign_ad:'vault-v1-new-york'});
  }
  for (const suffix of ['&order=token','&referral_kind=paid','&stripe_test=1','&trb_ad=vault-v1-miami',
    '&complimentary=token','&session_id=fake','#gift=token', '&checkout=success']) {
    assert.deepEqual(checkoutBody(runPage(regular + suffix)), bare);
  }
  assert.deepEqual(checkoutBody(runPage(regular),true),bare);
  assert.deepEqual(checkoutBody(runPage('/gift.html?tier=gold&trb_ad=vault-v1-miami')),bare);
  assert.deepEqual(checkoutBody(runPage('/gift.html?trb_ad=person%40example.com')),bare);
});

test('if campaign.js fails to load, both existing request bodies still work', () => {
  const requests = runPage('/?' + tag('miami'), [], false).requests;
  assert.deepEqual(JSON.parse(requests[0].body), {event:'page_view',page:'home'});
  assert.ok(!('campaign_ad' in checkoutBody(runPage('/gift.html?trb_ad=vault-v1-miami', [], false))));
});

test('buyer pages suppress the referrer on the campaign script; recipient and delivery pages omit it', () => {
  for (const html of [home, overview, gift]) {
    assert.match(html, /<script src="campaign\.js" referrerpolicy="no-referrer"/);
  }
  for (const name of ['open-gift.html','gift-delivery.html','print-gift.html']) {
    assert.ok(!read(name).includes('campaign.js'), name);
  }
});
