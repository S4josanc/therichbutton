import qrcode from './assets/vendor/qrcode-generator/qrcode.mjs';
import { cardDetails } from './christmas-card-link.mjs';

function drawCode(url) {
  const qr = qrcode(0, 'M');
  qr.addData(url, 'Byte');
  qr.make();
  const size = qr.getModuleCount();
  const quiet = 4;
  const extent = size + quiet * 2;
  const svg = document.getElementById('giftCode');
  svg.setAttribute('viewBox', '0 0 ' + extent + ' ' + extent);
  const white = document.createElementNS(svg.namespaceURI, 'rect');
  white.setAttribute('width', extent);
  white.setAttribute('height', extent);
  white.setAttribute('fill', 'white');
  const squares = [];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (qr.isDark(y, x)) squares.push('M' + (x + quiet) + ' ' + (y + quiet) + 'h1v1h-1z');
    }
  }
  const ink = document.createElementNS(svg.namespaceURI, 'path');
  ink.setAttribute('d', squares.join(''));
  ink.setAttribute('fill', 'black');
  svg.replaceChildren(white, ink);
}

const source = window.opener;
const status = document.getElementById('cardStatus');
if (source && !location.search && !location.hash) {
  const origin = location.origin;
  status.textContent = 'Preparing your card…';
  const timeout = setTimeout(() => {
    window.removeEventListener('message', receive);
    status.textContent = 'Reopen the card from your gift confirmation.';
  }, 30000);
  function receive(event) {
    if (event.source !== source || event.origin !== origin || event.data?.type !== 'rich-christmas-card') return;
    clearTimeout(timeout);
    window.removeEventListener('message', receive);
    window.opener = null;
    const gift = cardDetails(event.data.gift);
    if (!gift) {
      status.textContent = 'Reopen the card from your gift confirmation.';
      return;
    }
    try {
      drawCode(gift.gift_url);
      document.getElementById('cardRecipient').textContent = gift.recipient;
      document.getElementById('cardDedication').textContent = gift.message || 'I listened.';
      const signature = document.getElementById('cardSender');
      signature.textContent = gift.sender ? 'From ' + gift.sender : '';
      signature.hidden = !gift.sender;
      document.getElementById('cardSheet').hidden = false;
      document.getElementById('foldGuide').hidden = false;
      const print = document.getElementById('printChristmasCard');
      print.disabled = false;
      print.addEventListener('click', () => window.print());
      status.hidden = true;
    } catch {
      status.textContent = 'Your card could not be prepared. Reopen it from your gift confirmation.';
    }
  }
  window.addEventListener('message', receive);
  source.postMessage('rich-christmas-card-ready', origin);
}
