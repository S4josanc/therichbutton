import { BLACK_FRIDAY, LIST_CENTS, quotePrice } from '../_shared/black-friday.mjs';

const PAYMENT_LINKS = new Map([
  ['plink_1Uc13YLqa85X23XWz0MWwicl', 'gold'],
  ['plink_1Uc15QLqa85X23XWoPHuBvGf', 'platinum'],
  ['plink_1Uc16lLqa85X23XWZ2ewpcpd', 'diamond'],
]);

export function matchEditionPrice(session) {
  if (session?.livemode !== true || session.mode !== 'payment' || session.currency !== 'eur') return null;

  const link = typeof session.payment_link === 'string' ? session.payment_link : session.payment_link?.id;
  if (session.payment_link != null) {
    const edition = PAYMENT_LINKS.get(link);
    return edition && session.amount_total === LIST_CENTS[edition] ? { edition, cents: session.amount_total } : null;
  }

  const { product, edition, campaign } = session.metadata || {};
  if (product !== 'rich-edition' || campaign !== BLACK_FRIDAY ||
      !['gold', 'platinum', 'diamond'].includes(edition)) return null;
  const quote = quotePrice(edition, session.created);
  return quote.campaign === campaign && session.amount_total === quote.cents ? { edition, cents: session.amount_total } : null;
}

function validEditionSession(session) {
  return session?.status === 'complete' ? matchEditionPrice(session) : null;
}

export function validatePaidSession(session) {
  return session?.payment_status === 'paid' ? validEditionSession(session) : null;
}

export function createHandler({ stripe, db }) {
  const headers = { 'Access-Control-Allow-Origin': 'https://therichbutton.com', 'Access-Control-Allow-Headers': 'content-type,apikey', 'Access-Control-Allow-Methods': 'POST,OPTIONS', 'Cache-Control': 'no-store', 'Content-Type': 'application/json', 'Referrer-Policy': 'no-referrer' };
  const response = (body, status = 200) => new Response(JSON.stringify(body), { status, headers });
  return async req => {
    if (req.method === 'OPTIONS') return new Response(null, { headers });
    if (req.method !== 'POST' || req.headers.get('origin') !== 'https://therichbutton.com') return response({ error: 'Forbidden' }, 403);
    if (Number(req.headers.get('content-length') || 0) > 2048) return response({ error: 'Invalid request' }, 413);
    let payload; try { payload = await req.json(); } catch { return response({ error: 'Invalid request' }, 400); }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return response({ error: 'Invalid request' }, 400);
    try {
      if (typeof payload.token === 'string') {
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(payload.token)) return response({ error: 'Invalid link' }, 400);
        const found = await db.from('rich_edition_orders').select('edition,status,access_token').eq('access_token', payload.token).eq('status', 'paid').maybeSingle();
        if (found.error) throw Error('Lookup failed');
        if (!found.data) return response({ error: 'Access not found' }, 404);
        return response({ edition: found.data.edition, token: found.data.access_token });
      }
      const id = payload.session_id;
      if (typeof id !== 'string' || !/^cs_live_[A-Za-z0-9]{15,200}$/.test(id)) return response({ error: 'Invalid session' }, 400);
      const session = await stripe.checkout.sessions.retrieve(id);
      const product = validatePaidSession(session);
      if (session.id === id && validEditionSession(session) && session.payment_status === 'unpaid') return response({ status: 'pending' }, 202);
      if (!product || session.id !== id) return response({ error: 'Payment not confirmed' }, 409);
      let found = await db.from('rich_edition_orders').select('edition,status,access_token').eq('stripe_session_id', id).maybeSingle();
      if (found.error) throw Error('Lookup failed');
      if (!found.data) {
        const saved = await db.from('rich_edition_orders').insert({ edition: product.edition, amount_cents: product.cents, status: 'paid', stripe_session_id: id, stripe_payment_intent_id: typeof session.payment_intent === 'string' ? session.payment_intent : session.payment_intent?.id, paid_at: new Date().toISOString() });
        if (saved.error && saved.error.code !== '23505') throw Error('Save failed');
        found = await db.from('rich_edition_orders').select('edition,status,access_token').eq('stripe_session_id', id).maybeSingle();
      }
      if (found.error || !found.data || found.data.edition !== product.edition || found.data.status !== 'paid') throw Error('Order unavailable');
      return response({ edition: found.data.edition, token: found.data.access_token });
    } catch { return response({ error: 'Unable to confirm payment. Keep your Stripe receipt and contact support.' }, 503); }
  };
}
