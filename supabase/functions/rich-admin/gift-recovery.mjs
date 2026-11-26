import { validGiftPayment } from "../_shared/gift-payment.mjs";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ineligible = { status: 409, body: { error: "This order could not be verified for recovery." } };

function mailbox(value) {
  if (typeof value !== "string" || value.length > 254) return "";
  const email = value.trim();
  if (!/^[^\s@,;<>]+@[^\s@,;<>]+$/.test(email) || /[\x00-\x1f\x7f]/.test(email)) return "";
  // Match the local part exactly. Never strip plus tags or dots.
  const at = email.indexOf("@");
  return email.slice(0, at + 1) + email.slice(at + 1).toLowerCase();
}

function fulfilledOrder(order, id, email) {
  return order?.id === id && order.status === "paid" && Boolean(order.paid_at) &&
    order.currency === "eur" && mailbox(order.buyer_email) === email &&
    uuid.test(order.gift_token) && uuid.test(order.access_token) &&
    order.stripe_checkout_session_id?.startsWith("cs_live_") &&
    order.stripe_payment_intent_id?.startsWith("pi_");
}

function settledPayment(session, order) {
  if (!validGiftPayment(session, order) || session.status !== "complete" ||
      session.client_reference_id !== order.id) return false;
  const total = session.amount_total;
  const intent = session.payment_intent;
  if (intent?.id !== order.stripe_payment_intent_id || intent.livemode !== true ||
      intent.status !== "succeeded" || intent.currency !== session.currency ||
      intent.amount !== total || intent.amount_received !== total) return false;
  const charge = intent.latest_charge;
  return typeof charge?.id === "string" && charge.id.length > 0 && charge.payment_intent === intent.id &&
    charge.livemode === true && charge.status === "succeeded" &&
    charge.paid === true && charge.captured === true && charge.currency === session.currency &&
    charge.amount === total && charge.amount_captured === total &&
    charge.disputed === false && charge.refunded === false && charge.amount_refunded === 0 &&
    Array.isArray(charge.refunds?.data) && charge.refunds.data.length === 0 &&
    charge.refunds.has_more === false;
}

export async function recoverPaidGift(request, { loadOrder, loadSession, recordAudit }) {
  const id = typeof request?.order_id === "string" ? request.order_id.trim().toLowerCase() : "";
  const email = mailbox(request?.buyer_email);
  if (!uuid.test(id) || !email || request.mailbox_verified !== true) {
    return { status: 400, body: { error: "Provide the order ID and verified checkout email." } };
  }
  try {
    const order = await loadOrder(id);
    if (!fulfilledOrder(order, id, email)) return ineligible;
    const session = await loadSession(order.stripe_checkout_session_id);
    const destination = session?.customer_details?.email || session?.customer_email;
    if (mailbox(destination) !== email || !settledPayment(session, order)) return ineligible;

    // Re-read after Stripe in case the order was revoked while checking the charge.
    const current = await loadOrder(id);
    if (!fulfilledOrder(current, id, email) || !settledPayment(session, current)) return ineligible;
    await recordAudit(id);
    return {
      status: 200,
      body: {
        recovery_url: "https://therichbutton.com/gift.html?order=" + current.access_token,
        buyer_email: destination.trim(),
      },
    };
  } catch {
    return { status: 503, body: { error: "Recovery is temporarily unavailable." } };
  }
}
