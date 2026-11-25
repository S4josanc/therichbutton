import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { createOrganicReport } from '../../admin-organic.mjs';

const html = await readFile(new URL('../../admin.html', import.meta.url), 'utf8');
const server = await readFile(new URL('../functions/rich-admin/index.ts', import.meta.url), 'utf8');
const basePost = {
  source: 'instagram', campaign: 'christmas_2026', content: 'day-01', post_title: 'Christmas',
  landing_views: 2, checkout_clicks: '1', verified_sales: 0,
};
const profile = { ...basePost, content: 'profile', landing_views: 7, verified_sales: '1' };
const friday = { ...basePost, source: 'youtube', campaign: 'black_friday_2026', content: 'black-friday' };

function element() {
  return {
    value: '', children: [], listeners: {},
    addEventListener(event, listener) { this.listeners[event] = listener; },
    appendChild(child) { this.children.push(child); },
    replaceChildren() { this.children = []; },
  };
}

function panel(call) {
  const elements = Object.fromEntries([...html.matchAll(/id="(organic\w+)"/g)].map(([, id]) => [id, element()]));
  const get = id => elements['organic' + id];
  const readTable = id => get(id).children.map(row => row.children.map(cell => cell.textContent));
  const document = { getElementById: id => elements[id], createElement: element };
  return { ...createOrganicReport(document, call), get, readTable };
}

test('campaign and channel filters update post details, profile rows and channel totals together', async () => {
  const dashboard = panel(async (action, options) => {
    assert.equal(action, 'organic_report');
    assert.deepEqual(options, { before_deadline: false });
    return { posts: [basePost, profile, friday] };
  });
  await dashboard.load();
  assert.deepEqual(dashboard.readTable('Channels'), [['Instagram', '9', '2', '1'], ['YouTube Shorts', '2', '1', '0']]);
  assert.deepEqual(dashboard.readTable('Totals'), [['Total seleccionado', '11', '3', '1']]);
  assert.deepEqual(dashboard.readTable('Posts')[0], ['Navidad 2026', 'Instagram', 'Perfil compartido · publicación desconocida', '7', '1', '1']);
  dashboard.get('Campaign').value = 'black_friday_2026';
  dashboard.get('Campaign').listeners.change();
  assert.deepEqual(dashboard.readTable('Posts'), [['Black Friday 2026', 'YouTube Shorts', 'black-friday · Christmas', '2', '1', '0']]);
  dashboard.get('Source').value = 'instagram';
  dashboard.get('Source').listeners.change();
  assert.equal(dashboard.get('Results').hidden, true);
  assert.deepEqual(dashboard.readTable('Totals'), []);
});

test('missing data is unavailable, recorded zero is displayed and delayed responses cannot leak through logout', async () => {
  let responder = async () => ({ posts: [basePost] });
  const dashboard = panel(() => responder());
  await dashboard.load();
  assert.equal(dashboard.get('Results').hidden, false);
  assert.equal(dashboard.readTable('Totals')[0].at(-1), '0');
  responder = async () => ({ posts: [{ ...basePost, verified_sales: null }] });
  await dashboard.load();
  assert.equal(dashboard.get('Results').hidden, true);
  assert.match(dashboard.get('Status').textContent, /No se han podido cargar/);
  let release;
  responder = () => new Promise(resolve => { release = resolve; });
  const previous = dashboard.load();
  dashboard.reset();
  release({ posts: [profile] });
  await previous;
  assert.equal(dashboard.get('Results').hidden, true);
  assert.deepEqual(dashboard.readTable('Channels'), []);
});

test('changing the deadline requests fresh aggregates and discards an older overlapping response', async () => {
  const responses = [];
  const dashboard = panel((action, options) => new Promise(resolve => responses.push({ resolve, options })));
  const all = dashboard.load();
  dashboard.get('Period').value = 'deadline';
  const cutoff = dashboard.get('Period').listeners.change();
  assert.deepEqual(responses.map(row => row.options.before_deadline), [false, true]);
  responses[1].resolve({ posts: [basePost] });
  await cutoff;
  responses[0].resolve({ posts: [profile] });
  await all;
  assert.equal(dashboard.readTable('Totals')[0].at(-1), '0');
});

test('report requires the existing confirmed admin and returns an error if the aggregate query fails', async () => {
  let handle;
  let user = null;
  let failRpc = false;
  let rpcCalls = 0;
  let beforeDeadline;
  const db = {
    auth: { async getUser() { return { data: { user } }; } },
    async rpc(name, options) {
      beforeDeadline = options.p_before_deadline;
      rpcCalls++;
      assert.equal(name, 'rich_organic_report');
      return failRpc ? { error: { message: 'internal' } } : { data: [basePost] };
    },
  };
  runInNewContext(stripTypeScriptTypes(server.replace(/^import[^\n]*;\r?$/gm, '')), {
    Deno: { serve: fn => { handle = fn; }, env: { get: () => 'fixture' } },
    createClient: () => db, Response,
  });
  const request = (token = '', before_deadline = false) => handle(new Request('https://fixture.invalid', {
    method: 'POST', headers: { origin: 'https://therichbutton.com', authorization: token },
    body: JSON.stringify({ action: 'organic_report', before_deadline }),
  }));
  assert.equal((await request()).status, 401);
  assert.equal((await request('Bearer fixture')).status, 403);
  const email = 'info@akademiaene.com';
  user = { email_confirmed_at: 'confirmed', email: 'someone@example.invalid' };
  assert.equal((await request('Bearer fixture')).status, 403);
  user = { email, email_confirmed_at: null };
  assert.equal((await request('Bearer fixture')).status, 403);
  assert.equal(rpcCalls, 0);
  user.email_confirmed_at = 'confirmed';
  assert.deepEqual(await (await request('Bearer fixture')).json(), { posts: [basePost] });
  assert.equal(beforeDeadline, false);
  await request('Bearer fixture', true);
  assert.equal(beforeDeadline, true);
  failRpc = true;
  const failure = await request('Bearer fixture');
  assert.equal(failure.status, 503);
  assert.ok(!(await failure.text()).includes('internal'));
  assert.equal(rpcCalls, 3);
});

test('the general dashboard limits only the event types its counters actually consume', () => {
  const query = server.match(/db\.from\("rich_analytics_events"\)([\s\S]*?)\.limit\(10000\)/)?.[1];
  const types = query?.match(/\.in\("event_type", (\[[^\]]+\])\)/)?.[1];
  assert.deepEqual(JSON.parse(types), ['page_view', 'gift_open', 'gift_reveal', 'gift_cta_click']);
});
