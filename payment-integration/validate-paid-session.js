// Caller must verify the Stripe signature before invoking this function.
export function classifyPaidSession(event, expected) {
  if (!event || event.livemode !== true) return null;
  if (!["checkout.session.completed", "checkout.session.async_payment_succeeded"].includes(event.type)) return null;
  const session = event.data?.object;
  if (!session || session.livemode !== true || session.mode !== "payment" || session.payment_status !== "paid") return null;
  if (typeof session.id !== "string" || !session.id.startsWith("cs_live_")) return null;
  const link = typeof session.payment_link === "string" ? session.payment_link : session.payment_link?.id;
  const product = expected[link];
  if (!product || session.currency !== "eur" || session.amount_total !== product.amountCents) return null;
  return { sessionId: session.id, paymentLinkId: link, edition: product.edition };
}
