import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import { approvedOrganicPost } from '../functions/_shared/campaign-ad.mjs';

const root = new URL('../../', import.meta.url);
const script = fs.readFileSync(new URL('campaign.js', root), 'utf8');
const links = fs.readFileSync(new URL('./fixtures/editorial-links.txt', import.meta.url), 'utf8').trim().split('\n');
const origin = 'https://therichbutton.com';
const post = 'pinterest_black_friday_2026_black-friday';
const pages = { '/': 'home', '/rich-gift.html': 'rich-gift', '/gift.html': 'gift',
  '/rich-gift-button.html': 'rich-gift-button', '/gold.html': 'gold', '/platinum.html': 'platinum', '/diamond.html': 'diamond' };

function visit(url, destinations = []) {
  const location = new URL(url, origin);
  const anchors = destinations.map(raw => ({href: new URL(raw, location).href, getAttribute: () => raw}));
  const events = [];
  let click;
  const document = { querySelectorAll: () => anchors, getElementById: () => null,
    addEventListener(type, listener) { if (type === 'click') click = listener; } };
  const window = {location};
  vm.runInNewContext(script, {window, document, URL, URLSearchParams, fetch(endpoint, options) {
    assert.equal(options.referrerPolicy, 'no-referrer');
    events.push(JSON.parse(options.body));
    return Promise.resolve();
  }});
  return {campaign: window.richCampaign, events, urls: anchors.map(link => link.href),
    clickEdition() { click?.({target: {closest: selector => selector === 'a[data-edition-pay]' ? {} : null}}); } };
}

test('all 105 editorial links and three shared profiles resolve to the same allowed label in browser and edge', () => {
  const labels = new Set();
  const pageNames = new Set();
  for (const url of links) {
    const {pathname, searchParams} = new URL(url);
    const id = ['utm_source', 'utm_campaign', 'utm_content'].map(key => searchParams.get(key)).join('_');
    const v = visit(url);
    assert.equal(v.campaign.organicPostId, id);
    assert.equal(approvedOrganicPost(id), id);
    assert.equal(v.campaign.checkoutAd, undefined);
    assert.deepEqual(v.events.filter(e => e.event === 'organic_landing'), [
      {event: 'organic_landing', page: pages[pathname], organic_post_id: id}]);
    labels.add(id);
    pageNames.add(pathname);
    const html = fs.readFileSync(new URL(pathname.slice(1) || 'index.html', root), 'utf8');
    assert.ok(html.includes('campaign.js'), pathname);
  }
  assert.equal(labels.size, 108);
  assert.equal(links.length, labels.size);
  assert.equal([...labels].filter(id => id.endsWith('_profile')).length, 3);
  assert.deepEqual(pageNames, new Set(Object.keys(pages)));
});

test('social bios are attributed only to their network and current campaign across the Gift journey', () => {
  for (const source of ['instagram', 'tiktok', 'youtube']) {
    for (const campaign of ['evergreen', 'black_friday_2026', 'christmas_2026']) {
      const id = [source, campaign, 'profile'].join('_');
      const query = new URLSearchParams({utm_source: source, utm_medium: 'organic_social',
        utm_campaign: campaign, utm_content: 'profile'});
      const landing = visit('/rich-gift.html?' + query, ['gift.html?tier=rich-gift']);
      assert.equal(approvedOrganicPost(id), id);
      assert.deepEqual(landing.events.filter(e => e.event === 'organic_landing'),
        [{event: 'organic_landing', page: 'rich-gift', organic_post_id: id}]);
      const form = visit(landing.urls[0]);
      assert.equal(form.campaign.organicPostId, id);
      assert.equal(form.events.some(e => e.event === 'organic_landing'), false);
    }
  }
});

test('public navigation carries one label, counts only tagged entrances, and never appends private values', () => {
  const stripe = 'https://buy.stripe.com/9B67sMabl99RcJV4IR9AA0n';
  const normal = ['./', 'gift.html?tier=gold', 'rich-gift.html', 'rich-gift-button.html'];
  const sensitive = ['https://example.com/gift.html', stripe + '?prefilled_email=test', 'https://buy.stripe.com/unlisted',
    'vault.html', 'open-gift.html', 'gift.html?referral=private', 'gift.html#gift_token=private', 'gift.html?stripe_test=1',
    'rich-gift-button.html?gift_token=private', 'gift.html?trb_ad=vault-v1-london', 'throne-checkout.html'];
  const v = visit(links[0] + '&fbclid=discard-private-id', [...normal, stripe, ...sensitive]);
  for (const href of v.urls.slice(0, normal.length)) {
    const url = new URL(href);
    assert.equal(url.searchParams.get('trb_post'), post);
    assert.ok(!href.includes('discard-private-id'));
    const next = visit(url.href);
    assert.equal(next.campaign.organicPostId, post);
    assert.ok(!next.events.some(e => e.event === 'organic_landing'));
  }
  assert.equal(v.urls[normal.length], stripe + '?client_reference_id=trb_org_' + post);
  for (const [i, value] of sensitive.entries()) assert.equal(v.urls[normal.length + 1 + i], value);
  const home = visit(v.urls[0]);
  home.clickEdition();
  home.clickEdition();
  assert.deepEqual(home.events, [{event:'organic_checkout_click',page:'home',organic_post_id:post}]);
});

test('duplicate, mixed, unknown and private attribution stays out of the organic funnel', () => {
  const organic = new URL(links[0]).search;
  for (const bad of [organic + '&utm_source=pinterest', organic + '&utm_term=london',
    organic + '&trb_ad=vault-v1-london', organic + '&trb_post=' + post, organic + '&access=private',
    organic + '&order=xxx', organic + '&session_id=xxx', organic + '#gift_token=private',
    organic + '#private', organic.replace('organic_social','paid_social'), organic.replace('pinterest','meta'),
    organic.replace('black-friday','day-04'), organic.replace('black-friday','profile'),
    '?trb_post=' + post + '&trb_post=' + post, '?trb_post=' + post + '&stripe_test=1']) {
    const v = visit('/gold.html' + bad);
    assert.equal(v.campaign.organicPostId, undefined, bad);
    assert.deepEqual(v.events, [], bad);
  }
  for (const invalid of ['', null, {}, 'pinterest_christmas_2026_profile','facebook_christmas_2026_profile',
    'pinterest_black_friday_2026_profile','facebook_evergreen_profile','tiktok_evergreen_black-friday',
    'instagram_evergreen_day-01', 'instagram_christmas_2026_day-00','tiktok_christmas_2026_day-21',
    'youtube_black_friday_2026_day-01','meta_christmas_2026_day-01',post + '-extra']) {
    assert.equal(approvedOrganicPost(invalid), null);
    assert.equal(visit('/?trb_post=' + encodeURIComponent(invalid)).campaign.organicPostId, undefined);
  }
});

test('only tagged public gift-button previews load capture; private or untagged pages make no campaign request', () => {
  const html = fs.readFileSync(new URL('rich-gift-button.html', root),'utf8');
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
  const gate = scripts.find(s => s.includes('function hasPrivateGiftLink')).split('  if (hasPrivateGiftLink())')[0];
  const loader = scripts.find(s => s.includes('campaignScript.src'));
  assert.ok(!/<script src="campaign\.js"/.test(html));
  const publicLink = links.find(url => new URL(url).pathname === '/rich-gift-button.html');
  for (const [url, number] of [[publicLink,1], [publicLink + '#gift_token=private',0],
    [publicLink + '&gift_token=private',0], ['/rich-gift-button.html',0]]) {
    const added = [];
    const context = {URLSearchParams,location: new URL(url,origin), document: {body:{append: el => added.push(el)}, createElement: () => ({})}};
    vm.runInNewContext(gate + loader,context);
    assert.deepEqual(added.map(el => [el.src,el.referrerPolicy]), number ? [['campaign.js','no-referrer']] : []);
  }
});
