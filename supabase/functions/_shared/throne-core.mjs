export const STRIPE_VERSION = '2026-10-28.endive';
export const SITE_ORIGIN = 'https://therichbutton.com';
export const PUBLIC_API_KEY = 'sb_publishable_ciIqbUv4EV1yZgjelooxUw_V8jGdTBM';
export const PRODUCT = 'rich-throne';
export const TERMS_VERSION = 'richest-2026-11-17';
export const MINIMUM_INCREMENT_CENTS = 100;
export const MAX_AMOUNT_CENTS = 99_999_999;
export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const WEBHOOK_EVENTS = [
  'checkout.session.completed',
  'checkout.session.async_payment_succeeded',
  'checkout.session.async_payment_failed',
  'checkout.session.expired',
  'refund.updated',
  'refund.failed',
];

export class PublicError extends Error {
  constructor(message, status = 400, code = 'invalid_request', details = {}) {
    super(message);
    this.name = 'PublicError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function isUuid(value) {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

export function cleanLabel(value, max, label) {
  if (value == null || value === '') return null;
  if (typeof value !== 'string') throw new PublicError(`Please enter a valid ${label.toLowerCase()}.`);
  const normalized = value.normalize('NFC').trim();
  if (!normalized) return null;
  if ([...normalized].length > max || /[\u0000-\u001f\u007f]/u.test(normalized)) {
    throw new PublicError(`Please enter a valid ${label.toLowerCase()}.`);
  }
  return normalized;
}

export function validateCheckoutInput(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new PublicError('Invalid request.');
  if (body.accepted_terms !== true) throw new PublicError('Please accept the purchase terms.');
  if (!Number.isSafeInteger(body.amount_cents) || body.amount_cents < 10_100 || body.amount_cents > MAX_AMOUNT_CENTS) {
    throw new PublicError('Please enter a valid amount of at least €101.');
  }
  if (!isUuid(body.request_id)) throw new PublicError('Please refresh the page and try again.');
  return {
    request_id: body.request_id.toLowerCase(),
    amount_cents: body.amount_cents,
    display_name: cleanLabel(body.display_name, 60, 'Display name'),
    country: cleanLabel(body.country, 80, 'Country'),
  };
}

export function validateStatusInput(body) {
  if (!body || typeof body !== 'object' || !isUuid(body.order_token)) throw new PublicError('Invalid order link.');
  if (body.session_id != null && (typeof body.session_id !== 'string' || !/^cs_live_[A-Za-z0-9]+$/.test(body.session_id))) {
    throw new PublicError('Invalid payment session.');
  }
  return { order_token: body.order_token.toLowerCase(), session_id: body.session_id || null };
}

export function assertMinimum(amount, currentAmount) {
  if (!Number.isSafeInteger(currentAmount) || currentAmount < 10_000) {
    throw new PublicError('Purchases are temporarily unavailable.', 503, 'state_unavailable');
  }
  if (amount < currentAmount + MINIMUM_INCREMENT_CENTS) {
    throw new PublicError('The minimum has changed. Please choose a higher amount.', 409, 'minimum_changed', {
      next_minimum: (currentAmount + MINIMUM_INCREMENT_CENTS) / 100,
    });
  }
}

export function sessionPaymentIntentId(session) {
  return typeof session.payment_intent === 'string' ? session.payment_intent : session.payment_intent?.id;
}

export function assertSessionBelongsToOrder(session, order) {
  if (!session || !order || session.id !== order.stripe_checkout_session_id || session.livemode !== true ||
      session.mode !== 'payment' || session.client_reference_id !== order.id ||
      session.metadata?.product !== PRODUCT || session.metadata?.order_id !== order.id ||
      session.currency !== 'eur' || session.amount_total !== order.amount_cents) {
    throw new PublicError('This payment could not be verified.', 409, 'payment_mismatch');
  }
}

export function assertPaidSession(session, order) {
  assertSessionBelongsToOrder(session, order);
  if (session.status !== 'complete' || session.payment_status !== 'paid' ||
      typeof sessionPaymentIntentId(session) !== 'string' || !sessionPaymentIntentId(session).startsWith('pi_')) {
    throw new PublicError('Payment is not complete yet.', 409, 'payment_pending');
  }
  if (session.payment_intent && typeof session.payment_intent === 'object') {
    const intent = session.payment_intent;
    if (intent.livemode !== true || intent.status !== 'succeeded' || intent.currency !== 'eur' ||
        intent.amount_received !== order.amount_cents) {
      throw new PublicError('This payment could not be verified.', 409, 'payment_mismatch');
    }
  }
}

export function publicState(state, purchasesEnabled = false) {
  return {
    name: state.owner_name,
    country: state.country,
    amount: state.amount_cents / 100,
    next_minimum: (state.amount_cents + MINIMUM_INCREMENT_CENTS) / 100,
    verified: state.verified_payment === true,
    purchases_enabled: purchasesEnabled,
    kind: state.current_order_id ? 'stripe' : 'inaugural',
  };
}

export function publicOrder(order, state, purchasesEnabled = false) {
  const status = order.status === 'superseded' && !order.crowned_at && !['succeeded','failed','canceled','requires_action'].includes(order.refund_status)
    ? 'refund_pending' : order.status;
  return {
    status,
    amount: order.amount_cents / 100,
    display_name: order.display_name,
    country: order.country,
    is_current_owner: order.status === 'paid' && state.current_order_id === order.id,
    paid_at: order.paid_at,
    crowned_at: order.crowned_at,
    refund_status: order.refund_status,
    order_token: order.access_token,
    current: publicState(state, purchasesEnabled),
  };
}

export function encodeStripeForm(input) {
  const output = new URLSearchParams();
  function visit(value, key) {
    if (value === undefined || value === null) return;
    if (Array.isArray(value)) value.forEach((child, i) => visit(child, `${key}[${i}]`));
    else if (typeof value === 'object') Object.entries(value).forEach(([child, entry]) => visit(entry, key ? `${key}[${child}]` : child));
    else output.append(key, String(value));
  }
  visit(input, '');
  return output;
}

export async function verifyStripeSignature(raw, header, secret, nowSeconds = Math.floor(Date.now() / 1000)) {
  if (typeof header !== 'string' || typeof secret !== 'string' || !secret.startsWith('whsec_')) return false;
  const parts = header.split(',').map(part => part.trim().split('='));
  const timestampText = parts.find(([key]) => key === 't')?.[1];
  if (!timestampText || !/^\d+$/.test(timestampText)) return false;
  const timestamp = Number(timestampText);
  if (!Number.isSafeInteger(timestamp) || Math.abs(nowSeconds - timestamp) > 300) return false;
  const signatures = parts.filter(([key, value]) => key === 'v1' && /^[0-9a-f]{64}$/i.test(value || '')).map(([, value]) => value);
  if (!signatures.length) return false;
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
  const data = encoder.encode(`${timestamp}.${raw}`);
  for (const signature of signatures) {
    const bytes = Uint8Array.from(signature.match(/.{2}/g).map(value => Number.parseInt(value, 16)));
    if (await crypto.subtle.verify('HMAC', key, bytes, data)) return true;
  }
  return false;
}

