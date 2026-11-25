// Dedicated, verified Meta dataset for the gift only. Empty disables both the pixel and the prompt.
(() => {
  'use strict';
  const pixelId = '1129484256546804';
  if (!/^\d{5,22}$/.test(pixelId)) return;

  const origin = location.origin;
  const bridgePath = '/gift-ad-frame.html';
  const clickKey = 'rich-gift-ad-click-v1';
  const validClick = id => typeof id === 'string' && /^[A-Za-z0-9_-]{16,500}$/.test(id);
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

  // Only the first-party relay can reach the parent document. Meta runs in an empty
  // sandbox with an opaque origin, no referrer, storage access, forms or navigation.
  if (location.pathname === bridgePath) {
    if (window.parent === window || location.search || location.hash) return;
    let frame, port;
    window.addEventListener('message', event => {
      const data = event.data;
      if (event.origin !== origin || event.source !== window.parent || data?.type !== messageType ||
          readChoice() !== 'allow') return;
      if (data.action === 'prepare') {
        if (frame) return;
        frame = document.createElement('iframe');
        frame.hidden = true;
        frame.title = 'Gift ad signal';
        frame.setAttribute('sandbox', 'allow-scripts');
        frame.referrerPolicy = 'no-referrer';
        frame.src = validClick(data.clickId) ? '/gift-ad-runtime.html?fbclid=' + encodeURIComponent(data.clickId) : '/gift-ad-runtime.html';
        frame.onload = () => {
          if (readChoice() !== 'allow') return;
          const channel = new MessageChannel();
          port = channel.port1;
          port.onmessage = ({data:reply}) => {
            if (readChoice() !== 'allow' || !reply) return;
            if (reply.ready === true) window.parent.postMessage({type:messageType, ready:true}, origin);
            else if (Number.isSafeInteger(reply.seq) && typeof reply.ok === 'boolean') {
              window.parent.postMessage({type:messageType, seq:reply.seq, ok:reply.ok}, origin);
            }
          };
          // A sandbox without allow-same-origin requires '*' for this one port transfer.
          // All further messages run over the private channel, not a window broadcast.
          frame.contentWindow.postMessage('rich-gift-ad-connect', '*', [channel.port2]);
          port.postMessage({pixelId});
        };
        document.body.append(frame);
        return;
      }
      if (!port || !Number.isSafeInteger(data.seq) || !['ViewContent','InitiateCheckout','Purchase'].includes(data.name)) return;
      const signal = {name:data.name, seq:data.seq};
      if (data.name === 'Purchase') {
        if (!uuid.test(data.eventId) || !Number.isFinite(data.value) || data.value <= 0 ||
            data.value > 10000 || data.currency !== 'EUR') return;
        Object.assign(signal, {value:data.value, currency:'EUR', eventId:data.eventId});
      }
      port.postMessage(signal);
    });
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
  const pendingPurchases = new Set();
  let checkoutSent = false;
  let productSent = false;
  let banner, settings, choiceMessage;
  const currentTierIsGift = () => !isForm || (document.getElementById('tier')?.value ?? 'rich-gift') === 'rich-gift';
  const allowed = () => readChoice() === 'allow' && (isReceipt || currentTierIsGift());

  let bridge, ready = false, sequence = 0;
  const pending = new Map();

  function cancelFrames() {
    for (const entry of [...pending.values()]) entry.finish(false);
    bridge?.remove();
    bridge = undefined;
    ready = false;
  }
  function clearClick() {
    try { sessionStorage.removeItem(clickKey); } catch { /* Browser storage is optional. */ }
  }
  function consentedClick() {
    if (!allowed()) return undefined;
    try {
      const values = params.getAll('fbclid');
      if (ordinaryGift && values.length === 1 && validClick(values[0])) {
        sessionStorage.setItem(clickKey, JSON.stringify({id:values[0], until:Date.now()+86400000}));
        return values[0];
      }
      const old = JSON.parse(sessionStorage.getItem(clickKey));
      if (old?.until > Date.now() && validClick(old.id)) return old.id;
      clearClick();
    } catch { /* Never make measurement or a purchase depend on advertising storage. */ }
    return undefined;
  }
  function prepare() {
    if (bridge || !allowed() || !document.body) return;
    bridge = document.createElement('iframe');
    bridge.hidden = true;
    bridge.title = 'Gift ad measurement';
    bridge.referrerPolicy = 'no-referrer';
    bridge.src = bridgePath;
    bridge.onload = () => {
      if (bridge && allowed()) {
        const clickId = consentedClick();
        bridge.contentWindow.postMessage({type:messageType, action:'prepare', ...(clickId ? {clickId} : {})}, origin);
      }
    };
    document.body.append(bridge);
  }
  window.addEventListener('message', e => {
    if (!bridge || e.source !== bridge.contentWindow || e.origin !== origin || e.data?.type !== messageType || !allowed()) return;
    if (e.data.ready === true && !ready) {
      ready = true;
      for (const entry of pending.values()) entry.dispatch();
    } else if (typeof e.data.ok === 'boolean') pending.get(e.data.seq)?.finish(e.data.ok);
  });
  function send(payload, timeout) {
    if (!allowed() || !document.body) return Promise.resolve(false);
    prepare();
    const seq = ++sequence;
    return new Promise(resolve => {
      const entry = {
        dispatch() {
          if (allowed() && bridge) bridge.contentWindow.postMessage({type:messageType, seq, ...payload}, origin);
        },
        finish(ok) {
          clearTimeout(timer);
          pending.delete(seq);
          resolve(ok);
        }
      };
      const timer = setTimeout(() => entry.finish(false), timeout);
      pending.set(seq, entry);
      if (ready) entry.dispatch();
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
    if (eligible && ordinaryGift && allowed()) { prepare(); view(); }
  }

  function remember(choice) {
    try {
      localStorage.setItem(consentKey, JSON.stringify({choice, until:Date.now()+ttl}));
      forceOptOut = false;
      if (choice === 'decline') { clearClick(); localStorage.removeItem(purchasesKey); }
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
      banner.innerHTML = '<strong id="gift-ad-title">Help us measure this ad?</strong><p>If you accept, Meta can receive gift views, checkout starts and confirmed purchases with their price. Meta receives browser and connection information. If you arrived from a Meta ad, we can include its click ID so Meta can match these events to that ad. Meta may use cookies. Buying works either way. <a href="/privacy.html#gift-ad-privacy">Privacy notice</a></p><div><button type="button" data-choice="decline">Decline</button><button type="button" data-choice="allow">Accept</button></div>';
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
    if (e.key === null || e.key === consentKey) { if (!allowed()) { clearClick(); cancelFrames(); } refresh(); }
  });
  window.addEventListener('pageshow', () => { if (!allowed()) { clearClick(); cancelFrames(); } refresh(); });
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount, {once:true});
  else mount();
})();
