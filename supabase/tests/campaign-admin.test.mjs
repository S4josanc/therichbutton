import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const html = await readFile(new URL('../../admin.html', import.meta.url), 'utf8');
const reportSource = html.slice(html.indexOf('async function loadCampaignReport()'), html.indexOf('async function load(){'));
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
  const ids = ['campaignStatus', 'campaignTable', 'campaignRows'];
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
    ['christmas_2026', 'vault-v1-miami', 'Miami', '3', '1', '0']);
});

test('unavailable campaign figures do not interrupt other admin data or show stale counts', async () => {
  let offline = false;
  const { elements, load } = panel(async () => {
    if (offline) throw Error('RPC unavailable');
    return { ads: [] };
  });
  await load();
  assert.equal(elements.campaignStatus.textContent, 'No campaign ads configured.');
  elements.campaignRows.children.push(fakeElement());
  offline = true;
  await load();
  assert.equal(elements.campaignStatus.textContent, 'Campaign figures are temporarily unavailable.');
  assert.equal(elements.campaignTable.hidden, true);
  assert.equal(elements.campaignRows.children.length, 0);
});

test('campaign RPC stays behind the existing verified administrator guard and is loaded independently', () => {
  const guard = handler.indexOf('if(error||!user||!user.email_confirmed_at');
  assert.ok(guard >= 0 && guard < handler.indexOf('payload.action === "campaign_report"'));
  assert.match(handler, /db\.rpc\("rich_campaign_report"\)/);
  assert.match(html, /dashboard\.hidden=false;void loadCampaignReport\(\)/);
});
