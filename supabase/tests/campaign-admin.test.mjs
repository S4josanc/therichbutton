import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const html = await readFile(new URL('../../admin.html', import.meta.url), 'utf8');
const reportSource = html.slice(html.indexOf('let campaignRequestId = 0;'), html.indexOf('async function load(){'));
const handler = await readFile(new URL('../functions/rich-admin/index.ts', import.meta.url), 'utf8');

function fakeElement() {
  return {
    hidden: false,
    children: [],
    textContent: '',
    appendChild(child) { this.children.push(child); },
    replaceChildren() { this.children = []; }
  };
}

function panel(request) {
  const ids = ['campaignStatus', 'campaignTable', 'campaignRows', 'campaignTotals',
    ...Array.from(html.matchAll(/<dd id="(adSummary\w+)"/g), match => match[1])];
  const elements = Object.fromEntries(ids.map(id => [id, fakeElement()]));
  const document = { getElementById: id => elements[id], createElement: fakeElement };
  const load = vm.runInNewContext(reportSource + '\nloadCampaignReport', { document, call: request });
  return { elements, load };
}

test('the dashboard displays aggregate figures including zero and clears old rows on refresh', async () => {
  const { elements, load } = panel(async action => {
    assert.equal(action, 'campaign_report');
    return { ads: [{ campaign: 'christmas_2026', ad_code: 'vault-v1-miami', target_city: 'Miami', home_views: 3, checkout_starts: 1, paid_gifts: 0 }] };
  });
  await load();
  await load();
  assert.equal(elements.campaignTable.hidden, false);
  assert.equal(elements.campaignRows.children.length, 1);
  assert.deepEqual(elements.campaignRows.children[0].children.map(c => c.textContent),
    ['christmas_2026', 'vault-v1-miami', 'Miami', '3', '—', '—', '—', '—', '1', '0']);
  assert.equal(elements.adSummaryViews.textContent, '3');
  assert.equal(elements.adSummaryOffer.textContent, '—');
  assert.equal(elements.adSummaryPaid.textContent, '0');
});

test('unavailable campaign figures do not interrupt other admin data or show stale counts', async () => {
  let offline = false;
  const { elements, load } = panel(async () => {
    if (offline) throw Error('RPC unavailable');
    return { ads: [] };
  });
  await load();
  assert.equal(elements.campaignStatus.textContent, 'Todavía no hay anuncios registrados.');
  elements.campaignRows.children.push(fakeElement());
  offline = true;
  await load();
  assert.equal(elements.campaignStatus.textContent, 'Ahora mismo no se puede consultar el informe de campaña.');
  assert.equal(elements.campaignTable.hidden, true);
  assert.equal(elements.campaignRows.children.length, 0);
});

test('attributed events and real Stripe sessions have separate rows and totals', async () => {
  const ad = { campaign: 'christmas_2026', ad_code: 'vault-v1-miami', target_city: 'Miami',
    home_views: 3, gift_offer_views: 5, gift_form_views: 4, personalization_starts: 2,
    checkout_clicks: 1, checkout_starts: 0, paid_gifts: 0 };
  const second = { ...ad, ad_code: 'vault-v1-london', target_city: 'London', checkout_clicks: 2,
    checkout_starts: 1, paid_gifts: '1' };
  const { elements, load } = panel(async () => ({ ads: [ad, second] }));
  await load();
  assert.deepEqual(elements.campaignRows.children[0].children.slice(3).map(cell => cell.textContent),
    ['3', '5', '4', '2', '1', '0', '0']);
  assert.deepEqual([elements.adSummaryOffer, elements.adSummaryForm, elements.adSummaryPersonalization,
    elements.adSummaryCheckoutClicks, elements.adSummaryCheckouts, elements.adSummaryPaid].map(el => el.textContent),
    ['10', '8', '4', '3', '1', '1']);
});

test('an older overlapping response cannot append duplicate rows', async () => {
  let release;
  const { elements, load } = panel(() => new Promise(resolve => { release = resolve; }));
  const older = load();
  const olderReply = release;
  const newer = load();
  const ad = { campaign: 'christmas_2026', ad_code: 'vault-v1-miami', target_city: 'Miami',
    home_views: 3, checkout_starts: 1, paid_gifts: 0 };
  release({ ads: [ad] });
  await newer;
  olderReply({ ads: [{ ...ad, home_views: 99 }] });
  await older;
  assert.equal(elements.campaignRows.children.length, 1);
  assert.equal(elements.adSummaryViews.textContent, '3');
});

test('campaign RPC stays behind the existing verified administrator guard and is loaded independently', () => {
  const guard = handler.indexOf('if(error||!user||!user.email_confirmed_at');
  assert.ok(guard >= 0 && guard < handler.indexOf('payload.action === "campaign_report"'));
  assert.match(handler, /db\.rpc\("rich_campaign_report"\)/);
  assert.match(html, /dashboard\.hidden=false;void loadCampaignReport\(\)/);
});
