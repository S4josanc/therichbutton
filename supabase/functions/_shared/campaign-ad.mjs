// These public ad labels are shared by everyone who clicks the same advert.
const adCodes = new Set([
  "vault-v1-miami", "vault-v1-dubai", "vault-v1-london",
  "vault-v1-new-york", "vault-v1-los-angeles",
  "envelope-v2-london", "button-v2-london"
]);

export function approvedAd(value) {
  return typeof value === "string" && adCodes.has(value) ? value : null;
}

// Retry only if PostgreSQL or its schema cache explicitly rejected the ad
// column or this table's ad foreign key. Ambiguous writes must not be replayed.
export function rejectedCampaignAd(error, table) {
  const message = error?.message || "";
  if (error?.code === "23503") {
    return message.includes(`"${table}_campaign_ad_fkey"`);
  }
  return (error?.code === "PGRST204" || error?.code === "42703") &&
    /\bcampaign_ad\b/.test(message);
}
