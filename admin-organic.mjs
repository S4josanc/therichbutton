const networks = new Map([
  ['pinterest', 'Pinterest'], ['facebook', 'Facebook'], ['instagram', 'Instagram'],
  ['tiktok', 'TikTok'], ['youtube', 'YouTube Shorts'],
]);
const campaigns = new Map([
  ['black_friday_2026', 'Black Friday 2026'], ['christmas_2026', 'Navidad 2026'],
  ['evergreen', 'Fuera de campaña'],
]);
const metricKeys = ['landing_views', 'checkout_clicks', 'verified_sales'];
const numberFormat = new Intl.NumberFormat('es-ES');

function count(value) {
  // PostgREST can return bigint fields as decimal strings.
  if (!/^\d+$/.test(String(value)) || !Number.isSafeInteger(Number(value))) {
    throw Error('Invalid count');
  }
  return Number(value);
}

function compare(a, b) {
  return b.verified_sales - a.verified_sales || b.landing_views - a.landing_views ||
    b.checkout_clicks - a.checkout_clicks;
}

export function createOrganicReport(document, call) {
  const element = id => document.getElementById('organic' + id);
  const results = element('Results');
  const status = element('Status');
  const channels = element('Channels');
  const totals = element('Totals');
  const posts = element('Posts');
  const refresh = element('Refresh');
  const sourceFilter = element('Source');
  const campaignFilter = element('Campaign');
  const periodFilter = element('Period');
  let requestId = 0;
  let report = null;

  function appendRow(table, labels, metrics) {
    const row = document.createElement('tr');
    for (const value of [...labels, ...metricKeys.map(key => numberFormat.format(metrics[key]))]) {
      const cell = document.createElement('td');
      cell.textContent = value;
      row.appendChild(cell);
    }
    table.appendChild(row);
  }

  function clear() {
    report = null;
    results.hidden = true;
    for (const body of [channels, totals, posts]) body.replaceChildren();
  }

  function render() {
    if (!report) return;
    const filtered = report.filter(post =>
      (!sourceFilter.value || post.source === sourceFilter.value) &&
      (!campaignFilter.value || post.campaign === campaignFilter.value));
    for (const body of [channels, totals, posts]) body.replaceChildren();
    results.hidden = !filtered.length;
    status.textContent = filtered.length ? '' : 'No hay enlaces que coincidan con estos filtros.';
    if (!filtered.length) return;

    const emptyTotals = () => ({ landing_views: 0, checkout_clicks: 0, verified_sales: 0 });
    const summary = emptyTotals();
    const byNetwork = new Map();
    for (const post of filtered.sort(compare)) {
      const network = networks.get(post.source);
      const group = byNetwork.get(network) || emptyTotals();
      for (const key of metricKeys) {
        group[key] += post[key];
        summary[key] += post[key];
      }
      byNetwork.set(network, group);
      const label = post.content === 'profile' ? 'Perfil compartido · publicación desconocida' :
        post.content + ' · ' + post.post_title;
      appendRow(posts, [campaigns.get(post.campaign), network, label], post);
    }
    for (const [network, group] of [...byNetwork].sort((a, b) => compare(a[1], b[1]))) {
      appendRow(channels, [network], group);
    }
    appendRow(totals, ['Total seleccionado'], summary);
  }

  async function load() {
    const id = ++requestId;
    clear();
    refresh.disabled = true;
    status.textContent = 'Consultando las publicaciones…';
    try {
      const { posts: data } = await call('organic_report', {
        before_deadline: periodFilter.value === 'deadline',
        include_evergreen_profiles: true,
      });
      if (id !== requestId) return;
      if (!Array.isArray(data)) throw Error('Invalid report');
      report = data.map(post => {
        if (!networks.has(post.source) || !campaigns.has(post.campaign) ||
            typeof post.content !== 'string' || typeof post.post_title !== 'string') {
          throw Error('Invalid post');
        }
        return { ...post, ...Object.fromEntries(metricKeys.map(key => [key, count(post[key])])) };
      });
      render();
    } catch {
      if (id !== requestId) return;
      clear();
      status.textContent = 'No se han podido cargar las estadísticas. Pulsa Actualizar para volver a intentarlo.';
    } finally {
      if (id === requestId) refresh.disabled = false;
    }
  }

  refresh.addEventListener('click', load);
  periodFilter.addEventListener('change', load);
  sourceFilter.addEventListener('change', render);
  campaignFilter.addEventListener('change', render);
  return {
    load,
    reset() {
      requestId++;
      clear();
      periodFilter.value = 'all';
      sourceFilter.value = '';
      campaignFilter.value = '';
      refresh.disabled = false;
      status.textContent = '';
    },
  };
}
