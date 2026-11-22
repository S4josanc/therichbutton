// Public ad labels only. This script runs on the home page and the two Rich Gift purchase pages.
(() => {
  const current = new URL(window.location.href);
  const params = current.searchParams;
  const activeAds = new Map([
    ['vault-v1-miami', 'miami'],
    ['vault-v1-dubai', 'dubai'],
    ['vault-v1-london', 'london'],
    ['vault-v1-singapore', 'singapore'],
    ['vault-v1-sydney', 'sydney'],
  ]);
  const home = current.pathname === '/' || current.pathname === '/index.html';

  function single(query, key) {
    const values = query.getAll(key);
    return values.length === 1 ? values[0] : undefined;
  }

  function landingAd() {
    if (current.hash.includes('=') || ['e', 'gift', 'gift_token', 'order', 'test_order', 'complimentary',
      'session_id', 'stripe_test', 'checkout', 'trb_ad', 'referral', 'referral_kind', 'referral_token'].some(key => params.has(key))) return;
    const city = single(params, 'utm_term');
    const ad = single(params, 'utm_content');
    if (single(params, 'utm_source') === 'meta' && single(params, 'utm_medium') === 'paid_social' &&
        single(params, 'utm_campaign') === 'christmas_2026' && activeAds.has(ad) && activeAds.get(ad) === city) {
      return ad;
    }
  }

  function purchasePage(url) {
    if (url.origin !== current.origin || url.username || url.password || url.hash.includes('=')) return false;
    const keys = [...url.searchParams.keys()];
    if (url.pathname === '/rich-gift.html') return keys.every(key => key === 'trb_ad');
    if (url.pathname !== '/gift.html') return false;
    if (!keys.every(key => ['tier', 'trb_ad', 'checkout'].includes(key))) return false;
    return (!keys.includes('tier') || single(url.searchParams, 'tier') === 'rich-gift') &&
      (!keys.includes('checkout') || single(url.searchParams, 'checkout') === 'cancelled');
  }

  const homeAd = home ? landingAd() : undefined;
  const carried = single(params, 'trb_ad');
  const purchaseAd = purchasePage(current) && activeAds.has(carried) ? carried : undefined;
  window.richCampaign = Object.freeze({homeAd, checkoutAd: current.pathname === '/gift.html' ? purchaseAd : undefined});

  const ad = homeAd || purchaseAd;
  if (!ad || current.pathname === '/gift.html') return;
  function tagPurchaseLink(anchor) {
    const url = new URL(anchor.href, current);
    if (!purchasePage(url)) return;
    url.searchParams.set('trb_ad', ad);
    anchor.href = url.href;
  }
  for (const link of document.querySelectorAll('a[href]')) tagPurchaseLink(link);
})();
