(() => {
  'use strict';
  const API = 'https://mhrebbssqamkuulzqcki.supabase.co/functions/v1/';
  const API_KEY = 'sb_publishable_ciIqbUv4EV1yZgjelooxUw_V8jGdTBM';
  const MAX_CENTS = 99999999;
  const page = document.body.dataset.thronePage;
  const $ = id => document.getElementById(id);
  const language = () => document.documentElement.lang === 'es' ? 'es' : 'en';
  const tr = (en, es) => language() === 'es' ? es : en;
  const euro = n => new Intl.NumberFormat(language() === 'es' ? 'es-ES' : 'en-IE', { style: 'currency', currency: 'EUR', maximumFractionDigits: 2, minimumFractionDigits: Number.isInteger(Number(n)) ? 0 : 2 }).format(Number(n));
  const put = (id, value) => { if ($(id)) $(id).textContent = value; };
  const text = value => typeof value === 'string' ? value : '';
  const isGermany = country => /^(de|deu|germany|alemania|deutschland|🇩🇪)$/i.test(text(country).trim());
  function countryNode(country) {
    if (!isGermany(country)) return document.createTextNode(text(country));
    const flag = document.createElement('img');
    flag.src = 'assets/flags/de.svg';
    flag.alt = tr('Germany', 'Alemania');
    flag.title = flag.alt;
    flag.width = 30; flag.height = 18;
    flag.style.cssText = 'display:inline-block;vertical-align:middle;border:1px solid #bfa87f66;border-radius:2px;box-sizing:content-box';
    return flag;
  }
  function putCountry(id, country) {
    if ($(id)) $(id).replaceChildren(countryNode(country));
  }
  let current = null;
  let order = null;
  let loading = false;
  let checkoutBusy = false;
  let requestId = crypto.randomUUID();
  let statusTimer;
  let statusAttempts = 0;
  const params = new URLSearchParams(location.search);
  const validToken = value => /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value || '');

  // Values are in euros in the public/status response and integer cents at checkout.
  function parseAmount(value) {
    const normalized = String(value).trim().replace(',', '.');
    if (!/^\d{1,6}(?:\.\d{1,2})?$/.test(normalized)) return null;
    const [whole, fraction = ''] = normalized.split('.');
    const cents = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
    return Number.isSafeInteger(cents) && cents > 0 && cents <= MAX_CENTS ? cents : null;
  }

  function minimumCents(data) {
    const cents = Math.round(Number(data?.next_minimum) * 100);
    return Number.isSafeInteger(cents) && cents >= 10100 ? cents : null;
  }

  function validateCurrent(data) {
    const amount = Number(data?.amount);
    const min = minimumCents(data);
    if (!Number.isFinite(amount) || amount < 100 || min === null || min < Math.round(amount * 100) + 100) throw Error('invalid_state');
    return data;
  }

  async function api(name, payload) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetch(API + name, {
        method: payload === undefined ? 'GET' : 'POST', cache: 'no-store', signal: controller.signal,
        headers: { apikey: API_KEY, ...(payload === undefined ? {} : { 'Content-Type': 'application/json' }) },
        ...(payload === undefined ? {} : { body: JSON.stringify(payload) })
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        const error = new Error(text(data.error) || 'request_failed');
        error.status = response.status;
        error.data = data;
        throw error;
      }
      return data;
    } finally { clearTimeout(timeout); }
  }

  function setPurchaseAvailability(enabled) {
    document.querySelectorAll('[data-throne-buy]').forEach(node => node.setAttribute('aria-disabled', String(!enabled)));
    if ($('thronePay')) $('thronePay').disabled = !enabled || checkoutBusy;
  }

  function renderCurrent() {
    if (!current) return;
    const name = text(current.name) || tr('Anonymous', 'Anónimo');
    const country = text(current.country);
    const ownerLabel = current.verified ? tr('CURRENT OWNER · PAYMENT VERIFIED', 'PROPIETARIO ACTUAL · PAGO VERIFICADO') : tr('INAUGURAL OWNER', 'PROPIETARIO INAUGURAL');
    const amountLabel = current.verified ? tr('AMOUNT PAID', 'IMPORTE PAGADO') : tr('INITIAL AMOUNT', 'IMPORTE INICIAL');
    put('publicThroneOwner', name);
    putCountry('publicThroneCountry', country);
    put('publicThroneAmount', euro(current.amount));
    put('publicThroneNext', euro(current.next_minimum));
    put('publicThroneAmountLabel', amountLabel);
    put('throneOwnerStatus', ownerLabel);
    put('throneOwnerLabel', current.verified ? tr('CURRENT OWNER', 'PROPIETARIO ACTUAL') : tr('INAUGURAL OWNER', 'PROPIETARIO INAUGURAL'));
    const enabled = current.purchases_enabled === true && !current.test_mode;
    setPurchaseAvailability(enabled);
    put('throneAvailability', enabled ? tr('Choose any amount from ', 'Elige cualquier importe desde ') + euro(current.next_minimum) + tr(' · Secure payment by Stripe', ' · Pago seguro con Stripe') : tr('Purchases are temporarily unavailable. Please try again later.', 'Las compras no están disponibles en este momento. Inténtalo más tarde.'));
    put('checkoutMinimum', euro(current.next_minimum));
    put('checkoutOwner', name);
    put('checkoutCurrentAmount', euro(current.amount));
    put('checkoutOwnerLabel', current.verified ? tr('CURRENT OWNER', 'PROPIETARIO ACTUAL') : tr('INAUGURAL OWNER', 'PROPIETARIO INAUGURAL'));
    if ($('throneAmount')) {
      $('throneAmount').placeholder = (minimumCents(current) / 100).toFixed(2);
      if (!$('throneAmount').value && !loading) $('throneAmount').value = (minimumCents(current) / 100).toFixed(2);
    }
    if (page === 'crown') renderCrown();
  }

  async function loadCurrent() {
    if (loading) return;
    loading = true;
    try {
      current = validateCurrent(await api('rich-throne-public'));
      loading = false;
      renderCurrent();
      if (page === 'checkout' && current.purchases_enabled !== true) showCheckoutError(tr('Checkout is temporarily unavailable. Please try again later.', 'El pago no está disponible en este momento. Inténtalo más tarde.'));
    } catch {
      current = null;
      setPurchaseAvailability(false);
      const message = tr('We could not confirm the current minimum. Please try again.', 'No hemos podido confirmar el mínimo actual. Inténtalo de nuevo.');
      put('throneAvailability', message);
      if (page === 'checkout') showCheckoutError(message);
      if (page === 'crown') put('status', message);
    } finally { loading = false; }
  }

  function translate() {
    document.querySelectorAll('[data-throne-en]').forEach(node => {
      node.textContent = node.getAttribute(language() === 'es' ? 'data-throne-es' : 'data-throne-en');
    });
    if ($('throneLanguage')) $('throneLanguage').textContent = language() === 'es' ? 'ES / EN' : 'EN / ES';
    renderCurrent();
    if (order) renderOrder();
    if (page === 'checkout' && params.get('cancelled') === '1') put('checkoutNotice', tr('You returned from Stripe. Your payment has not been confirmed here. You can check your order below before trying again.', 'Has vuelto de Stripe. Aquí no se ha confirmado ningún pago. Puedes revisar tu pedido abajo antes de intentarlo otra vez.'));
  }

  if (page !== 'home') {
    try { document.documentElement.lang = localStorage.getItem('trb-lang') === 'es' ? 'es' : 'en'; } catch {}
  }
  $('throneLanguage')?.addEventListener('click', () => {
    document.documentElement.lang = language() === 'es' ? 'en' : 'es';
    try { localStorage.setItem('trb-lang', language()); } catch {}
  });
  new MutationObserver(translate).observe(document.documentElement, { attributes: true, attributeFilter: ['lang'] });
  document.querySelectorAll('[data-throne-buy]').forEach(link => link.addEventListener('click', event => {
    if (link.getAttribute('aria-disabled') === 'true') { event.preventDefault(); loadCurrent(); }
  }));

  function showCheckoutError(message) { put('checkoutError', message); }

  async function submitCheckout(event) {
    event.preventDefault();
    if (checkoutBusy) return;
    showCheckoutError('');
    if (!current || current.purchases_enabled !== true || current.test_mode) {
      showCheckoutError(tr('Please wait while we confirm the current minimum.', 'Espera a que confirmemos el mínimo actual.'));
      await loadCurrent(); return;
    }
    const cents = parseAmount($('throneAmount').value);
    if (cents === null) {
      showCheckoutError(tr('Enter an amount in euros with up to two decimal places. The maximum supported payment is €999,999.99.', 'Introduce un importe en euros con un máximo de dos decimales. El máximo admitido es 999.999,99 €.'));
      $('throneAmount').focus(); return;
    }
    if (cents < minimumCents(current)) {
      showCheckoutError(tr('The current minimum is ', 'El mínimo actual es ') + euro(current.next_minimum) + '.');
      $('throneAmount').focus(); return;
    }
    if (!$('throneAccept').checked) {
      showCheckoutError(tr('Please read and accept the purchase rules before continuing.', 'Lee y acepta las condiciones de compra antes de continuar.'));
      $('throneAccept').focus(); return;
    }
    checkoutBusy = true;
    setPurchaseAvailability(false);
    put('thronePay', tr('OPENING STRIPE…', 'ABRIENDO STRIPE…'));
    try {
      const result = await api('rich-throne-checkout', {
        amount_cents: cents, display_name: $('throneName').value.trim(), country: $('throneCountry').value.trim(),
        accepted_terms: true, request_id: requestId
      });
      const checkoutUrl = new URL(result.url);
      const isStripeCheckout = checkoutUrl.protocol === 'https:' && checkoutUrl.hostname === 'checkout.stripe.com';
      const isExistingOrder = checkoutUrl.origin === 'https://therichbutton.com' && checkoutUrl.pathname === '/throne-order.html' && checkoutUrl.searchParams.get('order') === result.order_token;
      if ((!isStripeCheckout && !isExistingOrder) || !validToken(result.order_token)) throw Error('invalid_checkout');
      try { sessionStorage.setItem('trb-throne-pending-order', result.order_token); } catch {}
      location.assign(checkoutUrl.href);
    } catch (error) {
      if (error.status === 409 && Number.isFinite(Number(error.data?.next_minimum))) {
        const minimum = Number(error.data.next_minimum);
        showCheckoutError(tr('The throne has changed hands. The new minimum is ', 'El trono ha cambiado de manos. El nuevo mínimo es ') + euro(minimum) + tr('. Review your amount and try again.', '. Revisa tu importe e inténtalo de nuevo.'));
        requestId = crypto.randomUUID();
        await loadCurrent();
      } else if (error.status === 429) {
        showCheckoutError(tr('Please wait a moment before trying again.', 'Espera un momento antes de volver a intentarlo.'));
      } else {
        showCheckoutError(tr('We could not open Stripe. No payment has been taken on this page. Please try again.', 'No hemos podido abrir Stripe. Esta página no ha realizado ningún cobro. Inténtalo de nuevo.'));
      }
      checkoutBusy = false;
      put('thronePay', tr('CONTINUE TO STRIPE', 'CONTINUAR EN STRIPE'));
      setPurchaseAvailability(current?.purchases_enabled === true && !current?.test_mode);
    }
  }

  if (page === 'checkout') {
    $('throneForm')?.addEventListener('submit', submitCheckout);
    ['throneAmount', 'throneName', 'throneCountry'].forEach(id => $(id)?.addEventListener('input', () => { requestId = crypto.randomUUID(); showCheckoutError(''); }));
    $('reloadThrone')?.addEventListener('click', () => { showCheckoutError(''); loadCurrent(); });
    try {
      const previous = sessionStorage.getItem('trb-throne-pending-order');
      if (validToken(previous)) { $('previousOrder').hidden = false; $('previousOrderLink').href = 'throne-order.html?order=' + encodeURIComponent(previous); }
    } catch {}
  }

  let orderToken = params.get('order');
  let sessionId = params.get('session_id');
  if (page === 'order' && validToken(orderToken)) {
    // Keep only the private order token in the address; never share the Stripe session.
    history.replaceState(null, '', 'throne-order.html?order=' + encodeURIComponent(orderToken));
  }

  function personalUrl() { return new URL('throne-order.html?order=' + encodeURIComponent(orderToken), location.href).href; }

  function renderOrder() {
    const status = order.status;
    const verified = ['paid', 'superseded'].includes(status) && Boolean(order.crowned_at);
    $('personalKeepsake').hidden = !verified;
    $('orderRefresh').hidden = false;
    $('orderTest').hidden = !order.test_mode;
    const messages = {
      pending: [tr('Confirming your payment.', 'Confirmando tu pago.'), tr('Stripe has not confirmed a successful payment yet. Keep this page or save its link. You can safely check again without paying a second time.', 'Stripe todavía no ha confirmado un pago correcto. Conserva esta página o guarda su enlace. Puedes comprobarlo de nuevo sin volver a pagar.')],
      paid: [order.is_current_owner ? tr('The throne is yours.', 'El trono es tuyo.') : tr('Your Richest Button is ready.', 'Tu Richest Button está listo.'), order.is_current_owner ? tr('Your payment is confirmed and you hold the title. Your button and this keepsake remain yours if someone takes the crown later.', 'Tu pago está confirmado y el título es tuyo. Tu botón y este recuerdo seguirán siendo tuyos si alguien ocupa el trono después.') : tr('Your payment is confirmed. Another owner now holds the title; your personal button and keepsake are still yours.', 'Tu pago está confirmado. Otra persona tiene ahora el título; tu botón y tu recuerdo siguen siendo tuyos.')],
      superseded: order.crowned_at ? [tr('Your place in the collection.', 'Tu lugar en la colección.'), tr('Another owner now holds the title. Your payment was confirmed and your personal button and keepsake remain available here.', 'Otra persona tiene ahora el título. Tu pago se confirmó y tu botón y recuerdo personal siguen disponibles aquí.')] : [tr('The throne changed hands.', 'El trono cambió de manos.'), tr('This payment did not receive the title. We are checking the refund status; please check again in a moment.', 'Este pago no recibió el título. Estamos comprobando el estado del reembolso; vuelve a consultar en un momento.')],
      refund_pending: [tr('The throne changed hands.', 'El trono cambió de manos.'), tr('Another payment raised the minimum before yours could take the title. Your purchase has not been awarded the crown, and your refund is being processed. You do not need to pay again.', 'Otro pago elevó el mínimo antes de que el tuyo pudiera conseguir el título. Esta compra no ha recibido la corona y el reembolso se está tramitando. No necesitas volver a pagar.')],
      refunded: [tr('Your payment has been refunded.', 'Tu pago ha sido reembolsado.'), tr('This order has been refunded. Your bank may take some time to show the funds. No current title is attached to this payment.', 'Este pedido ha sido reembolsado. Tu banco puede tardar en mostrar el importe. Este pago no da acceso al título actual.')],
      expired: [tr('This checkout has expired.', 'Este pago ha caducado.'), tr('No confirmed payment is recorded for this order. You can return to the current offer when you are ready.', 'No consta ningún pago confirmado para este pedido. Puedes volver a la oferta actual cuando quieras.')]
    };
    const refundNeedsHelp = !order.crowned_at && ['failed', 'canceled', 'requires_action'].includes(order.refund_status);
    const message = refundNeedsHelp ? [tr('Your refund needs attention.', 'Tu reembolso necesita atención.'), tr('This payment did not receive the title, but the refund could not be completed automatically. Contact support@therichbutton.com with this private order link. Please do not make another payment to recover it.', 'Este pago no recibió el título, pero el reembolso no se pudo completar automáticamente. Contacta con support@therichbutton.com e incluye este enlace privado del pedido. No vuelvas a pagar para recuperarlo.')] : messages[status];
    if (!message) { put('orderTitle', tr('We are checking your order.', 'Estamos comprobando tu pedido.')); put('orderMessage', tr('Please check again in a moment.', 'Vuelve a comprobarlo en un momento.')); return; }
    put('orderTitle', message[0]); put('orderMessage', message[1]);
    if (verified) {
      put('keepsakeName', text(order.display_name) || tr('Anonymous owner', 'Propietario anónimo'));
      putCountry('keepsakeCountry', order.country);
      put('keepsakeAmount', euro(order.amount));
      put('keepsakeStatus', order.is_current_owner ? tr('CURRENT OWNER', 'PROPIETARIO ACTUAL') : tr('THE CROWN COLLECTION', 'LA COLECCIÓN DE LA CORONA'));
      put('keepsakeDate', order.paid_at ? new Date(order.paid_at).toLocaleDateString(language() === 'es' ? 'es-ES' : 'en-GB', { year: 'numeric', month: 'long', day: 'numeric' }) : '');
      const link = personalUrl();
      const messageText = tr('My Richest Button. Because I can.', 'Mi Richest Button. Porque puedo.');
      $('orderWhatsApp').href = 'https://wa.me/?text=' + encodeURIComponent(messageText + ' ' + link);
      $('orderEmail').href = 'mailto:?subject=' + encodeURIComponent('The Richest Button') + '&body=' + encodeURIComponent(messageText + '\n\n' + link);
    }
    if (order.current) { current = order.current; put('orderCurrentName', text(current.name) || tr('Anonymous', 'Anónimo')); put('orderNextMinimum', euro(current.next_minimum)); }
  }

  async function loadOrder(manual = false) {
    clearTimeout(statusTimer);
    if (loading) return;
    if (!validToken(orderToken)) {
      put('orderTitle', tr('Open your private order link.', 'Abre el enlace privado de tu pedido.'));
      put('orderMessage', tr('This page needs the private link shown after checkout. Contact support if you need help finding your order.', 'Esta página necesita el enlace privado que aparece después del pago. Contacta con soporte si necesitas ayuda para localizar tu pedido.'));
      $('orderRefresh').hidden = true; return;
    }
    if (manual) statusAttempts = 0;
    loading = true; $('orderRefresh').disabled = true; put('orderError', '');
    try {
      const result = await api('rich-throne-order-status', { order_token: orderToken, ...(sessionId && /^cs_(?:test_|live_)?[A-Za-z0-9]+$/.test(sessionId) ? { session_id: sessionId } : {}) });
      if (!['pending', 'paid', 'superseded', 'refund_pending', 'refunded', 'expired'].includes(result.status)) throw Error('invalid_order');
      order = result; renderOrder();
      statusAttempts++;
      const refundNeedsHelp = ['failed', 'canceled', 'requires_action'].includes(order.refund_status);
      if (!refundNeedsHelp && (['pending', 'refund_pending'].includes(order.status) || (order.status === 'superseded' && !order.crowned_at)) && statusAttempts < 10) statusTimer = setTimeout(() => loadOrder(), 4000);
    } catch (error) {
      put('orderError', error.status === 404 ? tr('We could not find this order. Check that you opened the complete private link.', 'No hemos encontrado este pedido. Comprueba que has abierto el enlace privado completo.') : tr('We could not check the order just now. Please try again. Do not make a second payment to recover this order.', 'No hemos podido comprobar el pedido ahora. Inténtalo de nuevo. No vuelvas a pagar para recuperar este pedido.'));
    } finally { loading = false; $('orderRefresh').disabled = false; }
  }

  async function shareLink(url, title, message, target) {
    try {
      if (navigator.share) { await navigator.share({ title, text: message, url }); return; }
      await navigator.clipboard.writeText(url); put(target, tr('LINK COPIED', 'ENLACE COPIADO'));
    } catch (error) {
      if (error.name !== 'AbortError') put(target, url);
    }
  }

  if (page === 'order') {
    $('orderRefresh').addEventListener('click', () => loadOrder(true));
    $('orderShare').addEventListener('click', () => shareLink(personalUrl(), 'The Richest Button', tr('My Richest Button. Because I can.', 'Mi Richest Button. Porque puedo.'), 'orderShareStatus'));
    $('orderCopy').addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(personalUrl()); put('orderShareStatus', tr('LINK COPIED', 'ENLACE COPIADO')); }
      catch { put('orderShareStatus', personalUrl()); }
    });
    $('orderPrint').addEventListener('click', () => window.print());
    let presses = 0;
    $('personalButton').addEventListener('click', () => {
      presses++; $('personalButton').classList.remove('is-pressed'); void $('personalButton').offsetWidth; $('personalButton').classList.add('is-pressed');
      const phrases = language() === 'es' ? ['No ha pasado nada. Con mucho estilo.', 'Tu corona sigue brillando.', 'Una decisión perfectamente innecesaria.', 'Porque puedes.'] : ['Nothing happened. Impeccably.', 'Your crown still shines.', 'A perfectly unnecessary decision.', 'Because you can.'];
      put('personalResponse', phrases[(presses - 1) % phrases.length]);
    });
  }

  let format = 'square';
  function renderCrown() {
    const name = text(current.name) || tr('Anonymous', 'Anónimo');
    const country = text(current.country);
    const badge = current.verified ? tr('CURRENT OWNER · PAYMENT VERIFIED', 'PROPIETARIO ACTUAL · PAGO VERIFICADO') : tr('INAUGURAL OWNER · INITIAL AMOUNT', 'PROPIETARIO INAUGURAL · IMPORTE INICIAL');
    put('crownBadge', badge); put('crownName', name); put('crownDetailName', name);
    putCountry('crownCountry', country); put('crownAmount', euro(current.amount)); put('crownDetailAmount', euro(current.amount)); put('crownMinimum', euro(current.next_minimum));
    put('crownAmountLabel', current.verified ? tr('AMOUNT PAID', 'IMPORTE PAGADO') : tr('INITIAL AMOUNT', 'IMPORTE INICIAL'));
    put('coronationName', name);
    $('coronationAmount').replaceChildren(document.createTextNode(euro(current.amount) + (country ? ' · ' : '')), countryNode(country));
    put('coronationStatus', badge); put('crownWatermark', badge);
    put('crownDetailText', current.verified ? tr('The current holder of The Richest Button. A new confirmed payment of at least ', 'El propietario actual de The Richest Button. Un nuevo pago confirmado de al menos ') + euro(current.next_minimum) + tr(' can take the crown.', ' puede conseguir la corona.') : name + tr(' opens the collection at ', ' abre la colección con ') + euro(current.amount) + tr('. Take the crown with a verified payment of at least ', '. Consigue la corona con un pago verificado de al menos ') + euro(current.next_minimum) + '.');
    $('download').disabled = false; $('replay').disabled = false;
  }

  function drawCrown() {
    const w = 1080, h = format === 'square' ? 1080 : 1920;
    const canvas = document.createElement('canvas'); canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext('2d');
    const gradient = ctx.createRadialGradient(w / 2, h * .35, 40, w / 2, h * .45, h * .75);
    gradient.addColorStop(0, '#392916'); gradient.addColorStop(.58, '#100d09'); gradient.addColorStop(1, '#060606');
    ctx.fillStyle = gradient; ctx.fillRect(0, 0, w, h); ctx.strokeStyle = '#bc9759'; ctx.lineWidth = 9; ctx.strokeRect(30, 30, w - 60, h - 60); ctx.strokeStyle = '#86663a'; ctx.lineWidth = 2; ctx.strokeRect(60, 60, w - 120, h - 120);
    const line = (value, y, size, color, family = 'Georgia', italic = false) => {
      ctx.fillStyle = color; ctx.textAlign = 'center';
      do { ctx.font = `${italic ? 'italic ' : ''}${size}px ${family}`; if (ctx.measureText(value).width <= 900) break; size -= 2; } while (size > 14);
      ctx.fillText(value, w / 2, y);
    };
    const scale = Math.min(h / 1080, 1.5);
    line('THE RICH BUTTON · THE CROWN COLLECTION', h * .10, 20 * scale, '#dfc08a', 'Arial');
    line('♛', h * .25, 155 * scale, '#e8c67e');
    line(tr('I OWN THE', 'EL TRONO'), h * .37, 65 * scale, '#f8e3b8', 'Georgia', true);
    line(tr('THRONE.', 'ES MÍO.'), h * .45, 90 * scale, '#f8e3b8', 'Georgia', true);
    line(text(current.name) || tr('Anonymous', 'Anónimo'), h * .58, 53 * scale, '#fff0d0');
    if (isGermany(current.country)) {
      const flagWidth = 72 * scale, flagHeight = flagWidth * .6;
      const flagX = (w - flagWidth) / 2, flagY = h * .64 - flagHeight / 2;
      ['#000000', '#dd0000', '#ffce00'].forEach((color, i) => {
        ctx.fillStyle = color;
        ctx.fillRect(flagX, flagY + i * flagHeight / 3, flagWidth, flagHeight / 3);
      });
      ctx.strokeStyle = '#bfa87f'; ctx.lineWidth = 1;
      ctx.strokeRect(flagX, flagY, flagWidth, flagHeight);
    } else line(text(current.country), h * .64, 24 * scale, '#cbb18a', 'Arial');
    line(euro(current.amount), h * .77, 120 * scale, '#f2d18b');
    line(tr('THINK YOU CAN TAKE MY CROWN?', '¿CREES QUE PUEDES QUITARME LA CORONA?'), h * .85, 21 * scale, '#d6bb8b', 'Arial');
    line('THERICHBUTTON.COM', h * .92, 20 * scale, '#d9bd8b', 'Arial');
    line(current.verified ? tr('PAYMENT VERIFIED · CURRENT AT DOWNLOAD', 'PAGO VERIFICADO · ACTUAL AL DESCARGAR') : tr('INAUGURAL OWNER · INITIAL AMOUNT', 'PROPIETARIO INAUGURAL · IMPORTE INICIAL'), h * .978, 18 * scale, '#cdb891', 'Arial');
    return canvas;
  }

  if (page === 'crown') {
    let coronationTimeout;
    $('replay').addEventListener('click', () => {
      if (!current) return;
      clearTimeout(coronationTimeout); const overlay = $('coronationOverlay');
      overlay.classList.remove('is-playing'); void overlay.offsetWidth; overlay.classList.add('is-playing');
      coronationTimeout = setTimeout(() => overlay.classList.remove('is-playing'), 6300);
    });
    const selectFormat = value => {
      format = value; $('square').setAttribute('aria-pressed', String(value === 'square')); $('story').setAttribute('aria-pressed', String(value === 'story'));
      $('poster').style.aspectRatio = value === 'square' ? '1/1' : '9/16'; $('poster').style.maxWidth = value === 'square' ? '500px' : '360px';
    };
    $('square').addEventListener('click', () => selectFormat('square')); $('story').addEventListener('click', () => selectFormat('story')); selectFormat('square');
    $('download').addEventListener('click', () => {
      if (!current) return;
      try { const link = document.createElement('a'); link.download = 'the-richest-button-' + format + '.png'; link.href = drawCrown().toDataURL('image/png'); link.click(); put('status', tr('IMAGE READY TO SAVE', 'IMAGEN LISTA PARA GUARDAR')); }
      catch { put('status', tr('Could not generate the image on this device.', 'No se ha podido generar la imagen en este dispositivo.')); }
    });
    $('share').addEventListener('click', () => shareLink(new URL('crown.html', location.href).href, 'The Richest Button', tr('There can only be one.', 'Solo puede haber uno.'), 'status'));
  }

  translate();
  if (['home', 'crown', 'checkout'].includes(page)) loadCurrent();
  if (page === 'order') loadOrder();
  // Recheck after returning to the page, so a stale tab never promises an old minimum.
  document.addEventListener('visibilitychange', () => { if (!document.hidden && ['home', 'crown', 'checkout'].includes(page)) loadCurrent(); });
})();
