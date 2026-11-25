// Carry public campaign labels only along the current purchase journey.
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
        params.has('trb_ad') || params.has('trb_post') || params.has('checkout')) return;
    const ad = single(params, 'utm_content');
    if (single(params, 'utm_source') === 'meta' && single(params, 'utm_medium') === 'paid_social' &&
        single(params, 'utm_campaign') === 'christmas_2026' && activeAds.has(ad) &&
        activeAds.get(ad) === single(params, 'utm_term')) return ad;
  }

  const publicPages = new Map([
    ['/', 'home'], ['/index.html', 'home'], ['/rich-gift.html', 'rich-gift'],
    ['/gift.html', 'gift'], ['/rich-gift-button.html', 'rich-gift-button'],
    ['/gold.html', 'gold'], ['/platinum.html', 'platinum'], ['/diamond.html', 'diamond'],
  ]);
  const organicSources = new Set(['pinterest', 'facebook', 'instagram', 'tiktok', 'youtube']);
  const profileSources = new Set(['instagram', 'tiktok', 'youtube']);
  const landingKeys = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content',
    'fbclid', 'igsh', 'igshid', 'ttclid', 'si'];
  const editionLinks = new Set([
    'https://buy.stripe.com/9B67sMabl99RcJV4IR9AA0n',
    'https://buy.stripe.com/aFa14o83deub7pBfnv9AA0o',
    'https://buy.stripe.com/00w9AUdnxgCj7pB4IR9AA0p',
  ]);

  function organicCode(source, campaign, content) {
    if (!organicSources.has(source)) return;
    if (campaign === 'black_friday_2026' && content === 'black-friday' ||
        campaign === 'christmas_2026' && (/^day-(0[1-9]|1[0-9]|20)$/.test(content) ||
          content === 'profile' && profileSources.has(source))) return [source, campaign, content].join('_');
  }

  function knownPost(id) {
    if (!id) return;
    const match = /^(pinterest|facebook|instagram|tiktok|youtube)_(black_friday_2026|christmas_2026)_([a-z0-9-]+)$/.exec(id);
    return match ? organicCode(match[1], match[2], match[3]) : undefined;
  }

  function publicPage(url, allowedKeys) {
    if (url.origin !== current.origin || url.username || url.password || !publicPages.has(url.pathname) ||
        (url.hash && !(publicPages.get(url.pathname) === 'home' && url.hash === '#editions') &&
           !(url.pathname === '/gift.html' && url.hash === '#editionCheckoutBox'))) return false;
    const q = url.searchParams;
    if (url.pathname === '/gift.html') {
      allowedKeys = [...allowedKeys, 'tier', 'checkout'];
      if (q.has('tier') && !['rich-gift', 'gold', 'platinum', 'diamond'].includes(single(q, 'tier'))) return false;
      if (q.has('checkout') && single(q, 'checkout') !== 'cancelled') return false;
    }
    return [...q.keys()].every(key => allowedKeys.includes(key));
  }

  const directPost = publicPage(current, landingKeys) && !params.has('checkout') &&
    single(params, 'utm_medium') === 'organic_social'
    ? organicCode(single(params, 'utm_source'), single(params, 'utm_campaign'), single(params, 'utm_content'))
    : undefined;
  const post = directPost || (publicPage(current, ['trb_post']) ? knownPost(single(params, 'trb_post')) : undefined);
  const page = publicPages.get(current.pathname);
  function organicLink(href) {
    if (!post || !href) return href;
    const url = new URL(href, current);
    if (editionLinks.has(url.href)) {
      url.searchParams.set('client_reference_id', 'trb_org_' + post);
    } else if (publicPage(url, []) && !url.searchParams.has('checkout')) {
      url.searchParams.set('trb_post', post);
    } else {
      return href;
    }
    return url.href;
  }

  const isPurchasePage = purchasePage(current, true);
  const landing = (home || isPurchasePage) ? landingAd() : undefined;
  const carried = single(params, 'trb_ad');
  const ad = landing || (purchasePage(current) && activeAds.has(carried) ? carried : undefined);
  window.richCampaign = Object.freeze({
    homeAd: home ? ad : undefined,
    checkoutAd: form ? ad : undefined,
    organicPostId: post,
    organicLink,
  });

  const reported = new Set();
  function record(event, attribution) {
    if (reported.has(event)) return;
    reported.add(event);
    try {
      fetch('https://mhrebbssqamkuulzqcki.supabase.co/functions/v1/rich-analytics', {
        method: 'POST', headers: {'Content-Type':'application/json'}, keepalive: true,
        referrerPolicy: 'no-referrer', body: JSON.stringify({event, page, ...attribution}),
      }).catch(() => {});
    } catch {
      // Analytics is optional. The buyer can still personalize and pay.
    }
  }

  if (post) {
    if (directPost) record('organic_landing', {organic_post_id: post});
    for (const link of document.querySelectorAll('a[href]')) {
      const href = link.getAttribute('href');
      if (!href.startsWith('#')) link.href = organicLink(href);
    }
    document.addEventListener('click', event => {
      const edition = event.target.closest?.('a[data-edition-pay]');
      const gift = event.target.closest?.('#buyRichGift') && form && document.getElementById('tier')?.value === 'rich-gift';
      if (gift || edition) record('organic_checkout_click', {organic_post_id: post});
    }, true);
  }

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
  const organicGiftPage = post && (offer || (form && (!params.has('tier') || single(params, 'tier') === 'rich-gift')));
  if (!isPurchasePage && !organicGiftPage) return;
  if (!params.has('checkout')) record('page_view', {campaign_ad: ad});
  if (!form) return;
  const richGiftSelected = () => document.getElementById('tier')?.value === 'rich-gift';
  for (const id of ['name', 'sender', 'message']) {
    document.getElementById(id)?.addEventListener('input', () => {
      if (richGiftSelected()) record('gift_personalize_start', {campaign_ad: ad});
    });
  }
  // A click counts even if validation stops the form. Only a Stripe session
  // on a live order counts as a checkout start in the server-side report.
  document.getElementById('buyRichGift')?.addEventListener('click', () => {
    if (richGiftSelected()) record('gift_checkout_click', {campaign_ad: ad});
  }, true);
})();
