const PRODUCTS = Object.freeze({
  plink_1Uc13YLqa85X23XWz0MWwicl: { edition: 'gold', cents: 49900 },
  plink_1Uc15QLqa85X23XWoPHuBvGf: { edition: 'platinum', cents: 199900 },
  plink_1Uc16lLqa85X23XWZ2ewpcpd: { edition: 'diamond', cents: 999900 },
});

function validEditionSession(session) {
  const link = typeof session?.payment_link === 'string' ? session.payment_link : session?.payment_link?.id;
  const product = PRODUCTS[link];
  if (!product || session.livemode !== true || session.mode !== 'payment' || session.status !== 'complete' ||
      session.currency !== 'eur' || session.amount_total !== product.cents) return null;
  return product;
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
