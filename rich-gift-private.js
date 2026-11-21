(() => {
  const page = document.documentElement;
  let activeRequest;

  function clearGift() {
    activeRequest?.abort();
    activeRequest = null;
    page.dataset.giftView = 'checking';
    document.getElementById('panel').classList.remove('open');
    document.getElementById('button').disabled = true;
    document.getElementById('retryGift').hidden = true;
    document.getElementById('giftGateText').textContent = 'Checking your private gift link…';
    for (const id of ['giftFor', 'giftDedication', 'giftFrom', 'giftSaveFeedback']) {
      document.getElementById(id).textContent = '';
    }
    const field = document.getElementById('giftLinkField');
    field.hidden = true;
    field.value = '';
  }

  // A new fragment can select a different gift in the same browser tab.
  window.addEventListener('hashchange', () => {
    if (page.dataset.giftView === 'preview' && !hasPrivateGiftLink()) return;
    clearGift();
    location.reload();
  });
  if (page.dataset.giftView === 'preview') return;

  const token = !location.search && location.hash.match(
    /^#gift_token=([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i
  )?.[1];
  const retry = document.getElementById('retryGift');
  const unavailable = 'This gift link is invalid or is no longer available. Check the link in your original gift.';

  function showError(message, canRetry) {
    page.dataset.giftView = 'error';
    document.getElementById('giftGateText').textContent = message;
    retry.hidden = !canRetry;
  }

  function showGift(gift) {
    const name = typeof gift.name === 'string' ? gift.name.trim() : '';
    const sender = typeof gift.sender === 'string' ? gift.sender.trim() : '';
    const message = typeof gift.message === 'string' ? gift.message.trim() : '';
    document.querySelector('.edition').textContent = 'THE RICH GIFT · VERIFIED';
    document.querySelector('.edition-intro').setAttribute('aria-label', 'Your gift dedication');
    document.getElementById('giftFor').textContent = name ? 'For ' + name : 'A gift for you.';
    const dedication = document.getElementById('giftDedication');
    dedication.textContent = message;
    dedication.hidden = !message;
    const from = document.getElementById('giftFrom');
    from.textContent = sender ? 'From ' + sender : '';
    from.hidden = !sender;
    document.getElementById('button').disabled = false;
    page.dataset.giftView = 'ready';
  }

  async function verifyGift() {
    if (activeRequest) return;
    clearGift();
    if (!token) {
      showError(unavailable, false);
      return;
    }
    const controller = new AbortController();
    activeRequest = controller;
    const timer = setTimeout(() => controller.abort(), 15000);
    try {
      const endpoint = new URL('https://mhrebbssqamkuulzqcki.supabase.co/functions/v1/rich-gift-redeem');
      endpoint.searchParams.set('token', token);
      const response = await fetch(endpoint, {
        cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer',
        redirect: 'error', signal: controller.signal
      });
      if (activeRequest !== controller) return;
      if ([400, 401, 403, 404, 410].includes(response.status)) {
        showError(unavailable, false);
        return;
      }
      if (!response.ok) throw new Error('Gift check unavailable');
      const gift = await response.json();
      if (activeRequest !== controller) return;
      if (gift?.verified !== true || gift.tier !== 'rich-gift' || gift.test || gift.complimentary) {
        showError(unavailable, false);
        return;
      }
      showGift(gift);
    } catch {
      if (activeRequest === controller) {
        showError('We couldn’t check this gift. Connect to the internet and try again.', true);
      }
    } finally {
      clearTimeout(timer);
      if (activeRequest === controller) activeRequest = null;
    }
  }

  const ua = navigator.userAgent;
  let instructions = 'Bookmark this page in your browser to reopen this gift. You can also copy the private link.';
  if (/iPhone|iPad|iPod/i.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)) {
    instructions = 'Tap Share in your browser and choose Add to Home Screen if it appears. If you see “Open as Web App”, turn it off to save this page as a shortcut. You can also bookmark this page or copy your gift link below.';
  } else if (/Android/i.test(ua)) {
    instructions = 'In Chrome, open the menu and choose Add to Home screen or Install and create shortcut, then Create shortcut. You can also bookmark this page.';
  }
  document.getElementById('personalInstallSteps').textContent = instructions;

  document.getElementById('copyGiftLink').addEventListener('click', async () => {
    if (page.dataset.giftView !== 'ready') return;
    const link = new URL(location.pathname, location.origin);
    link.hash = 'gift_token=' + token;
    const feedback = document.getElementById('giftSaveFeedback');
    try {
      await navigator.clipboard.writeText(link.href);
      feedback.textContent = 'Your gift link was copied.';
    } catch {
      if (page.dataset.giftView !== 'ready') return;
      const field = document.getElementById('giftLinkField');
      field.value = link.href;
      field.hidden = false;
      field.focus();
      field.select();
      feedback.textContent = 'Select and copy your gift link below.';
    }
  });

  retry.addEventListener('click', verifyGift);
  window.addEventListener('online', () => {
    if (!document.hidden && !retry.hidden) verifyGift();
  });
  // Browsers can restore an already rendered page when a gift link is reopened.
  window.addEventListener('pagehide', clearGift);
  window.addEventListener('pageshow', event => {
    if (event.persisted && !document.hidden) verifyGift();
  });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) clearGift();
    else verifyGift();
  });
  if (!document.hidden) verifyGift();
})();
