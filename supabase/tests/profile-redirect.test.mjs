import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const html = readFileSync(new URL('../../profile.html', import.meta.url), 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
const origin = 'https://therichbutton.com';
const sources = ['instagram', 'tiktok', 'youtube'];

function route(query, time) {
  const incoming = new URL('/profile.html' + query, origin);
  const redirects = [];
  vm.runInNewContext(script, {
    URLSearchParams,
    Date: class extends Date { static now() { return Date.parse(time); } },
    location: {
      search: incoming.search,
      replace(path) { redirects.push(new URL(path, incoming).href); },
    },
  });
  assert.equal(redirects.length, 1);
  return redirects[0];
}

function profileDestination(source, campaign, page = '/rich-gift.html') {
  const tags = new URLSearchParams({
    utm_source: source, utm_medium: 'organic_social', utm_campaign: campaign, utm_content: 'profile',
  });
  return origin + page + '?' + tags;
}

const boundaries = [
  ['2026-11-26T22:59:59.999Z', 'evergreen'],
  ['2026-11-26T23:00:00.000Z', 'black_friday_2026'],
  ['2026-11-27T22:59:59.999Z', 'black_friday_2026'],
  ['2026-11-27T23:00:00.000Z', 'evergreen'],
  ['2026-12-04T22:59:59.999Z', 'evergreen'],
  ['2026-12-04T23:00:00.000Z', 'christmas_2026'],
  ['2026-12-24T22:59:59.999Z', 'christmas_2026'],
  ['2026-12-24T23:00:00.000Z', 'evergreen'],
];
for (const [time, campaign] of boundaries) {
  test(`all three profiles open the current Gift offer at ${time}`, () => {
    for (const source of sources) {
      assert.equal(route('?source=' + source, time), profileDestination(source, campaign));
      assert.equal(route('?source=' + source + '&focus=collection', time), profileDestination(source, campaign, '/'));
    }
  });
}

test('missing, unknown and duplicate sources lead to the untagged home page', () => {
  const queries = ['', '?source=', '?source=facebook', '?source=Instagram', '?source=__proto__',
    '?source=instagram&source=instagram', '?source=instagram&source=youtube',
    '?utm_source=tiktok', '?source=https%3A%2F%2Fexample.org'];
  for (const query of queries) {
    for (const time of ['2026-11-27T12:00Z', '2026-12-12T12:00Z']) {
      assert.equal(route(query, time), origin + '/');
    }
  }
});

test('unknown or duplicate focus values and external parameters cannot change the Gift destination', () => {
  const extra = '&utm_campaign=other&utm_source=fake&trb_post=private&fbclid=x' +
    '&focus=collection&focus=outside&next=https%3A%2F%2Fexample.org&gift_token=private#not-forwarded';
  for (const source of sources) {
    for (const [time, campaign] of boundaries) {
      assert.equal(route('?source=' + source + extra, time), profileDestination(source, campaign));
    }
  }
});

test('the redirect page has no external dependencies or referrer and offers static Gift and collection destinations', () => {
  assert.equal((html.match(/<script\b/gi) || []).length, 1);
  assert.equal((html.match(/<link\b/gi) || []).length, 1);
  assert.match(html, /<link rel="icon" href="data:,">/);
  assert.doesNotMatch(html, /\bsrc\s*=/i);
  assert.match(html, /name="referrer" content="no-referrer"/);
  assert.match(html, /default-src 'none'/);
  assert.match(html, /<a href="\/rich-gift\.html">Explore The Rich Gift<\/a>/);
  assert.match(html, /<a href="\/">View the full collection<\/a>/);
});
