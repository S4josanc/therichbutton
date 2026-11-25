import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const html = readFileSync(new URL('../../profile.html', import.meta.url), 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
const calendar = readFileSync(new URL('./fixtures/editorial-links.txt', import.meta.url), 'utf8')
  .trim().split('\n').map(line => new URL(line));
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

function calendarDestination(source, campaign) {
  if (!campaign) return origin + '/';
  const content = campaign === 'black_friday_2026' ? 'black-friday' : 'profile';
  const matches = calendar.filter(url =>
    url.searchParams.get('utm_source') === source &&
    url.searchParams.get('utm_campaign') === campaign &&
    url.searchParams.get('utm_content') === content);
  assert.equal(matches.length, 1);
  return matches[0].href;
}

const boundaries = [
  ['2026-11-26T22:59:59.999Z', null],
  ['2026-11-26T23:00:00.000Z', 'black_friday_2026'],
  ['2026-11-27T22:59:59.999Z', 'black_friday_2026'],
  ['2026-11-27T23:00:00.000Z', null],
  ['2026-12-04T22:59:59.999Z', null],
  ['2026-12-04T23:00:00.000Z', 'christmas_2026'],
  ['2026-12-24T22:59:59.999Z', 'christmas_2026'],
  ['2026-12-24T23:00:00.000Z', null],
];
for (const [time, campaign] of boundaries) {
  test(`all three profiles match the calendar at ${time}`, () => {
    for (const source of sources) {
      assert.equal(route('?source=' + source, time), calendarDestination(source, campaign));
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

test('only the validated source affects the destination', () => {
  const extra = '&utm_campaign=other&utm_source=fake&trb_post=private&fbclid=x' +
    '&next=https%3A%2F%2Fexample.org&gift_token=private#not-forwarded';
  for (const source of sources) {
    for (const [time, campaign] of boundaries) {
      assert.equal(route('?source=' + source + extra, time), calendarDestination(source, campaign));
    }
  }
});

test('the redirect page has no external dependencies or referrer and offers a neutral fallback', () => {
  assert.equal((html.match(/<script\b/gi) || []).length, 1);
  assert.equal((html.match(/<link\b/gi) || []).length, 1);
  assert.match(html, /<link rel="icon" href="data:,">/);
  assert.doesNotMatch(html, /\bsrc\s*=/i);
  assert.match(html, /name="referrer" content="no-referrer"/);
  assert.match(html, /default-src 'none'/);
  assert.match(html, /<a href="\/">Continue to The Rich Button<\/a>/);
});
