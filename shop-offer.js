// The checkout service is the authority for prices and the Bratislava sale window.
(() => {
  const endpoint = 'https://mhrebbssqamkuulzqcki.supabase.co/functions/v1/rich-edition-checkout';
  const publicKey = 'sb_publishable_ciIqbUv4EV1yZgjelooxUw_V8jGdTBM';
  const list = { 'rich-gift': 4900, gold: 49900, platinum: 199900, diamond: 999900 };
  const params = new URLSearchParams(location.search);
  if (['stripe_test', 'test_order', 'order', 'session_id', 'gift_token', 'gift', 'e'].some(key => params.has(key)) ||
      location.hash.startsWith('#gift=')) return;
  const es = () => document.documentElement.lang === 'es';
  const money = amount => new Intl.NumberFormat(es() ? 'es-ES' : 'en-IE', {
    style: 'currency', currency: 'EUR', useGrouping: true,
    minimumFractionDigits: amount % 100 ? 2 : 0, maximumFractionDigits: 2
  }).format(amount / 100);
  let prices = null;
  let checkedUntil = 0;
  let timer;
  let pending;
  let buying = false;
  const backup = new WeakMap();
  const originalLinks = new WeakMap();
  const price = id => money(prices?.[id] ?? list[id]);
  const store = window.richOffer = {
    get active() { return prices !== null; },
    get expectedGiftCents() { return prices?.['rich-gift'] ?? list['rich-gift']; },
    price, refresh
  };
  function render() {
    document.documentElement.classList.toggle('bf-active', !!prices);
    const banner = document.querySelector('[data-bf-banner]');
    if (banner) {
      banner.hidden = !prices;
      banner.querySelector('strong').textContent = es() ? 'A mitad de precio. Sigue sin hacer nada.' : 'Half the price. Still does nothing.';
      banner.querySelector('small').textContent = es()
        ? '50 % en The Rich Gift, Gold, Platinum y Diamond · 27 de noviembre, hora de Bratislava'
        : '50% off The Rich Gift, Gold, Platinum and Diamond · 27 November, Bratislava time';
    }
    if (typeof window.updateEditionPricing === 'function') window.updateEditionPricing();
    const giftBuy = document.getElementById('buyRichGift');
    if (giftBuy) giftBuy.textContent = 'BUY YOUR RICH GIFT · ' + price('rich-gift');
    for (const el of document.querySelectorAll('[data-bf-price]')) {
      const key = el.dataset.bfPrice;
      if (!backup.has(el)) backup.set(el,el.innerHTML);
      if (!prices) {
        if (el.hasAttribute('data-bf-rendered')) {
          el.innerHTML = backup.get(el);
          el.removeAttribute('data-bf-rendered');
        }
        continue;
      }
      const old = document.createElement('del');
      old.textContent = money(list[key]);
      const current = document.createElement('ins');
      current.textContent = price(key);
      el.replaceChildren(old, document.createTextNode(' '), current);
      el.setAttribute('data-bf-rendered','');
    }
    const hero = document.querySelector('.hero__gift-cta small');
    if (hero) hero.textContent = es() ? 'REGALO DIGITAL PERSONALIZADO · ' + price('rich-gift') + ' · VISTA PREVIA DISPONIBLE'
      : 'PERSONALIZED DIGITAL GIFT · ' + price('rich-gift') + ' · PREVIEW AVAILABLE';
    const modal = document.getElementById('purchaseDialog');
    if (modal?.open && list[modal.dataset.tier]) {
      document.getElementById('purchaseTitle').textContent = modal.dataset.tier.toUpperCase() + ' · ' + price(modal.dataset.tier);
    }
    for (const link of document.querySelectorAll('[data-edition-pay]')) {
      const id = link.dataset.editionPay;
      if (!originalLinks.has(link) || link.id === 'editionPurchaseLink') originalLinks.set(link, link.getAttribute('href'));
      if (!list[id]) continue;
      // A promotional link opened in another tab still leads to the selected edition at the displayed rate.
      link.setAttribute('href', prices ? 'gift.html?tier=' + id + '#editionCheckoutBox' : originalLinks.get(link));
    }
  }
  async function refresh() {
    if (pending) return pending;
    pending = (async () => {
      try {
        const response = await fetch(endpoint, {cache:'no-store', credentials:'omit', referrerPolicy:'no-referrer', signal:AbortSignal.timeout(7000)});
        if (!response.ok) throw Error('Unavailable');
        const status = await response.json();
        const now = Date.parse(status.server_time);
        const start = Date.parse(status.starts_at);
        const end = Date.parse(status.ends_at);
        if (![now,start,end].every(Number.isFinite) || start >= end || typeof status.active !== 'boolean' ||
            Object.keys(list).some(key => status.prices?.[key] !== list[key] * (status.active ? .5 : 1)) ||
            (status.active && (now < start || now >= end))) throw Error('Invalid quote');
        prices = status.active ? status.prices : null;
        clearTimeout(timer);
        const boundary = now < start ? start : now < end ? end : Infinity;
        const delay = Math.min(boundary - now + 50, 2147483647);
        checkedUntil = Date.now() + delay;
        if (Number.isFinite(boundary)) timer = setTimeout(refresh,delay);
        render();
        return true;
      } catch {
        // Keep a previously displayed discount until the server confirms a change. It cannot charge list price.
        checkedUntil = 0;
        clearTimeout(timer);
        timer = setTimeout(refresh,60000);
        return false;
      }
    })();
    try { return await pending; } finally { pending = null; }
  }
  function feedback(link,text) {
    let node = link.parentNode.querySelector('.bf-checkout-status');
    if (!node) {
      node = document.createElement('p');
      node.className = 'bf-checkout-status';
      node.setAttribute('role','status');
      link.after(node);
    }
    node.textContent = text;
  }
  document.addEventListener('click',async event => {
    const link = event.target.closest?.('[data-edition-pay]');
    if (!link || !list[link.dataset.editionPay]) return;
    if (!prices && Date.now() < checkedUntil) return;
    event.preventDefault();
    if (buying) return;
    buying = true;
    const wasOffer = store.active;
    const edition = link.dataset.editionPay;
    try {
      if (Date.now() >= checkedUntil) {
        if (!await refresh()) {
          // Preserve the ordinary Payment Links if the optional status service is offline outside the sale.
          const today = new Intl.DateTimeFormat('sv-SE',{timeZone:'Europe/Bratislava'}).format(new Date());
          if (!wasOffer && today !== '2026-11-27') { location.assign(link.href); return; }
          throw Error('unavailable');
        }
        if (wasOffer !== store.active) {
          feedback(link,es() ? 'El precio ha cambiado. Revísalo antes de continuar.' : 'The price has changed. Review it before continuing.');
          return;
        }
        if (!store.active) { location.assign(originalLinks.get(link)); return; }
      }
      feedback(link,es() ? 'Preparando el pago…' : 'Preparing checkout…');
      const response = await fetch(endpoint,{method:'POST',headers:{'Content-Type':'application/json', apikey:publicKey},
        credentials:'omit',referrerPolicy:'no-referrer',body:JSON.stringify({edition,request_id:crypto.randomUUID()})});
      const result = await response.json();
      if (response.status===409) {
        await refresh();
        feedback(link,es() ? 'La oferta ha terminado. Revisa el precio antes de continuar.' : 'The offer has ended. Review the price before continuing.');
        return;
      }
      if (!response.ok || typeof result.checkout_url!=='string' || !result.checkout_url.startsWith('https://checkout.stripe.com/')) throw Error('unavailable');
      location.assign(result.checkout_url);
    } catch {
      feedback(link,es() ? 'No hemos podido confirmar el precio. Inténtalo de nuevo.' : 'We couldn’t confirm the price. Please try again.');
    } finally { buying = false; }
  });
  document.getElementById('tier')?.addEventListener('change', render);
  document.getElementById('language')?.addEventListener('click', render);
  window.addEventListener('pageshow', event => { if (event.persisted) refresh(); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden && Date.now() >= checkedUntil) refresh(); });
  refresh();
})();
