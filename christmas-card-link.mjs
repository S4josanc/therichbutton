const recipientLink = /^https:\/\/therichbutton\.com\/open-gift\.html\?gift_token=[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function cardDetails(gift) {
  if (typeof gift?.gift_url !== 'string' || !recipientLink.test(gift.gift_url) ||
      typeof gift.recipient !== 'string' || !gift.recipient.trim()) return null;
  const text = (value, max) => typeof value === 'string' ? value.trim().slice(0, max) : '';
  return {
    gift_url: gift.gift_url, recipient: text(gift.recipient, 42),
    sender: text(gift.sender, 42), message: text(gift.message, 180)
  };
}

export function enablePaidChristmasCard(button, note, gift) {
  const details = cardDetails(gift);
  if (gift.status !== 'paid' || !details) return;
  button.hidden = false;
  button.onclick = () => {
    // Open synchronously for mobile browsers. No personal data enters either URL.
    const child = window.open('christmas-card.html', '_blank');
    if (!child) {
      note.textContent = 'Allow this site to open a new tab, then try again.';
      note.hidden = false;
      return;
    }
    note.hidden = true;
    const origin = location.origin;
    const stop = () => {
      clearTimeout(timeout);
      window.removeEventListener('message', ready);
    };
    function ready(event) {
      if (event.source !== child || event.origin !== origin || event.data !== 'rich-christmas-card-ready') return;
      stop();
      child.postMessage({ type: 'rich-christmas-card', gift: details }, origin);
    }
    const timeout = setTimeout(stop, 60000);
    window.addEventListener('message', ready);
  };
}
