import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { settledGiftPayment } from "../functions/_shared/settled-gift-payment.mjs";
import { capturedGiftIntent } from "./fixtures/gift-charge.mjs";
import { BLACK_FRIDAY, BLACK_FRIDAY_START } from "../functions/_shared/black-friday.mjs";
import { writeOrganicOrder } from "../functions/_shared/organic-order.mjs";
import { validGiftPayment, giftOrganicFields } from "../functions/_shared/gift-payment.mjs";
import { editions, reviewSession } from "../functions/rich-delivery-review/review.mjs";

const token = "10000000-0000-4000-8000-000000000001";
const successUrl = "https://therichbutton.com/edition-access.html?session_id={CHECKOUT_SESSION_ID}";
const source = await readFile(new URL("../functions/rich-gift-order-status/index.ts", import.meta.url), "utf8");

function recoveryFixture({ cents = 2450, campaign = BLACK_FRIDAY, status = "pending" } = {}) {
  const order = {
    id: "order1", access_token: token, amount_cents: cents, currency: "eur", status, recipient_name: "Fixture",
    sender_name: "Sender", dedication: "The gift.", gift_token: status === "paid" ? "existing-gift" : null,
    stripe_checkout_session_id: "cs_live_fixture", stripe_payment_intent_id: status === "paid" ? "pi_fixture" : null,
  };
  const session = {
    id: order.stripe_checkout_session_id, livemode: true, mode: "payment", currency: "eur",
    status: "complete", payment_status: "paid", metadata: { product: "rich-gift", order_id: order.id, campaign },
    client_reference_id: order.id, amount_total: cents, created: BLACK_FRIDAY_START,
    payment_intent: capturedGiftIntent(cents), customer_details: { email: "buyer@example.invalid" },
  };
  const reads = [];
  let updates = 0;
  let now = BLACK_FRIDAY_START * 1000;
  let handler;
  const fixture = {
    order, session, reads, beforeStripeReply: () => {}, beforeWrite: () => {},
    get updates() { return updates; },
    advance(milliseconds) { now += milliseconds; },
    async status({ sessionId = null, purchase = false, accessToken = token } = {}) {
      const url = new URL("https://fixture.invalid/");
      url.searchParams.set("token", accessToken);
      if (sessionId !== null) url.searchParams.set("session_id", sessionId);
      if (purchase) url.searchParams.set("purchase", "1");
      return (await handler(new Request(url))).json();
    },
  };
  const db = { from(table) {
    assert.equal(table, "rich_gift_orders");
    const filters = [];
    let patch;
    async function execute() {
      if (patch) await fixture.beforeWrite();
      if (!filters.every(([field, value]) => order[field] === value)) return {data: null};
      if (patch) {
        assert.ok(filters.some(([field, value]) => field === "status" && value === "pending"));
        Object.assign(order, patch);
        updates++;
      }
      return {data: {...order}};
    }
    return {
      select() { return this; },
      update(values) { patch = values; return this; },
      eq(field, value) { filters.push([field, value]); return this; },
      single: execute, maybeSingle: execute,
      then(yes, no) { return execute().then(yes, no); },
    };
  }};
  const stripe = { checkout: { sessions: { retrieve: async (id, options) => {
    reads.push({id, expand: [...(options?.expand ?? [])]});
    await fixture.beforeStripeReply();
    return structuredClone(session);
  } } } };
  runInNewContext(stripTypeScriptTypes(source.replace(/^import[^\n]*;/gm, "")), {
    Deno: { serve(fn) { handler = fn; }, env: { get: () => "sk_live_fixture" } },
    Stripe: class { constructor() { return stripe; } }, createClient: () => db,
    validGiftPayment, settledGiftPayment, giftOrganicFields, writeOrganicOrder,
    URL, Response, crypto: globalThis.crypto, console: { error() {} },
    Date: class extends Date { static now() { return now; } },
  });
  return fixture;
}

function assertWithheld(view, reason) {
  for (const field of ["gift_url", "recipient", "sender", "message", "gift_token", "buyer_email"]) {
    assert.equal(view[field], undefined, reason + ": " + field);
  }
}

test("a saved buyer link or the matching checkout return restores a settled full-price or Black Friday Gift", async () => {
  for (const args of [{}, { cents: 4900, campaign: null }]) {
    for (const sessionId of [null, "", "cs_live_fixture"]) {
      const f = recoveryFixture(args);
      const view = await f.status({sessionId});
      assert.equal(view.status, "paid");
      assert.equal(view.recipient, "Fixture");
      assert.equal(view.gift_url, "https://therichbutton.com/open-gift.html?gift_token=" + f.order.gift_token);
      assert.equal(view.purchase, undefined);
      assert.equal(f.updates, 1);
      assert.deepEqual(f.reads, [{id: "cs_live_fixture", expand: ["payment_intent.latest_charge.refunds"]}]);
      assert.equal(f.order.stripe_payment_intent_id, "pi_fixture");
      assert.equal(f.order.buyer_email, "buyer@example.invalid");
    }
  }
});

test("a supplied foreign session, invalid buyer token, and conversion-only calls cannot claim a pending gift", async () => {
  const f = recoveryFixture();
  for (const request of [
    {sessionId: "cs_live_someone_else"}, {sessionId: "cs_test_fixture"},
    {accessToken: "20000000-0000-4000-8000-000000000002"},
    {sessionId: "cs_live_someone_else", purchase: true}, {purchase: true},
  ]) {
    const view = await f.status(request);
    assertWithheld(view, JSON.stringify(request));
    if (request.purchase) assert.deepEqual(view, {purchase: null});
  }
  assert.deepEqual(f.reads, []);
  assert.equal(f.updates, 0);
});

test("invalid Stripe evidence never fulfills or reveals a pending gift", async () => {
  const cases = [
    ["unpaid", f => { f.session.payment_status = "unpaid"; }],
    ["incomplete", f => { f.session.status = "open"; }],
    ["sandbox", f => { f.session.livemode = false; }],
    ["wrong product", f => { f.session.metadata.product = "another-product"; }],
    ["wrong order", f => { f.session.metadata.order_id = "other"; }],
    ["wrong client reference", f => { f.session.client_reference_id = "other"; }],
    ["wrong session", f => { f.session.id = "cs_live_someone_else"; }],
    ["wrong amount", f => { f.session.amount_total = 4900; }],
    ["wrong stored currency", f => { f.order.currency = "usd"; }],
    ["wrong currency", f => { f.session.currency = "usd"; }],
    ["invalid discount", f => { f.session.metadata.campaign = null; }],
    ["unexpanded intent", f => { f.session.payment_intent = "pi_fixture"; }],
    ["wrong stored intent", f => { f.order.stripe_payment_intent_id = "pi_other"; }],
    ["unsettled intent", f => { f.session.payment_intent.status = "processing"; }],
    ["wrong received amount", f => { f.session.payment_intent.amount_received--; }],
    ["unlinked charge", f => { f.session.payment_intent.latest_charge.payment_intent = "pi_other"; }],
    ["uncaptured", f => { f.session.payment_intent.latest_charge.captured = false; }],
    ["refunded", f => { f.session.payment_intent.latest_charge.refunded = true; }],
    ["partial refund", f => { f.session.payment_intent.latest_charge.amount_refunded = 100; }],
    ["pending refund", f => { f.session.payment_intent.latest_charge.refunds.data = [{status: "pending"}]; }],
    ["incomplete refund list", f => { f.session.payment_intent.latest_charge.refunds.has_more = true; }],
    ["unavailable refund list", f => { delete f.session.payment_intent.latest_charge.refunds; }],
    ["disputed", f => { f.session.payment_intent.latest_charge.disputed = true; }],
    ["Stripe unavailable", f => { f.beforeStripeReply = () => { throw Error("private diagnostic"); }; }],
  ];
  for (const [reason, change] of cases) {
    const f = recoveryFixture();
    change(f);
    const view = await f.status();
    assertWithheld(view, reason);
    assert.equal(JSON.stringify(view).includes("private diagnostic"), false);
    assert.equal(f.updates, 0, reason);
  }
  const local = recoveryFixture({status: "refunded"});
  assertWithheld(await local.status(), "local refund");
  assert.deepEqual(local.reads, []);
});

test("a webhook winning fulfillment keeps its gift token and a concurrent revocation cannot be overwritten", async () => {
  const paid = recoveryFixture();
  paid.beforeWrite = () => {
    Object.assign(paid.order, {status: "paid", gift_token: "winner-private", stripe_payment_intent_id: "pi_fixture"});
  };
  assert.equal((await paid.status()).gift_url, "https://therichbutton.com/open-gift.html?gift_token=winner-private");
  assert.equal(paid.updates, 0);
  const revoked = recoveryFixture();
  revoked.beforeStripeReply = () => { revoked.order.status = "refunded"; };
  assertWithheld(await revoked.status(), "concurrent refund");
  assert.equal(revoked.updates, 0);
});

test("an unpaid recovery tab backs off but a real checkout return can confirm immediately", async () => {
  const f = recoveryFixture();
  f.session.payment_status = "unpaid";
  for (let i = 0; i < 5; i++) assertWithheld(await f.status(), "unpaid");
  assert.equal(f.reads.length, 1);
  f.session.payment_status = "paid";
  assert.equal((await f.status({sessionId: f.session.id})).status, "paid");
  assert.equal(f.updates, 1);

  const delayed = recoveryFixture();
  delayed.session.payment_status = "unpaid";
  assertWithheld(await delayed.status(), "first request");
  delayed.session.payment_status = "paid";
  delayed.advance(12_000);
  assert.equal((await delayed.status()).status, "paid");
  assert.equal(delayed.updates, 1);
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
