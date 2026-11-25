import { BLACK_FRIDAY_START, BLACK_FRIDAY_END, LIST_CENTS, isBlackFriday, quotePrice } from '../_shared/black-friday.mjs';

import { approvedOrganicPost } from '../_shared/campaign-ad.mjs';
import { PUBLIC_API_KEY, SITE_ORIGIN as ORIGIN } from '../_shared/throne-core.mjs';
const HEADERS = {
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store',
  'Access-Control-Allow-Origin': ORIGIN,
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'content-type, apikey',
};
const names = new Map([['gold', 'Gold'], ['platinum', 'Platinum'], ['diamond', 'Diamond']]);
const respond = (body, status = 200) => Response.json(body, { headers: HEADERS, status });
const closed = () => respond({ code: 'offer_closed', error: 'The Black Friday offer is not active. Refresh the page to see current prices.' }, 409);
const iso = seconds => new Date(seconds * 1000).toISOString();

export function createEditionCheckoutHandler({ stripe, now = () => Math.floor(Date.now() / 1000) }) {
  return async request => {
    const seconds = now();
    if (request.method === 'OPTIONS') return new Response(null, { headers: HEADERS });
    if (request.method === 'GET') {
      if (isBlackFriday(seconds) && !stripe) return respond({ error: 'Checkout is temporarily unavailable.' }, 503);
      if (isBlackFriday(seconds) && !stripe) return respond({ error: 'Pricing is temporarily unavailable.' }, 503);
      const prices = Object.fromEntries(Object.keys(LIST_CENTS).map(id => [id, quotePrice(id, seconds).cents]));
      return respond({
        active: isBlackFriday(seconds), server_time: iso(seconds), starts_at: iso(BLACK_FRIDAY_START),
        ends_at: iso(BLACK_FRIDAY_END), prices,
      });
    }
    if (request.method !== 'POST' || request.headers.get('origin') !== ORIGIN) return respond({ error: 'Forbidden' }, 403);
    if (request.headers.get('apikey') !== PUBLIC_API_KEY) return respond({ error: 'Public API key required.' }, 401);
    if (!isBlackFriday(seconds)) return closed();
    if (!stripe) return respond({ error: 'Checkout is temporarily unavailable.' }, 503);
    let body;
    try {
      const raw = await request.text();
      if (raw.length > 1024) return respond({ error: 'Invalid request' }, 413);
      body = JSON.parse(raw);
    } catch {
      return respond({ error: 'Invalid request' }, 400);
    }
    if (!names.has(body?.edition)) return respond({ error: 'Please choose a valid edition.' }, 400);
    if (body.request_id != null && (typeof body.request_id !== 'string' ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(body.request_id))) {
      return respond({ error: 'Invalid checkout attempt.' }, 400);
    }
    const edition = body.edition;
    const quote = quotePrice(edition, seconds);
    const organicPost = approvedOrganicPost(body.organic_post_id);
    const metadata = { product: 'rich-edition', edition, campaign: quote.campaign,
      ...(organicPost ? {organic_post_id: organicPost} : {}) };
    try {
      const session = await stripe.checkout.sessions.create({
        mode: 'payment', customer_creation: 'always', adaptive_pricing: { enabled: false },
        metadata, payment_intent_data: { metadata },
        line_items: [{
          quantity: 1, price_data: { currency: 'eur', unit_amount: quote.cents, tax_behavior: 'inclusive',
            product_data: { name: 'The Rich Button · ' + names.get(edition) + ' Edition (Black Friday)' } },
        }],
        success_url: ORIGIN + '/edition-access.html?session_id={CHECKOUT_SESSION_ID}',
        cancel_url: organicPost ? ORIGIN + '/gift.html?tier=' + edition + '&checkout=cancelled&trb_post=' + encodeURIComponent(organicPost) + '#editionCheckoutBox' : ORIGIN + '/#editions',
      }, body.request_id ? { idempotencyKey: quote.campaign + ':' + edition + ':' + body.request_id } : {});
      // Stripe timestamps the session. Discard one created on the other side of midnight.
      if (session.livemode !== true || !isBlackFriday(session.created) ||
          session.currency !== 'eur' || session.amount_total !== quote.cents) {
        if (session.status === 'open') await stripe.checkout.sessions.expire(session.id);
        return !isBlackFriday(session.created) ? closed() : respond({ error: 'Checkout could not verify the price.' }, 503);
      }
      if (session.status !== 'open' || !session.url) return respond({ error: 'Please start a new checkout.' }, 409);
      return respond({ checkout_url: session.url });
    } catch {
      return respond({ error: 'Checkout is temporarily unavailable. Please try again.' }, 503);
    }
  };
}
