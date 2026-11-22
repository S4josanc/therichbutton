import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { readMetaReport } from "../functions/rich-admin/meta-report.ts";

const account = "4729769513972199";
const purchaseField = "actions_offsite_conversion_fb_pixel_purchase";
// In Bratislava it is already 2 November. The reporting interval crosses the end of DST.
const now = new Date("2026-11-01T23:30:00Z");
const key = "fixture-only";
const base = { account_id: account, ad_id: "101", date: "2026-11-02", currency: "EUR" };
const delivery = { ...base, spend: "8.75", impressions: 100, link_clicks: 5 };
const purchase = { ...base, [purchaseField]: 1 };
const metrics = result => [result.spend, result.impressions, result.clicks, result.purchases];

function fixture(rows, purchases, { apiKey = key, verifiedFrom } = {}) {
  const calls = [];
  async function request(url, options) {
    const target = new URL(url);
    calls.push({ target, options });
    const fields = target.searchParams.get("fields").split(",");
    const response = fields.includes(purchaseField) ? purchases : rows;
    if (response instanceof Error) throw response;
    if (response instanceof Response) return response;
    return Response.json({ data: response });
  }
  return { calls, report: () => readMetaReport(apiKey, verifiedFrom, now, request) };
}

test("reads the dedicated Meta account, with link clicks and the account's 30 calendar dates", async () => {
  const { calls, report } = fixture([delivery], [purchase]);
  const result = await report();
  assert.equal(result.state, "reported");
  assert.deepEqual(metrics(result), [8.75, 100, 5, 1]);
  assert.equal(result.currency, "EUR");
  assert.deepEqual(result.period, { from: "2026-10-04", to: "2026-11-02" });
  assert.equal(result.queried_at, now.toISOString());
  assert.ok(calls.length > 0);
  for (const { target, options } of calls) {
    assert.equal(target.origin + target.pathname, "https://connectors.windsor.ai/facebook");
    assert.equal(options?.method ?? "GET", "GET");
    assert.equal(target.searchParams.get("select_accounts"), account);
    assert.equal(target.searchParams.get("date_from"), result.period.from);
    assert.equal(target.searchParams.get("date_to"), result.period.to);
    assert.ok(options?.signal instanceof AbortSignal);
  }
  assert.ok(!JSON.stringify(result).includes(key));
});

test("an unconfigured or empty source returns no amounts or counts", async () => {
  const pending = fixture([], [], { apiKey: "" });
  const missing = await pending.report();
  assert.equal(missing.state, "pending");
  assert.equal(pending.calls.length, 0);
  const empty = await fixture([], []).report();
  assert.equal(empty.state, "empty");
  for (const result of [missing, empty]) assert.deepEqual(metrics(result), [null, null, null, null]);
});

test("a report still being prepared stays pending even when it includes an empty data array", async () => {
  for (const response of [new Response(null, { status: 202 }), Response.json({ status: "pending", data: [] })]) {
    const result = await fixture(response, []).report();
    assert.equal(result.state, "pending");
    assert.match(result.reason, /preparando/);
    assert.deepEqual(metrics(result), [null, null, null, null]);
  }
});

test("distinguishes zero link clicks from an unavailable spend and an unverified purchase zero", async () => {
  const row = { ...delivery, spend: null, link_clicks: 0, clicks: 12 };
  const zero = { ...purchase, [purchaseField]: "0" };
  const result = await fixture([row], [zero]).report();
  assert.equal(result.state, "reported");
  assert.deepEqual(metrics(result), [null, 100, 0, null]);
  for (const verifiedFrom of ["2026-10-05", "2026-09-31", "yesterday"]) {
    const partial = await fixture([row], [zero], { verifiedFrom }).report();
    assert.equal(partial.purchases, null);
  }
  const confirmed = await fixture([{ ...row, spend: 0 }], [zero], { verifiedFrom: "2026-10-04" }).report();
  assert.deepEqual(metrics(confirmed), [0, 100, 0, 0]);
});

test("sums distinct ad-day records and keeps delivery when purchase coverage is incomplete or unavailable", async () => {
  const rows = [delivery, { ...delivery, ad_id: "102" }];
  const both = await fixture(rows, [purchase, { ...purchase, ad_id: "102" }]).report();
  assert.deepEqual(metrics(both), [17.5, 200, 10, 2]);
  for (const purchases of [[purchase], [], new Response(null, { status: 403 })]) {
    const partial = await fixture(rows, purchases, { verifiedFrom: "2026-10-04" }).report();
    assert.deepEqual(metrics(partial), [17.5, 200, 10, null]);
  }
});

test("refuses duplicate, foreign-account or out-of-period delivery totals", async () => {
  for (const second of [delivery, { ...delivery, account_id: "999" }, { ...delivery, date: "2026-10-03" }]) {
    const result = await fixture([delivery, second], [purchase]).report();
    assert.deepEqual(metrics(result), [null, null, null, null]);
  }
});

test("never combines amounts across currencies and never turns a provider failure into zero", async () => {
  const mixed = await fixture([delivery, { ...delivery, ad_id: "102", currency: "USD" }], []).report();
  assert.equal(mixed.spend, null);
  for (const outcome of [new Response("private error", { status: 403 }), new DOMException("timeout", "TimeoutError")]) {
    const failed = await fixture(outcome, []).report();
    assert.notEqual(failed.state, "reported");
    assert.deepEqual(metrics(failed), [null, null, null, null]);
    assert.ok(!JSON.stringify(failed).includes("private error"));
  }
});

test("only the verified administrator can invoke the Meta report", async () => {
  const handler = await readFile(new URL("../functions/rich-admin/index.ts", import.meta.url), "utf8");
  const guard = handler.indexOf("if(error||!user||!user.email_confirmed_at");
  const action = handler.search(/payload\.action\s*===\s*"meta_report"/);
  assert.ok(guard >= 0 && action > guard);
});
