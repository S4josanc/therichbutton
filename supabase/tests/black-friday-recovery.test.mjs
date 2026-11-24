import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { BLACK_FRIDAY, BLACK_FRIDAY_START } from "../functions/_shared/black-friday.mjs";
import { validGiftPayment } from "../functions/_shared/gift-payment.mjs";
import { editions, reviewSession } from "../functions/rich-delivery-review/review.mjs";

const token = "10000000-0000-4000-8000-000000000001";
const successUrl = "https://therichbutton.com/edition-access.html?session_id={CHECKOUT_SESSION_ID}";
const source = await readFile(new URL("../functions/rich-gift-order-status/index.ts", import.meta.url), "utf8");

async function recover({ cents = 2450, sessionTotal = cents, campaign = BLACK_FRIDAY, status = "pending" } = {}) {
  const order = {
    id: "order1", amount_cents: cents, status, recipient_name: "Fixture", sender_name: "Sender",
    dedication: "The gift.", gift_token: null, stripe_checkout_session_id: "cs_fixture",
  };
  let updates = 0;
  const db = { from(table) {
    assert.equal(table, "rich_gift_orders");
    return {
      select(fields) {
        assert(fields.split(",").includes("amount_cents"));
        return { eq: () => ({ single: async () => ({ data: { ...order } }) }) };
      },
      update(patch) {
        return { eq(column, value) {
          assert.deepEqual([column, value], ["id", order.id]);
          return { eq: async (where, expected) => {
            assert.deepEqual([where, expected], ["status", "pending"]);
            if (order.status === expected) { Object.assign(order, patch); updates++; }
            return {};
          }};
        }};
      },
    };
  }};
  const stripe = { checkout: { sessions: { retrieve: async id => ({
    id, livemode: true, mode: "payment", currency: "eur", payment_status: "paid",
    metadata: { product: "rich-gift", order_id: order.id, campaign },
    client_reference_id: order.id, amount_total: sessionTotal, created: BLACK_FRIDAY_START,
  }) } } };
  let handler;
  runInNewContext(stripTypeScriptTypes(source.replace(/^import[^\n]*;/gm, "")), {
    Deno: { serve(fn) { handler = fn; }, env: { get: () => "sk_live_fixture" } },
    Stripe: class { constructor() { return stripe; } }, createClient: () => db, validGiftPayment,
    URL, Response, crypto: globalThis.crypto, console,
  });
  const result = await handler(new Request("https://fixture.invalid/?token=" + token + "&session_id=cs_fixture"));
  return { view: await result.json(), updates };
}

test("order-status restores a paid discounted gift after the webhook delay, without changing full-price recovery", async () => {
  for (const args of [{}, { cents: 4900, campaign: null }]) {
    const { view, updates } = await recover(args);
    assert.equal(updates, 1);
    assert.equal(view.status, "paid");
    assert.equal(view.recipient, "Fixture");
    assert.match(view.gift_url, /^https:\/\/therichbutton\.com\/open-gift\.html\?gift_token=/);
  }
  for (const args of [{ sessionTotal: 4900 }, { campaign: null }, { status: "refunded" }]) {
    const { view, updates } = await recover(args);
    assert.equal(updates, 0);
    assert.equal(view.gift_url, undefined);
  }
});

test("delivery review recognizes direct Black Friday sessions and full-price payment links", () => {
  for (const [name, rule] of Object.entries(editions)) {
    const edition = name.toLowerCase();
    for (const promo of [true, false]) {
      const cents = promo ? rule.cents / 2 : rule.cents;
      const session = {
        livemode: true, mode: "payment", currency: "eur", created: BLACK_FRIDAY_START,
        payment_link: promo ? null : { id: rule.id, after_completion: { type: "redirect", redirect: { url: successUrl } } },
        success_url: promo ? successUrl : null, metadata: promo ? { product: "rich-edition", edition, campaign: BLACK_FRIDAY } : {},
        amount_total: cents, payment_status: "paid", status: "complete",
        payment_intent: { id: "pi_fixture", latest_charge: { amount: cents, amount_refunded: 0 } },
      };
      const order = { edition, amount_cents: cents, status: "paid", access_token: token, stripe_payment_intent_id: "pi_fixture" };
      const reviewed = reviewSession(session, name, "", order);
      assert.equal(reviewed.payment, "pagado");
      assert.equal(reviewed.link, "generado");
      assert.equal(reviewSession(session, name, "", { ...order, amount_cents: cents + 1 }).access, "no coincide");
      session.payment_intent.latest_charge.amount_refunded = cents;
      assert.equal(reviewSession(session, name, "", { ...order, status: "refunded" }).access, "revocado");
      assert.equal(reviewSession(session, name, "", order).payment, "reembolsado");
      if (promo) {
        assert.equal(reviewSession({ ...session, success_url: null }, name, "", order).link, "no coincide");
        assert.equal(reviewSession({ ...session, metadata: {} }, name, "", order).payment, "no coincide");
      }
    }
  }
});
