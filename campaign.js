// Only public catalogue labels travel between the advertising and purchase pages.
(() => {
  const current = new URL(window.location.href);
  const params = current.searchParams;
  const activeAds = new Map([
    ['vault-v1-miami', 'miami'],
    ['vault-v1-dubai', 'dubai'],
    ['vault-v1-london', 'london'],
    ['vault-v1-new-york', 'new-york'],
    ['vault-v1-los-angeles', 'los-angeles'],
    ['envelope-v2-london', 'london'],
    ['button-v2-london', 'london'],
  ]);
  const home = current.pathname === '/' || current.pathname === '/index.html';
  const offer = current.pathname === '/rich-gift.html';
  const form = current.pathname === '/gift.html';
  const campaignKeys = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term'];
  const privateKeys = ['e', 'gift', 'gift_token', 'order', 'test_order', 'complimentary',
    'session_id', 'stripe_test', 'referral', 'referral_kind', 'referral_token'];

  function single(query, key) {
    const values = query.getAll(key);
    return values.length === 1 ? values[0] : undefined;
  }

  function purchasePage(url, acceptLandingTags = false) {
    if (url.origin !== current.origin || url.username || url.password || url.hash.includes('=')) return false;
    const giftForm = url.pathname === '/gift.html';
    if (!giftForm && url.pathname !== '/rich-gift.html') return false;
    const allowed = ['trb_ad'];
    if (giftForm) allowed.push('tier', 'checkout');
    if (acceptLandingTags) allowed.push(...campaignKeys, 'fbclid', 'utm_id');
    const query = url.searchParams;
    return [...query.keys()].every(key => allowed.includes(key)) &&
      (!query.has('tier') || single(query, 'tier') === 'rich-gift') &&
      (!query.has('checkout') || single(query, 'checkout') === 'cancelled');
  }

  function landingAd() {
    if (current.hash.includes('=') || privateKeys.some(key => params.has(key)) ||
        params.has('trb_ad') || params.has('checkout')) return;
    const ad = single(params, 'utm_content');
    if (single(params, 'utm_source') === 'meta' && single(params, 'utm_medium') === 'paid_social' &&
        single(params, 'utm_campaign') === 'christmas_2026' && activeAds.has(ad) &&
        activeAds.get(ad) === single(params, 'utm_term')) return ad;
  }

  const isPurchasePage = purchasePage(current, true);
  const landing = (home || isPurchasePage) ? landingAd() : undefined;
  const carried = single(params, 'trb_ad');
  const ad = landing || (purchasePage(current) && activeAds.has(carried) ? carried : undefined);
  window.richCampaign = Object.freeze({
    homeAd: home ? ad : undefined,
    checkoutAd: form ? ad : undefined,
  });

  if (ad && (home || offer)) {
    for (const link of document.querySelectorAll('a[href]')) {
      const url = new URL(link.href, current);
      if (!purchasePage(url)) continue;
      url.searchParams.set('trb_ad', ad);
      link.href = url.href;
    }
  }

  // Home already sends its page_view. Private reveals, payment confirmations,
  // test orders and samples must never enter the purchase funnel.
  if (!isPurchasePage) return;
  const page = offer ? 'rich-gift' : 'gift';
  const reported = new Set();
  function record(event) {
    if (reported.has(event)) return;
    reported.add(event);
    try {
      fetch('https://mhrebbssqamkuulzqcki.supabase.co/functions/v1/rich-analytics', {
        method: 'POST', headers: {'Content-Type':'application/json'}, keepalive: true,
        referrerPolicy: 'no-referrer', body: JSON.stringify({event, page, campaign_ad: ad}),
      }).catch(() => {});
    } catch {
      // Analytics is optional. The buyer can still personalize and pay.
    }
  }

  if (!params.has('checkout')) record('page_view');
  if (!form) return;
  const richGiftSelected = () => document.getElementById('tier')?.value === 'rich-gift';
  for (const id of ['name', 'sender', 'message']) {
    document.getElementById(id)?.addEventListener('input', () => {
      if (richGiftSelected()) record('gift_personalize_start');
    });
  }
  // A click counts even if validation stops the form. Only a Stripe session
  // on a live order counts as a checkout start in the server-side report.
  document.getElementById('buyRichGift')?.addEventListener('click', () => {
    if (richGiftSelected()) record('gift_checkout_click');
  }, true);
})();
