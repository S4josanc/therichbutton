import assert from 'node:assert/strict';
import test from 'node:test';
import { cardDetails, enablePaidChristmasCard } from '../../christmas-card-link.mjs';

const origin = 'https://therichbutton.com';
const token = '00000000-0000-4000-8000-000000000001';
const url = origin + '/open-gift.html?gift_token=' + token;
const gift = {
  status: 'paid', recipient: ' Alex ', sender: ' José ', message: ' Merry Christmas! ',
  gift_url: url, access_token: 'private-order', stripe_checkout_session_id: 'cs_private'
};

test('a Christmas card carries only recipient details and the original paid gift URL', () => {
  assert.deepEqual(cardDetails(gift), {
    recipient: 'Alex', sender: 'José', message: 'Merry Christmas!', gift_url: url
  });
  for (const invalid of [
    origin + '/gift.html?order=' + token,
    origin + '/gift.html?order=' + token + '&session_id=cs_private',
    url + '&session_id=cs_private', url + '#other', url.replace('https:', 'http:'),
    url.replace('therichbutton.com', 'other.invalid'), url.replace('gift_token', 'complimentary'),
    url.replace(token, 'invalid')
  ]) {
    assert.equal(cardDetails({ ...gift, gift_url: invalid }), null);
  }
  assert.equal(cardDetails({ ...gift, recipient: ' ' }), null);
});

test('the print action requires paid status and a valid recipient link', () => {
  for (const overrides of [{status:'pending'}, {status:'refunded'}, {gift_url:''}]) {
    const button = {hidden: true};
    enablePaidChristmasCard(button, {}, {...gift, ...overrides});
    assert.equal(button.hidden, true);
    assert.equal(button.onclick, undefined);
  }
  const button = {hidden: true};
  enablePaidChristmasCard(button, {}, gift);
  assert.equal(button.hidden, false);
  assert.equal(typeof button.onclick, 'function');
});

test('only the same-origin print tab can receive the card, with no secrets in its address', t => {
  const sent = [];
  const child = { postMessage: (...args) => sent.push(args) };
  const listeners = new Map();
  const fakeWindow = {
    open(path, target) {
      assert.equal(path, 'christmas-card.html');
      assert.equal(target, '_blank');
      return child;
    },
    addEventListener(type, fn) { listeners.set(type, fn); },
    removeEventListener(type, fn) { if (listeners.get(type) === fn) listeners.delete(type); }
  };
  globalThis.window = fakeWindow;
  globalThis.location = {origin};
  t.after(() => { delete globalThis.window; delete globalThis.location; });
  const button = {hidden: true};
  enablePaidChristmasCard(button, {}, gift);
  button.onclick();
  const ready = listeners.get('message');
  const event = {origin, source: child, data: 'rich-christmas-card-ready'};
  ready({...event, origin: 'https://other.invalid'});
  ready({...event, source: {}});
  ready({...event, data: 'different'});
  assert.deepEqual(sent, []);
  ready(event);
  assert.deepEqual(sent, [[{type:'rich-christmas-card', gift:cardDetails(gift)}, origin]]);
  assert.equal(listeners.size, 0);
});
