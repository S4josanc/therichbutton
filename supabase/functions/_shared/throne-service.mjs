import {
  STRIPE_VERSION, SITE_ORIGIN, PUBLIC_API_KEY, PRODUCT, TERMS_VERSION,
  WEBHOOK_EVENTS, PublicError, isUuid, validateCheckoutInput, validateStatusInput,
  assertSessionBelongsToOrder, assertPaidSession, sessionPaymentIntentId,
  publicState, publicOrder, encodeStripeForm, verifyStripeSignature,
} from './throne-core.mjs';

const INTEGRATION_IDENTIFIER = 'therichbutton-throne-vjpkmras';
const ALLOWED_ORIGINS = new Set([SITE_ORIGIN, 'https://www.therichbutton.com']);

function safeFailure(error, fallback = 'service_unavailable') {
  return error instanceof PublicError ? error : new PublicError('Please try again in a moment.', 503, fallback);
}

export function createRuntime({ env = name => globalThis.Deno?.env.get(name), fetch: fetcher = globalThis.fetch, now = () => Date.now(), log } = {}) {
  const supabaseUrl = (env('SUPABASE_URL') || '').replace(/\/$/, '');
  const serviceKey = env('SUPABASE_SERVICE_ROLE_KEY') || '';
  const stripeKey = env('STRIPE_SECRET_KEY') || '';
  const runtime = {
    now,
    cache: { checkedAt: 0, ready: false, endpointId: null },
    webhookUrl: `${supabaseUrl}/functions/v1/rich-throne-webhook`,
    projectRef: (() => { try { return new URL(supabaseUrl).hostname.split('.')[0]; } catch { return ''; } })(),
    liveKey: /^(sk|rk)_live_/.test(stripeKey),
    log: log || (code => console.error(JSON.stringify({ component: PRODUCT, code }))),
    async rpc(name, params = {}) {
      if (!supabaseUrl || !serviceKey) throw new PublicError('Purchases are temporarily unavailable.', 503, 'database_not_configured');
      let response;
      try {
        response = await fetcher(`${supabaseUrl}/rest/v1/rpc/${name}`, {
          method: 'POST',
          headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(params), signal: AbortSignal.timeout(15_000),
        });
      } catch { throw new PublicError('Please try again in a moment.', 503, 'database_unavailable'); }
      // Do not return or log Postgres error bodies: a private RPC can carry a
      // webhook signing secret as a bound argument.
      if (!response.ok) throw new PublicError('Please try again in a moment.', 503, 'database_operation_failed');
      const text = await response.text();
      return text ? JSON.parse(text) : null;
    },
    async stripe(method, path, params = {}, idempotencyKey) {
      if (!runtime.liveKey) throw new PublicError('Purchases are temporarily unavailable.', 503, 'live_payments_not_configured');
      if (!path.startsWith('/v1/')) throw new Error('Unexpected Stripe path');
      const body = encodeStripeForm(params);
      const url = `https://api.stripe.com${path}${method === 'GET' && body.size ? `?${body}` : ''}`;
      const headers = { Authorization: `Bearer ${stripeKey}`, 'Stripe-Version': STRIPE_VERSION };
      if (method !== 'GET') headers['Content-Type'] = 'application/x-www-form-urlencoded';
      if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
      let response;
      try {
        response = await fetcher(url, { method, headers, body: method === 'GET' ? undefined : body, signal: AbortSignal.timeout(20_000) });
      } catch { throw new PublicError('The payment service is temporarily unavailable.', 503, 'stripe_unavailable'); }
      if (!response.ok) {
        // Stripe can include customer or secret values in error text; neither
        // those responses nor request bodies enter logs or client errors.
        throw new PublicError('The payment service is temporarily unavailable.', 503, `stripe_http_${response.status}`);
      }
      return response.json();
    },
    async subjectHash(request) {
      const address = request.headers.get('x-real-ip') || request.headers.get('cf-connecting-ip') ||
        request.headers.get('x-forwarded-for')?.split(',')[0].trim() || 'unknown';
      const encoder = new TextEncoder();
      const key = await crypto.subtle.importKey('raw', encoder.encode(serviceKey), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
      const hash = await crypto.subtle.sign('HMAC', key, encoder.encode(`rich-throne-rate:${address}`));
      return [...new Uint8Array(hash)].map(byte => byte.toString(16).padStart(2, '0')).join('');
    },
  };
  return runtime;
}

function corsHeaders(request) {
  const origin = request.headers.get('origin');
  return {
    'Access-Control-Allow-Origin': ALLOWED_ORIGINS.has(origin) ? origin : SITE_ORIGIN,
    'Access-Control-Allow-Headers': 'content-type, apikey, x-client-info',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
    'Vary': 'Origin',
    'Referrer-Policy': 'no-referrer',
  };
}

function response(request, data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), { status, headers: { ...corsHeaders(request), ...extraHeaders } });
}

function requireBrowserRequest(request) {
  if (!ALLOWED_ORIGINS.has(request.headers.get('origin'))) throw new PublicError('Request not allowed.', 403, 'origin_not_allowed');
  if (request.headers.get('apikey') !== PUBLIC_API_KEY) throw new PublicError('Request not allowed.', 401, 'api_key_required');
}

async function readText(request, maxBytes) {
  if (Number(request.headers.get('content-length')) > maxBytes) throw new PublicError('Request is too large.', 413, 'request_too_large');
  if (!request.body) return '';
  const reader = request.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) { await reader.cancel(); throw new PublicError('Request is too large.', 413, 'request_too_large'); }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

async function readJson(request) {
  if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) {
    throw new PublicError('JSON is required.', 415, 'json_required');
  }
  let text;
  try { text = await readText(request, 8192); }
  catch (error) { throw safeFailure(error, 'invalid_request'); }
  try { return JSON.parse(text); } catch { throw new PublicError('Invalid request.'); }
}

async function applyRateLimit(runtime, request, scope) {
  const result = await runtime.rpc('rich_throne_rate_limit', { p_scope: scope, p_subject_hash: await runtime.subjectHash(request) });
  if (!result?.allowed) throw new PublicError('Please wait a moment before trying again.', 429, 'rate_limited', { retry_after: result?.retry_after || 60 });
}

function withBrowserErrors(runtime, method, handler, { publicRead = false } = {}) {
  return async request => {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders(request) });
    try {
      if (request.method !== method) throw new PublicError('Method not allowed.', 405, 'method_not_allowed');
      if (!publicRead) requireBrowserRequest(request);
      return response(request, await handler(request));
    } catch (error) {
      const failure = safeFailure(error);
      if (failure.status >= 500) runtime.log(failure.code);
      return response(request, { error: failure.message, code: failure.code, ...failure.details }, failure.status,
        failure.details.retry_after ? { 'Retry-After': String(failure.details.retry_after) } : {});
    }
  };
}

function assertWebhookEndpoint(endpoint, runtime, { requireSecret = false } = {}) {
  if (!endpoint || endpoint.livemode !== true || endpoint.status !== 'enabled' || endpoint.url !== runtime.webhookUrl ||
      endpoint.api_version !== STRIPE_VERSION || !WEBHOOK_EVENTS.every(event => endpoint.enabled_events?.includes(event)) ||
      endpoint.metadata?.integration !== PRODUCT || endpoint.metadata?.project_ref !== runtime.projectRef ||
      (requireSecret && (typeof endpoint.secret !== 'string' || !endpoint.secret.startsWith('whsec_')))) {
    throw new PublicError('Purchases are temporarily unavailable.', 503, 'webhook_configuration_mismatch');
  }
}

async function checkEndpoint(runtime, config) {
  if (!runtime.liveKey || config?.ready !== true) return false;
  if (runtime.cache.ready && runtime.cache.endpointId === config.endpoint_id && runtime.now() - runtime.cache.checkedAt < 30_000) return true;
  const endpoint = await runtime.stripe('GET', `/v1/webhook_endpoints/${encodeURIComponent(config.endpoint_id)}`);
  assertWebhookEndpoint(endpoint, runtime);
  runtime.cache = { ready: true, endpointId: endpoint.id, checkedAt: runtime.now() };
  return true;
}

export async function purchasesEnabled(runtime) {
  if (!runtime.liveKey) return false;
  if (runtime.cache.ready && runtime.now() - runtime.cache.checkedAt < 30_000) return true;
  try {
    const config = await runtime.rpc('rich_throne_webhook_configuration');
    return await checkEndpoint(runtime, config);
  } catch (error) {
    runtime.cache = { ready: false, endpointId: null, checkedAt: runtime.now() };
    runtime.log(safeFailure(error).code);
    return false;
  }
}

export async function ensureWebhook(runtime) {
  if (!runtime.liveKey) throw new PublicError('Purchases are temporarily unavailable.', 503, 'live_payments_not_configured');
  let config = await runtime.rpc('rich_throne_webhook_configuration');
  if (config?.ready) { await checkEndpoint(runtime, config); return; }
  const leaseToken = crypto.randomUUID();
  const lease = await runtime.rpc('rich_throne_acquire_webhook_setup', { p_lease_token: leaseToken });
  if (lease?.ready) {
    config = await runtime.rpc('rich_throne_webhook_configuration');
    if (!await checkEndpoint(runtime, config)) throw new PublicError('Purchases are temporarily unavailable.', 503, 'webhook_not_ready');
    return;
  }
  if (lease?.error) throw new PublicError('Purchases are temporarily unavailable.', 503, lease.error);
  if (!lease?.acquired) throw new PublicError('Checkout is preparing. Please try again in a moment.', 503, 'setup_in_progress', { retry_after: 3 });
  try {
    const account = await runtime.stripe('GET', '/v1/account');
    if (!/^acct_[A-Za-z0-9]+$/.test(account?.id || '')) throw new PublicError('Purchases are temporarily unavailable.', 503, 'stripe_account_unavailable');
    const endpoint = await runtime.stripe('POST', '/v1/webhook_endpoints', {
      url: runtime.webhookUrl,
      enabled_events: WEBHOOK_EVENTS,
      api_version: STRIPE_VERSION,
      description: 'The Richest Button payment confirmation; independent of Gift',
      metadata: { integration: PRODUCT, project_ref: runtime.projectRef, generation: lease.generation },
    }, `rich-throne-webhook-${runtime.projectRef}-${lease.generation}`);
    assertWebhookEndpoint(endpoint, runtime, { requireSecret: true });
    await runtime.rpc('rich_throne_save_webhook_setup', {
      p_lease_token: leaseToken, p_generation: lease.generation, p_endpoint_id: endpoint.id,
      p_signing_secret: endpoint.secret, p_account_id: account.id,
    });
    // No endpoint response, signing secret or private RPC result is logged or
    // returned to a visitor. The secret lives only in memory and encrypted Vault.
    runtime.cache = { ready: true, endpointId: endpoint.id, checkedAt: runtime.now() };
  } catch (error) {
    await runtime.rpc('rich_throne_release_webhook_setup', { p_lease_token: leaseToken }).catch(() => {});
    throw error;
  }
}

export async function reconcileRefund(runtime, order) {
  if (order.crowned_at || order.status === 'paid') return order;
  if (order.status === 'refunded') return order;
  if (order.status !== 'superseded' || !order.stripe_payment_intent_id) return order;
  let refund;
  if (order.stripe_refund_id) {
    refund = await runtime.stripe('GET', `/v1/refunds/${encodeURIComponent(order.stripe_refund_id)}`);
  } else {
    // Stripe may have accepted the refund before the database acknowledgement
    // failed. Recover it even beyond Stripe's idempotency retention window.
    const existing = await runtime.stripe('GET', '/v1/refunds', { payment_intent: order.stripe_payment_intent_id, limit: 100 });
    refund = existing.data?.find(candidate => candidate.metadata?.product === PRODUCT && candidate.metadata?.order_id === order.id);
    if (!refund && existing.has_more) throw new PublicError('Your refund is being reviewed.', 503, 'refund_history_incomplete');
    if (!refund) refund = await runtime.stripe('POST', '/v1/refunds', {
      payment_intent: order.stripe_payment_intent_id,
      amount: order.amount_cents,
      metadata: { product: PRODUCT, order_id: order.id, reason: 'superseded_before_crowning' },
    }, `rich-throne-refund-${order.id}`);
  }
  const paymentIntentId = typeof refund.payment_intent === 'string' ? refund.payment_intent : refund.payment_intent?.id;
  if (refund.metadata?.product !== PRODUCT || refund.metadata?.order_id !== order.id || refund.amount !== order.amount_cents ||
      refund.currency !== 'eur' || paymentIntentId !== order.stripe_payment_intent_id ||
      !['pending', 'requires_action', 'succeeded', 'failed', 'canceled'].includes(refund.status)) {
    throw new PublicError('Your payment is being reviewed. Please try again shortly.', 503, 'refund_verification_failed');
  }
  const updated = await runtime.rpc('rich_throne_record_refund', {
    p_order_id: order.id, p_refund_id: refund.id, p_refund_status: refund.status,
    p_amount_cents: refund.amount, p_payment_intent_id: paymentIntentId,
  });
  if (['failed', 'canceled', 'requires_action'].includes(refund.status)) runtime.log(`refund_${refund.status}`);
  return updated;
}

export async function reconcileOrder(runtime, order, sessionHint = null) {
  if (sessionHint && sessionHint !== order.stripe_checkout_session_id) {
    throw new PublicError('This payment does not belong to the order.', 409, 'session_mismatch');
  }
  if (order.status === 'paid' || order.crowned_at || order.status === 'refunded') return order;
  if (order.status === 'superseded') return reconcileRefund(runtime, order);
  if (!order.stripe_checkout_session_id) return order;
  const session = await runtime.stripe('GET', `/v1/checkout/sessions/${encodeURIComponent(order.stripe_checkout_session_id)}`, { expand: ['payment_intent'] });
  assertSessionBelongsToOrder(session, order);
  if (session.payment_status === 'paid') {
    assertPaidSession(session, order);
    const settled = await runtime.rpc('rich_throne_confirm_payment', {
      p_order_id: order.id, p_session_id: session.id, p_payment_intent_id: sessionPaymentIntentId(session),
      p_amount_cents: session.amount_total, p_currency: session.currency, p_livemode: session.livemode,
    });
    return reconcileRefund(runtime, settled.order);
  }
  if (session.status === 'expired') return runtime.rpc('rich_throne_mark_expired', { p_order_id: order.id, p_session_id: session.id });
  return order;
}

function orderReturn(order) {
  return { url: `${SITE_ORIGIN}/throne-order.html?order=${encodeURIComponent(order.access_token)}`, order_token: order.access_token, order_id: order.id };
}

export function createCheckoutHandler(runtime) {
  return withBrowserErrors(runtime, 'POST', async request => {
    const input = validateCheckoutInput(await readJson(request));
    await applyRateLimit(runtime, request, 'checkout');
    await ensureWebhook(runtime);
    const prepared = await runtime.rpc('rich_throne_prepare_order', {
      p_request_id: input.request_id, p_display_name: input.display_name, p_country: input.country,
      p_amount_cents: input.amount_cents, p_terms_version: TERMS_VERSION,
    });
    if (prepared.error === 'minimum_changed') throw new PublicError('The minimum has changed. Please choose a higher amount.', 409, 'minimum_changed', { next_minimum: prepared.next_minimum });
    if (prepared.error === 'request_reused') throw new PublicError('Please refresh the checkout before changing this purchase.', 409, 'request_reused');
    let order = prepared.order;
    if (!order) throw new PublicError('Unable to prepare this purchase.', 503, 'order_unavailable');
    if (order.status !== 'pending') return orderReturn(order);
    if (order.stripe_checkout_session_id) {
      order = await reconcileOrder(runtime, order);
      if (order.status !== 'pending') return orderReturn(order);
      const session = await runtime.stripe('GET', `/v1/checkout/sessions/${encodeURIComponent(order.stripe_checkout_session_id)}`);
      assertSessionBelongsToOrder(session, order);
      if (session.status !== 'open' || !session.url) return orderReturn(order);
      return { url: session.url, order_token: order.access_token, order_id: order.id };
    }
    if (runtime.now() - new Date(order.created_at).getTime() > 22 * 60 * 60 * 1000) {
      throw new PublicError('This checkout has expired. Please start a new purchase.', 409, 'order_expired');
    }
    const session = await runtime.stripe('POST', '/v1/checkout/sessions', {
      mode: 'payment',
      integration_identifier: INTEGRATION_IDENTIFIER,
      adaptive_pricing: { enabled: false },
      line_items: [{ price_data: { currency: 'eur', unit_amount: order.amount_cents,
        product_data: { name: 'The Richest Button', description: 'Digital keepsake and the current-owner title until a higher verified purchase.' } }, quantity: 1 }],
      client_reference_id: order.id,
      metadata: { product: PRODUCT, order_id: order.id, terms_version: TERMS_VERSION },
      payment_intent_data: { metadata: { product: PRODUCT, order_id: order.id } },
      success_url: `${SITE_ORIGIN}/throne-order.html?order=${encodeURIComponent(order.access_token)}&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${SITE_ORIGIN}/throne-checkout.html?cancelled=1`,
    }, `rich-throne-checkout-${order.id}`);
    assertSessionBelongsToOrder(session, { ...order, stripe_checkout_session_id: session.id });
    if (session.status !== 'open' || typeof session.url !== 'string' || !session.url.startsWith('https://checkout.stripe.com/')) {
      throw new PublicError('Unable to open this checkout.', 503, 'checkout_unavailable');
    }
    order = await runtime.rpc('rich_throne_attach_session', {
      p_order_id: order.id, p_session_id: session.id,
      p_expires_at: session.expires_at ? new Date(session.expires_at * 1000).toISOString() : null,
    });
    return { url: session.url, order_token: order.access_token, order_id: order.id };
  });
}

export function createStatusHandler(runtime) {
  return withBrowserErrors(runtime, 'POST', async request => {
    const input = validateStatusInput(await readJson(request));
    await applyRateLimit(runtime, request, 'status');
    let order = await runtime.rpc('rich_throne_get_order', { p_order_token: input.order_token });
    if (!order) throw new PublicError('Order not found.', 404, 'order_not_found');
    order = await reconcileOrder(runtime, order, input.session_id);
    const state = await runtime.rpc('rich_throne_get_state');
    if (!state) throw new PublicError('Please try again in a moment.', 503, 'state_unavailable');
    return publicOrder(order, state, await purchasesEnabled(runtime));
  });
}

export function createPublicHandler(runtime) {
  return withBrowserErrors(runtime, 'GET', async () => {
    const state = await runtime.rpc('rich_throne_get_state');
    if (!state) throw new PublicError('Please try again in a moment.', 503, 'state_unavailable');
    return publicState(state, await purchasesEnabled(runtime));
  }, { publicRead: true });
}

export function createWebhookHandler(runtime) {
  return async request => {
    if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 });
    try {
      const signature = request.headers.get('stripe-signature');
      if (!signature) return new Response('Missing signature', { status: 400 });
      const raw = await readText(request, 1_048_576);
      const config = await runtime.rpc('rich_throne_webhook_configuration');
      if (!config?.ready) return new Response('Webhook not ready', { status: 503 });
      if (!await verifyStripeSignature(raw, signature, config.signing_secret, Math.floor(runtime.now() / 1000))) {
        return new Response('Invalid signature', { status: 400 });
      }
      let event;
      try { event = JSON.parse(raw); } catch { return new Response('Invalid event', { status: 400 }); }
      if (event.livemode !== true) return new Response('Live mode required', { status: 400 });
      if (!WEBHOOK_EVENTS.includes(event.type)) return Response.json({ received: true, ignored: true });
      const object = event.data?.object;
      if (object?.metadata?.product !== PRODUCT || !isUuid(object?.metadata?.order_id)) return Response.json({ received: true, ignored: true });
      let order = await runtime.rpc('rich_throne_get_order', { p_order_id: object.metadata.order_id });
      if (!order) return new Response('Order unavailable', { status: 503 });
      if (event.type.startsWith('refund.')) {
        if (order.crowned_at || order.status === 'paid') return Response.json({ received: true, ignored: true });
        // Retrieve our recorded refund through Stripe instead of trusting the
        // state carried by an older/out-of-order webhook payload.
        await reconcileRefund(runtime, order);
      } else {
        if (object.id !== order.stripe_checkout_session_id) return new Response('Session mismatch', { status: 409 });
        if (event.type === 'checkout.session.async_payment_failed') {
          const session = await runtime.stripe('GET', `/v1/checkout/sessions/${encodeURIComponent(order.stripe_checkout_session_id)}`, { expand: ['payment_intent'] });
          assertSessionBelongsToOrder(session, order);
          if (session.payment_status === 'paid') await reconcileOrder(runtime, order);
          else await runtime.rpc('rich_throne_mark_expired', { p_order_id: order.id, p_session_id: session.id });
        } else {
          await reconcileOrder(runtime, order);
        }
      }
      return Response.json({ received: true });
    } catch (error) {
      const failure = safeFailure(error);
      runtime.log(failure.code);
      return new Response('Payment confirmation will be retried', { status: failure.status >= 500 ? 503 : failure.status });
    }
  };
}
