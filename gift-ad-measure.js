// Dedicated, verified Meta dataset for the gift only. Empty disables both the pixel and the prompt.
(() => {
  'use strict';
  const pixelId = '';
  if (!/^\d{5,22}$/.test(pixelId)) return;

  const origin = location.origin;
  const bridgePath = '/gift-ad-frame.html';
  const consentKey = 'rich-gift-ad-choice-v1';
  const purchasesKey = 'rich-gift-ad-purchases-v1';
  const ttl = 180 * 24 * 60 * 60 * 1000;
  const uuid = /^[a-f\d]{8}(?:-[a-f\d]{4})-4[a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/i;
  const messageType = 'rich-gift-ad-v1';

  let forceOptOut = false;
  function readChoice() {
    if (forceOptOut) return 'decline';
    try {
      const record = JSON.parse(localStorage.getItem(consentKey));
      if (record && ['allow', 'decline'].includes(record.choice) && record.until > Date.now()) return record.choice;
    } catch { /* A blocked preference store means no third-party measurement. */ }
    return null;
  }

  // No third-party JavaScript is loaded in either document. The image transport can
  // observe only this fixed-origin resource request, never the parent's URL or form.
  if (location.pathname === bridgePath) {
    if (window.parent === window || location.search || location.hash) return;
    const approved = ['ViewContent', 'InitiateCheckout', 'Purchase'];
    function receive(event) {
      if (event.origin !== origin || event.source !== window.parent || event.data?.type !== messageType) return;
      const data = event.data;
      if (!approved.includes(data.name) || readChoice() !== 'allow') return;
      const purchase = data.name === 'Purchase';
      if (purchase && (!uuid.test(data.eventId) || !Number.isFinite(data.value) || data.value <= 0 ||
          data.value > 10000 || data.currency !== 'EUR')) return;
      window.removeEventListener('message', receive);
      const params = new URLSearchParams({id:pixelId, ev:data.name});
      if (purchase) {
        params.set('cd[value]', data.value.toFixed(2));
        params.set('cd[currency]', 'EUR');
        params.set('eid', data.eventId);
      }
      const img = document.createElement('img');
      img.alt = '';
      img.width = img.height = 1;
      img.referrerPolicy = 'no-referrer';
      const complete = ok => window.parent.postMessage({type:messageType, complete:ok}, origin);
      img.onload = () => complete(true);
      img.onerror = () => complete(false);
      img.src = 'https://www.facebook.com/tr?' + params;
      document.body.append(img);
    }
    window.addEventListener('message', receive);
    return;
  }

  const isProduct = location.pathname === '/rich-gift.html';
  const isForm = location.pathname === '/gift.html';
  if ((!isProduct && !isForm) || window !== window.top) return;
  const params = new URLSearchParams(location.search);
  const keys = [...params.keys()];
  const publicKeys = new Set(['tier', 'trb_ad', 'checkout', 'utm_source', 'utm_medium', 'utm_content',
    'utm_campaign', 'utm_term', 'fbclid']);
  const ordinaryGift = keys.every(k => publicKeys.has(k)) && ['', '#ad-privacy'].includes(location.hash) &&
    (!params.has('tier') || params.get('tier') === 'rich-gift') &&
    (!params.has('checkout') || params.get('checkout') === 'cancelled');
  const isReceipt = isForm && !location.hash && keys.length === 2 && keys.includes('order') &&
    keys.includes('session_id') && !!params.get('order') && /^cs_live_/.test(params.get('session_id'));
  if (!ordinaryGift && !isReceipt) return;

  const receiptConsent = isReceipt && readChoice() === 'allow';
  const activeFrames = new Map();
  const pendingPurchases = new Set();
  let checkoutSent = false;
  let productSent = false;
  let banner, settings, choiceMessage;
  const currentTierIsGift = () => !isForm || (document.getElementById('tier')?.value ?? 'rich-gift') === 'rich-gift';
  const allowed = () => readChoice() === 'allow' && (isReceipt || currentTierIsGift());

  function cancelFrames() {
    for (const cancel of [...activeFrames.values()]) cancel(false);
  }

  // A separate, clean frame per stage fires exactly one image request. Payment and
  // gift delivery continue even when an ad blocker prevents the image from loading.
  function send(payload, timeout) {
    if (!allowed() || !document.body) return Promise.resolve(false);
    return new Promise(resolve => {
      const frame = document.createElement('iframe');
      frame.hidden = true;
      frame.title = 'Gift ad measurement';
      frame.referrerPolicy = 'no-referrer';
      frame.src = bridgePath;
      const finish = ok => {
        clearTimeout(timer);
        window.removeEventListener('message', completed);
        activeFrames.delete(frame);
        frame.remove();
        resolve(ok);
      };
      function completed(e) {
        if (e.source === frame.contentWindow && e.origin === origin && e.data?.type === messageType &&
            typeof e.data.complete === 'boolean') finish(e.data.complete);
      }
      const timer = setTimeout(() => finish(false), timeout);
      activeFrames.set(frame, finish);
      window.addEventListener('message', completed);
      frame.onload = () => {
        if (!allowed()) return finish(false);
        frame.contentWindow.postMessage({type:messageType, ...payload}, origin);
      };
      document.body.append(frame);
    });
  }

  function savedPurchases() {
    try {
      const saved = JSON.parse(localStorage.getItem(purchasesKey));
      return Array.isArray(saved) ? saved.filter(x => x && uuid.test(x.id) && x.until > Date.now()) : [];
    } catch { return []; }
  }

  function canMeasurePurchase() { return receiptConsent && allowed(); }

  async function purchase(info) {
    if (!canMeasurePurchase() || !info || !uuid.test(info.eventId) || info.currency !== 'EUR' ||
        !Number.isFinite(info.value) || info.value <= 0 || info.value > 10000) return false;
    const eventId = info.eventId;
    const transmit = async () => {
      if (!canMeasurePurchase() || savedPurchases().some(x => x.id === eventId) || pendingPurchases.has(eventId)) return false;
      pendingPurchases.add(eventId);
      try {
        const ok = await send({name:'Purchase', value:info.value, currency:'EUR', eventId}, 4000);
        if (ok && allowed()) {
          try { localStorage.setItem(purchasesKey, JSON.stringify([...savedPurchases(), {id:eventId, until:Date.now()+ttl}].slice(-100))); }
          catch { /* The stable Meta event ID remains the same on retry. */ }
        }
        return ok;
      } finally { pendingPurchases.delete(eventId); }
    };
    if (navigator.locks?.request) return navigator.locks.request('rich-gift-ad-' + eventId, transmit);
    return transmit();
  }

  function checkoutStarted() {
    if (!isForm || isReceipt || !ordinaryGift || !allowed() || checkoutSent) return Promise.resolve(false);
    checkoutSent = true;
    return send({name:'InitiateCheckout'}, 350);
  }

  window.richGiftAds = Object.freeze({purchase, canMeasurePurchase, checkoutStarted});
  function view() {
    if (!isProduct || !ordinaryGift || !allowed() || productSent) return;
    productSent = true;
    send({name:'ViewContent'}, 3500);
  }

  function refresh() {
    if (!banner) return;
    const eligible = (ordinaryGift && currentTierIsGift()) || (isReceipt && !!readChoice());
    const choice = readChoice();
    if (!allowed()) cancelFrames();
    settings.hidden = !eligible;
    banner.hidden = !eligible || !!choice;
    if (choiceMessage) choiceMessage.textContent = choice === 'allow' ? 'Ad measurement is on.' :
      choice === 'decline' ? 'Ad measurement is off.' : '';
    if (eligible) view();
  }

  function remember(choice) {
    try {
      localStorage.setItem(consentKey, JSON.stringify({choice, until:Date.now()+ttl}));
      forceOptOut = false;
      if (choice === 'decline') localStorage.removeItem(purchasesKey);
    } catch {
      forceOptOut = true;
      cancelFrames();
      banner.hidden = true;
      choiceMessage.textContent = 'Ad measurement is off. Your browser could not save this choice.';
      settings.focus();
      return;
    }
    refresh();
    settings.focus();
  }

  function mount() {
    if (ordinaryGift || (isReceipt && readChoice())) {
      const css = document.createElement('link');
      css.rel = 'stylesheet';
      css.href = '/gift-ad-choice.css';
      document.head.append(css);
      banner = document.createElement('aside');
      banner.className = 'gift-ad-choice';
      banner.id = 'ad-privacy';
      banner.setAttribute('aria-labelledby', 'gift-ad-title');
      banner.innerHTML = '<strong id="gift-ad-title">Help us measure this ad?</strong><p>If you accept, Meta can receive gift views, checkout starts and confirmed purchases with their price. It receives browser and connection information and may use cookies to link these events to ads. Buying works either way. <a href="/privacy.html#gift-ad-privacy">Privacy notice</a></p><div><button type="button" data-choice="decline">Decline</button><button type="button" data-choice="allow">Accept</button></div>';
      banner.hidden = true;
      const anchor = document.querySelector('[data-bf-banner]') || document.querySelector('header');
      if (anchor) anchor.after(banner); else document.body.prepend(banner);
      settings = document.createElement('button');
      settings.type = 'button';
      settings.className = 'gift-ad-settings';
      settings.textContent = 'Ad privacy choices';
      settings.setAttribute('aria-controls', banner.id);
      choiceMessage = document.createElement('span');
      choiceMessage.className = 'gift-ad-status';
      choiceMessage.setAttribute('role', 'status');
      const foot = document.querySelector('footer') || document.body;
      foot.append(settings, choiceMessage);
      banner.querySelectorAll('[data-choice]').forEach(el => el.addEventListener('click', () => remember(el.dataset.choice)));
      settings.addEventListener('click', () => {
        banner.hidden = false;
        banner.querySelector('button').focus();
      });
      document.getElementById('tier')?.addEventListener('change', refresh);
    }
    refresh();
    if (location.hash === '#ad-privacy' && settings && !settings.hidden) settings.click();
  }
  window.addEventListener('storage', e => {
    if (e.key === null || e.key === consentKey) { if (!allowed()) cancelFrames(); refresh(); }
  });
  window.addEventListener('pageshow', () => { if (!allowed()) cancelFrames(); refresh(); });
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount, {once:true});
  else mount();
})();
