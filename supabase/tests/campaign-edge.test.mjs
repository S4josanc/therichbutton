import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import { runInNewContext } from "node:vm";
import { validatePaidSession } from "../functions/rich-edition-access/handler.js";
import { approvedAd, rejectedCampaignAd } from "../functions/_shared/campaign-ad.mjs";

// No Deno process, keys or network. Execute the deployed entrypoints' request
// handlers with the SDK constructors replaced by in-memory doubles.
async function loadHandler(name, db, stripe, settings = {}) {
  const path = new URL(`../functions/${name}/index.ts`, import.meta.url);
  const source = (await readFile(path, "utf8")).replace(/^import[^\n]*;\r?$/gm, "");
  let handler;
  const env = {
    STRIPE_SECRET_KEY: "sk_live_fixture", STRIPE_WEBHOOK_SECRET: "fixture", SUPABASE_URL: "https://fixture.invalid",
    SUPABASE_SERVICE_ROLE_KEY: "fixture", ...settings
  };
  runInNewContext(stripTypeScriptTypes(source), {
    Deno: { serve: fn => { handler = fn; }, env: { get: key => env[key] } },
    Stripe: class { constructor() { return stripe; } static createSubtleCryptoProvider() { return {}; } },
    createClient: () => db,
    approvedAd, rejectedCampaignAd, validatePaidSession, Response, crypto: globalThis.crypto, console: { error() {}, log() {} }
  });
  return (payload, origin = "https://therichbutton.com", headers = {}) => handler(new Request("https://fixture.invalid", {
    method: "POST", headers: { "Content-Type": "application/json", Origin: origin, ...headers },
    body: JSON.stringify(payload)
  }));
}

function clone(data) {
  return JSON.parse(JSON.stringify(data));
}

const ad = "vault-v1-dubai";
const columnError = { code: "PGRST204", message: "Could not find the 'campaign_ad' column in the schema cache" };
const baseVisit = { event_type: "page_view", page: "home", gift_kind: null, gift_id: null };

async function analyticsFixture(errors = []) {
  const rows = [];
  const db = { from(table) {
    assert.equal(table, "rich_analytics_events");
    return { async insert(row) { rows.push(clone(row)); return { error: errors.shift() }; } };
  } };
  return { rows, post: await loadHandler("rich-analytics", db) };
}

test("tags only homepage visits and drops arbitrary fields and ad strings", async () => {
  const { rows, post } = await analyticsFixture();
  const visit = { event: "page_view", page: "home" };
  assert.equal((await post({ ...visit, campaign_ad: ad, email: "private@example.invalid",
    fbclid: "unwanted", url: "https://example.invalid" })).status, 204);
  assert.deepEqual(rows[0], { ...baseVisit, campaign_ad: ad });
  for (const value of [undefined, "private@example.invalid", { city: "dubai" }, [ad], ad + " "]) {
    assert.equal((await post({ ...visit, campaign_ad: value })).status, 204);
    assert.deepEqual(rows.at(-1), baseVisit);
  }
  assert.equal((await post({ event: "page_view", page: "gift", campaign_ad: ad })).status, 204);
  assert.deepEqual(rows.at(-1), { ...baseVisit, page: "gift" });
  const id = "00000000-0000-4000-8000-000000000001";
  assert.equal((await post({ event: "gift_open", page: "open-gift", kind: "paid", id, campaign_ad: ad })).status, 204);
  assert.deepEqual(rows.at(-1), { event_type: "gift_open", page: "open-gift", gift_kind: "paid", gift_id: id });
  const count = rows.length;
  assert.equal((await post({ event: "purchase", page: "home", campaign_ad: ad })).status, 400);
  assert.equal((await post({ event: "gift_open", page: "open-gift", kind: "paid", id: "bad" })).status, 400);
  assert.equal((await post(visit, "https://other.invalid")).status, 403);
  assert.equal(rows.length, count);
});

test("a schema-cache rejection of the campaign column permits one untagged fallback insert", async () => {
  const payload = { event: "page_view", page: "home", campaign_ad: ad };
  const f = await analyticsFixture([columnError]);
  assert.equal((await f.post(payload)).status, 204);
  assert.deepEqual(f.rows, [{ ...baseVisit, campaign_ad: ad }, baseVisit]);
  const other = await analyticsFixture([{ code: "42703", message: "another_field is missing" }]);
  assert.equal((await other.post(payload)).status, 503);
  assert.equal(other.rows.length, 1);
});

async function checkoutFixture({ live = true, failCreate = false, linkErrors = [], settings } = {}) {
  const inserts = [], updates = [], sessions = [], expirations = [];
  const db = { from(table) {
    assert.equal(table, "rich_gift_orders");
    return {
      insert(row) {
        inserts.push(clone(row));
        return { select: () => ({ single: async () => ({ data: { id: "order1", access_token: "private" } }) }) };
      },
      select() { // Existing paid gift referrer.
        return { eq() { return this; }, maybeSingle: async () => ({ data: { id: "source" } }) };
      },
      update(row) {
        updates.push(clone(row));
        return {
          eq() { return this; }, select() { return this; },
          single: async () => ({ error: linkErrors.shift() })
        };
      }
    };
  } };
  const stripe = { checkout: { sessions: {
    async create(params, options) {
      sessions.push({ params: clone(params), options: clone(options) });
      if (failCreate) throw Error("fixture");
      return { id: "cs_fixture", url: "https://checkout.stripe.com/fixture", livemode: live };
    },
    async expire(id) { expirations.push(id); }
  } } };
  return { inserts, updates, sessions, expirations, post: await loadHandler("rich-gift-checkout", db, stripe, settings) };
}

const buyer = { recipient: "Example", sender: "Fixture", message: "Hello" };
const checkoutUrl = "https://checkout.stripe.com/fixture";
const cancelUrl = "https://therichbutton.com/gift.html?tier=rich-gift&checkout=cancelled";

test("attaches an ad to exactly the existing live session and retains it on cancellation", async () => {
  const f = await checkoutFixture();
  const response = await f.post({ ...buyer, campaign_ad: ad, utm_term: "arbitrary", fbclid: "click" });
  assert.deepEqual(await response.json(), { checkout_url: checkoutUrl });
  assert.deepEqual(f.inserts, [{ recipient_name: "Example", sender_name: "Fixture", dedication: "Hello",
    wall_opt_in: false, wall_alias: null, referral_kind: null, referral_token: null }]);
  assert.deepEqual(f.updates, [{ stripe_checkout_session_id: "cs_fixture", campaign_ad: ad }]);
  assert.equal(f.sessions.length, 1);
  const { params, options } = f.sessions[0];
  assert.equal(params.client_reference_id, "order1");
  assert.deepEqual(params.metadata, { order_id: "order1", product: "rich-gift" });
  assert.equal(params.cancel_url, cancelUrl + "&trb_ad=" + ad);
  assert.equal(params.success_url.includes(ad), false);
  assert.deepEqual(options, { idempotencyKey: "rich-gift-order1" });
});

test("untagged, unknown and recipient referral purchases preserve the live checkout behavior", async () => {
  const referral = "00000000-0000-4000-8000-000000000001";
  for (const extra of [{}, { campaign_ad: "private@example.invalid" }, { campaign_ad: ad, referral_kind: "paid", referral }]) {
    const f = await checkoutFixture();
    assert.equal((await f.post({ ...buyer, ...extra })).status, 200);
    assert.deepEqual(f.updates, [{ stripe_checkout_session_id: "cs_fixture" }]);
    assert.equal(f.sessions[0].params.cancel_url, cancelUrl);
    if (extra.referral) assert.equal(f.inserts[0].referral_token, referral);
  }
});

test("invalid request, test key, test session and failed session never produce attributed checkout starts", async () => {
  const invalid = await checkoutFixture();
  assert.equal((await invalid.post({ campaign_ad: ad })).status, 400);
  assert.deepEqual(invalid.inserts, []);
  const testKey = await checkoutFixture({ settings: { STRIPE_SECRET_KEY: "sk_test_fixture" } });
  assert.equal((await testKey.post({ ...buyer, campaign_ad: ad })).status, 503);
  assert.deepEqual(testKey.inserts, []);
  for (const config of [{ live: false }, { failCreate: true }]) {
    const f = await checkoutFixture(config);
    assert.equal((await f.post({ ...buyer, campaign_ad: ad })).status, 503);
    assert.equal("campaign_ad" in f.inserts[0], false);
    assert.deepEqual(f.updates, []);
    assert.deepEqual(f.expirations, config.live === false ? ["cs_fixture"] : []);
  }
});

test("schema-cache delay leaves one usable live session, ordinary update failure expires it", async () => {
  const f = await checkoutFixture({ linkErrors: [columnError] });
  assert.equal((await f.post({ ...buyer, campaign_ad: ad })).status, 200);
  assert.deepEqual(f.updates, [
    { stripe_checkout_session_id: "cs_fixture", campaign_ad: ad },
    { stripe_checkout_session_id: "cs_fixture" }
  ]);
  assert.equal(f.sessions.length, 1);
  assert.equal(f.inserts.length, 1);
  assert.deepEqual(f.expirations, []);
  const failure = await checkoutFixture({ linkErrors: [{ code: "XX000", message: "connection failed" }] });
  assert.equal((await failure.post({ ...buyer, campaign_ad: ad })).status, 500);
  assert.equal(failure.updates.length, 1);
  assert.deepEqual(failure.expirations, ["cs_fixture"]);
});

test("verified gift fulfillment retains the checkout's ad; replay cannot duplicate or reactivate a sale", async () => {
  const row = { id: "order1", stripe_checkout_session_id: "cs_fixture", status: "pending",
    campaign_ad: ad, email_sent_at: "2026-11-22" };
  const writes = [];
  const db = { from(table) {
    assert.equal(table, "rich_gift_orders");
    return {
      select() { return { eq() { return this; }, single: async () => ({ data: { ...row } }) }; },
      update(values) {
        assert.equal(values.status, "paid");
        return { eq: () => ({ eq: async () => {
          writes.push(clone(values)); Object.assign(row, values); return {};
        } }) };
      }
    };
  } };
  const stripe = { webhooks: { async constructEventAsync(text, signature) {
    if (signature !== "fixture") throw Error("signature");
    return JSON.parse(text);
  } } };
  const send = await loadHandler("stripe-gift-webhook", db, stripe);
  const event = { type: "checkout.session.completed", livemode: true, data: { object: {
    id: row.stripe_checkout_session_id, livemode: true, payment_status: "paid", mode: "payment",
    currency: "eur", amount_total: 4900, metadata: { product: "rich-gift", order_id: row.id }
  } } };
  const fire = (body, signature = "fixture") => send(body, undefined, { "stripe-signature": signature });
  assert.equal((await fire(event, "invalid")).status, 400);
  assert.equal((await fire({ ...event, livemode: false })).status, 400);
  const change = fields => ({ ...event, data: { object: { ...event.data.object, ...fields } } });
  assert.equal((await fire(change({ id: "other" }))).status, 409);
  assert.equal((await (await fire(change({ payment_status: "unpaid" }))).json()).ignored, true);
  assert.equal((await (await fire(change({ amount_total: 100 }))).json()).ignored, true);
  assert.equal(writes.length, 0);
  assert.equal((await fire(event)).status, 200);
  assert.equal((await fire(event)).status, 200);
  assert.equal(row.status, "paid");
  assert.equal(row.campaign_ad, ad);
  row.status = "refunded";
  assert.equal((await (await fire(event)).json()).ignored, true);
  assert.equal(writes.length, 1);
  assert.equal(row.status, "refunded");
});

test("an absent catalog entry drops only the optional ad, unrelated foreign keys still fail", async () => {
  const fk = name => ({ code: "23503", message: `violates foreign key constraint "${name}"` });
  const eventFk = fk("rich_analytics_events_campaign_ad_fkey");
  const orderFk = fk("rich_gift_orders_campaign_ad_fkey");
  const payload = { event: "page_view", page: "home", campaign_ad: ad };
  const visit = await analyticsFixture([eventFk]);
  assert.equal((await visit.post(payload)).status, 204);
  assert.deepEqual(visit.rows, [{ ...baseVisit, campaign_ad: ad }, baseVisit]);

  const order = await checkoutFixture({ linkErrors: [orderFk] });
  assert.equal((await order.post({ ...buyer, campaign_ad: ad })).status, 200);
  assert.deepEqual(order.updates, [
    { stripe_checkout_session_id: "cs_fixture", campaign_ad: ad },
    { stripe_checkout_session_id: "cs_fixture" }
  ]);
  assert.equal(order.sessions.length, 1);
  assert.equal(order.inserts.length, 1);
  assert.deepEqual(order.expirations, []);

  const rejectedVisit = await analyticsFixture([orderFk]);
  assert.equal((await rejectedVisit.post(payload)).status, 503);
  assert.equal(rejectedVisit.rows.length, 1);
  const rejectedOrder = await checkoutFixture({ linkErrors: [fk("rich_gift_orders_unrelated_fkey")] });
  assert.equal((await rejectedOrder.post({ ...buyer, campaign_ad: ad })).status, 500);
  assert.equal(rejectedOrder.updates.length, 1);
  assert.deepEqual(rejectedOrder.expirations, ["cs_fixture"]);
});
