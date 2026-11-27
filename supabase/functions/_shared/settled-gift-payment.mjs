import { validGiftPayment } from "./gift-payment.mjs";

// A pending order can lack a payment intent until its first verified fulfillment.
export function settledGiftPayment(session, order) {
  if (!validGiftPayment(session, order) || order.currency !== session.currency || session.status !== "complete" ||
      session.client_reference_id !== order.id) return false;
  const total = session.amount_total;
  const intent = session.payment_intent;
  if (!intent?.id?.startsWith("pi_") ||
      (order.stripe_payment_intent_id && intent.id !== order.stripe_payment_intent_id) ||
      intent.livemode !== true || intent.status !== "succeeded" || intent.currency !== session.currency ||
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
