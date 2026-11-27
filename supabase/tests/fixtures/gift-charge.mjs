export function capturedGiftIntent(cents) {
  const id = 'pi_fixture';
  return {
    id, status: 'succeeded', livemode: true, currency: 'eur', amount: cents,
    amount_received: cents,
    latest_charge: {
      id: 'ch_fixture', payment_intent: id, livemode: true, status: 'succeeded',
      paid: true, captured: true, currency: 'eur', amount: cents, amount_captured: cents,
      disputed: false, refunded: false, amount_refunded: 0, refunds: { data: [], has_more: false },
    },
  };
}
