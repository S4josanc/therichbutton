// Called only with a Stripe-signed event or a session retrieved from Stripe.
import { BLACK_FRIDAY, isBlackFriday, LIST_CENTS, quotePrice } from "./black-friday.mjs";

import { approvedOrganicPost } from "./campaign-ad.mjs";

// The caller must have matched a paid Stripe session to the stored order.
export function giftOrganicFields(session, verifiedAt) {
  const post = approvedOrganicPost(session.metadata?.organic_post_id);
  return post ? {organic_post_id: post, organic_verified_at: verifiedAt} : {};
}

export function validGiftPayment(session, order) {
  if (!order || session?.livemode !== true || session.mode !== "payment" ||
      session.payment_status !== "paid" || session.currency !== "eur" ||
      session.metadata?.product !== "rich-gift" || !order.id ||
      session.metadata.order_id !== order.id || !order.stripe_checkout_session_id ||
      session.id !== order.stripe_checkout_session_id || session.amount_total !== order.amount_cents) {
    return false;
  }
  // Pre-promotion sessions have no campaign tag and always use the normal price.
  if (!session.metadata.campaign) return session.amount_total === LIST_CENTS["rich-gift"];
  return session.metadata.campaign === BLACK_FRIDAY && isBlackFriday(session.created) &&
    session.amount_total === quotePrice("rich-gift", session.created).cents;
}
