import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";
import { approvedAd, approvedOrganicPost, rejectedCampaignAd } from "../_shared/campaign-ad.mjs";

const origin = "https://therichbutton.com";
const headers = {
  "Access-Control-Allow-Origin": origin,
  "Access-Control-Allow-Methods": "POST,OPTIONS",
  "Access-Control-Allow-Headers": "content-type",
  "Cache-Control": "no-store",
};
const pages = new Set(["home", "gift", "rich-gift", "open-gift"]);
const purchasePages = new Set(["home", "gift", "rich-gift"]);
const organicPages = new Set(["home", "gift", "rich-gift", "rich-gift-button", "gold", "platinum", "diamond"]);
const organicActions = new Set(["organic_landing", "organic_checkout_click"]);
const organicFields = new Set(["event", "page", "organic_post_id"]);
const buyerActions = new Set(["gift_personalize_start", "gift_checkout_click"]);
const recipientActions = new Set(["gift_open", "gift_reveal", "gift_cta_click"]);
const response = (status: number) => new Response(null, { status, headers });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return response(200);
  if (req.method !== "POST" || req.headers.get("origin") !== origin) return response(403);

  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object" || Array.isArray(body)) return response(400);
  const { event, page, kind, id } = body;

  let giftId = null;
  let giftKind = null;
  let ad = null;
  let post = null;
  if (organicActions.has(event)) {
    post = approvedOrganicPost(body.organic_post_id);
    if (!post || !organicPages.has(page) || Object.keys(body).some(key => !organicFields.has(key))) {
      return response(400);
    }
  } else if (!pages.has(page)) {
    return response(400);
  } else if (recipientActions.has(event)) {
    if (page === "rich-gift" || !["complimentary", "paid", "preview"].includes(kind) ||
        typeof id !== "string" || !/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id)) {
      return response(400);
    }
    giftId = id;
    giftKind = kind;
  } else {
    if (event !== "page_view" && !(page === "gift" && buyerActions.has(event))) {
      return response(400);
    }
    // Recipient or preview contexts never contribute to campaign attribution.
    if (purchasePages.has(page) && !id && !kind && body.organic_post_id == null) ad = approvedAd(body.campaign_ad);
    if (buyerActions.has(event) && (id || kind)) return response(400);
  }

  const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
    auth: { persistSession: false },
  });
  const row = { event_type: event, page, gift_kind: giftKind, gift_id: giftId,
    ...(post ? { organic_post_id: post } : {}) };
  let { error } = await db.from("rich_analytics_events").insert(ad ? { ...row, campaign_ad: ad } : row);
  if (ad && rejectedCampaignAd(error, "rich_analytics_events")) {
    ({ error } = await db.from("rich_analytics_events").insert(row));
  }
  return response(error ? 503 : 204);
});
