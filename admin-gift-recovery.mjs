const orderIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const recoveryUrlPattern = /^https:\/\/therichbutton\.com\/gift\.html\?order=[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function mailboxKey(address) {
  const at = address.lastIndexOf('@');
  return address.slice(0, at + 1) + address.slice(at + 1).toLowerCase();
}

export function createGiftRecovery({ call }) {
  const get = id => document.getElementById(id);
  const details = get('giftRecoveryDetails');
  const form = get('recoveryForm');
  const order = get('recoveryOrder');
  const email = get('recoveryEmail');
  const verified = get('recoveryVerified');
  const submit = get('recoverySubmit');
  const status = get('recoveryStatus');
  const result = get('recoveryResult');
  const link = get('recoveryLink');
  const destination = get('recoveryDestination');
  let revision = 0;

  function forgetResult() {
    revision++;
    link.value = '';
    destination.textContent = '';
    result.hidden = true;
    submit.disabled = false;
    status.textContent = '';
  }

  function clearForm() {
    forgetResult();
    form.reset();
  }

  function reset() {
    clearForm();
    details.open = false;
  }

  function selectOrder(id) {
    clearForm();
    order.value = id;
    details.open = true;
    email.focus();
  }

  details.addEventListener('toggle', () => {
    if (!details.open) clearForm();
  });
  form.addEventListener('input', event => {
    forgetResult();
    if (event.target !== verified) verified.checked = false;
  });
  get('recoveryClear').addEventListener('click', () => {
    clearForm();
    order.focus();
  });
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (submit.disabled) return;
    forgetResult();
    if (!form.reportValidity() || !verified.checked) return;
    const id = order.value.trim();
    if (!orderIdPattern.test(id)) {
      status.textContent = 'Enter the order ID from the live Stripe Checkout Session.';
      order.focus();
      return;
    }
    const address = email.value.trim();
    const requestRevision = revision;
    submit.disabled = true;
    status.textContent = 'Checking the order and its live Stripe payment…';
    try {
      const reply = await call('recover_paid_gift', {
        order_id: id,
        buyer_email: address,
        mailbox_verified: true
      });
      if (revision !== requestRevision || !details.open) return;
      if (typeof reply.buyer_email !== 'string' || mailboxKey(reply.buyer_email) !== mailboxKey(address) ||
          typeof reply.recovery_url !== 'string' || !recoveryUrlPattern.test(reply.recovery_url)) {
        throw new Error('Unexpected recovery response');
      }
      destination.textContent = reply.buyer_email;
      link.value = reply.recovery_url;
      result.hidden = false;
      status.textContent = 'Payment and buyer email verified.';
    } catch (error) {
      if (revision !== requestRevision) return;
      if (error.status === 401 || error.status === 403) {
        status.textContent = 'Sign in with an authorized admin account to recover a gift.';
      } else if (error.status === 400 || error.status === 409) {
        status.textContent = 'Recovery blocked. Check the order ID, buyer email and payment in Stripe.';
      } else {
        status.textContent = 'Verification is unavailable. Keep the case open and try again later.';
      }
    } finally {
      if (revision === requestRevision) submit.disabled = false;
    }
  });

  get('recoveryCopy').addEventListener('click', async () => {
    if (result.hidden || !details.open || !link.value) return;
    const copiedRevision = revision;
    try {
      await navigator.clipboard.writeText(link.value);
      if (revision === copiedRevision) status.textContent = 'Private link copied.';
    } catch {
      if (revision !== copiedRevision) return;
      link.focus();
      link.select();
      status.textContent = 'Copy the selected private link manually.';
    }
  });

  function renderOrders(orders) {
    const rows = get('orderRows');
    rows.replaceChildren();
    if (!orders.length) {
      const cell = rows.insertRow().insertCell();
      cell.colSpan = 6;
      cell.textContent = 'No gift orders yet';
      return;
    }
    for (const entry of orders) {
      const row = rows.insertRow();
      for (const value of [new Date(entry.created_at).toLocaleDateString('en-GB'), entry.recipient_name,
        entry.status, '€' + (entry.amount_cents / 100).toFixed(2), entry.buyer_email || '—']) {
        row.insertCell().textContent = value;
      }
      const action = row.insertCell();
      if (entry.status === 'paid') {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'secondary';
        button.textContent = 'Recover';
        button.addEventListener('click', () => selectOrder(entry.id));
        action.append(button);
      } else {
        action.textContent = '—';
      }
    }
  }

  return { selectOrder, renderOrders, reset };
}
