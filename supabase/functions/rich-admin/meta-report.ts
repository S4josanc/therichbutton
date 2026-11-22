// The Rich Button Ads. The reporting dates follow this ad account's time zone.
const accountId = "4729769513972199";
const accountZone = "Europe/Bratislava";
const purchaseField = "actions_offsite_conversion_fb_pixel_purchase";
const rowLimit = 10_001;

type Period = { from: string; to: string };
type Row = Record<string, unknown>;
type Report = {
  state: "reported" | "empty" | "pending" | "unavailable";
  reason: string;
  period: Period;
  queried_at: string;
  currency: string | null;
  spend: number | null;
  impressions: number | null;
  clicks: number | null;
  purchases: number | null;
};

class AccessError extends Error {}
class PendingReport extends Error {}

function reportingPeriod(now: Date): Period {
  const to = new Intl.DateTimeFormat("en-CA", {
    timeZone: accountZone, year: "numeric", month: "2-digit", day: "2-digit",
  }).format(now);
  const start = new Date(to + "T00:00:00Z");
  start.setUTCDate(start.getUTCDate() - 29);
  return { from: start.toISOString().slice(0, 10), to };
}

function isCalendarDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(value + "T00:00:00Z");
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

async function getRows(apiKey: string, period: Period, fields: string[], request: typeof fetch) {
  const url = new URL("https://connectors.windsor.ai/facebook");
  url.search = new URLSearchParams({
    api_key: apiKey, select_accounts: accountId, date_from: period.from, date_to: period.to,
    fields: ["date", "account_id", "ad_id", ...fields].join(","),
    _renderer: "json", _max_rows: String(rowLimit),
    options: JSON.stringify({ facebook: { use_unified_attribution_setting: "true" } }),
  }).toString();
  const response = await request(url, {
    method: "GET", redirect: "error", signal: AbortSignal.timeout(12_000),
    headers: { Accept: "application/json" },
  });
  if ([401, 403].includes(response.status)) throw new AccessError();
  if (response.status === 202) throw new PendingReport();
  if (response.status !== 200) throw new Error("upstream");
  const body = await response.json();
  if (["pending", "processing", "running"].includes(body?.status)) throw new PendingReport();
  if (!body || !Array.isArray(body.data) || body.error || body.errors?.length ||
      body.next || body.paging?.next || body.has_more || body.truncated ||
      (body.status != null && body.status !== "done" && body.status !== "success") ||
      (body.total_rows != null && Number(body.total_rows) !== body.data.length) ||
      body.data.length >= rowLimit) throw new Error("incomplete");

  const rows = new Map<string, Row>();
  for (const row of body.data) {
    const day = row?.date;
    const ad = row?.ad_id;
    if (String(row?.account_id).replace(/^act_/, "") !== accountId ||
        !isCalendarDate(day) || day < period.from || day > period.to ||
        (typeof ad !== "string" && !Number.isSafeInteger(ad)) || !/^\d+$/.test(String(ad))) {
      throw new Error("invalid grain");
    }
    const id = day + "/" + ad;
    if (rows.has(id)) throw new Error("overlap");
    rows.set(id, row);
  }
  return rows;
}

// A missing field in even one contributing row makes that total unavailable.
function total(rows: Map<string, Row>, field: string, integer = true): number | null {
  let sum = 0;
  for (const row of rows.values()) {
    const raw = row[field];
    if (typeof raw !== "number" && (typeof raw !== "string" || !/^\d+(?:\.\d+)?$/.test(raw))) return null;
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0 || (integer && !Number.isSafeInteger(n))) return null;
    sum += n;
  }
  return Number.isFinite(sum) && (!integer || Number.isSafeInteger(sum)) ? sum : null;
}

export async function readMetaReport(
  apiKey: string | undefined, purchaseVerifiedFrom: string | undefined,
  now = new Date(), request: typeof fetch = fetch,
): Promise<Report> {
  const period = reportingPeriod(now);
  const report: Report = {
    period, queried_at: now.toISOString(), state: "pending",
    reason: "Falta configurar el acceso de Windsor en el servidor.",
    currency: null, spend: null, impressions: null, clicks: null, purchases: null,
  };
  if (!apiKey?.trim()) return report;

  let delivery: Map<string, Row>;
  try {
    delivery = await getRows(apiKey, period, ["currency", "spend", "impressions", "link_clicks"], request);
  } catch (error) {
    if (error instanceof AccessError) {
      report.reason = "Windsor ha denegado el acceso. Revisa la clave y la selección de The Rich Button Ads.";
    } else if (error instanceof PendingReport) {
      report.reason = "Windsor está preparando el informe. Pulsa Actualizar dentro de unos minutos.";
    } else {
      report.state = "unavailable";
      report.reason = "No se ha podido obtener el informe completo. Vuelve a intentarlo más tarde.";
    }
    return report;
  }
  if (delivery.size === 0) {
    report.state = "empty";
    report.reason = "Windsor no ha devuelto filas de Meta para este periodo.";
    return report;
  }

  const currencies = new Set(Array.from(delivery.values(), row => row.currency));
  const currency = currencies.values().next().value;
  if (currencies.size === 1 && typeof currency === "string" && /^[A-Z]{3}$/.test(currency)) {
    report.currency = currency;
    report.spend = total(delivery, "spend", false);
  }
  report.impressions = total(delivery, "impressions");
  report.clicks = total(delivery, "link_clicks");

  // A separate query keeps delivery visible if the purchase metric is unsupported.
  try {
    const purchases = await getRows(apiKey, period, [purchaseField], request);
    if (purchases.size === delivery.size && [...delivery.keys()].every(id => purchases.has(id))) {
      const n = total(purchases, purchaseField);
      const verifiedThroughout = isCalendarDate(purchaseVerifiedFrom) && purchaseVerifiedFrom <= period.from;
      if (n !== 0 || verifiedThroughout) report.purchases = n;
    }
  } catch {
    // No purchase count can be confirmed; preserve the delivery data above.
  }
  const known = [report.spend, report.impressions, report.clicks, report.purchases].some(n => n !== null);
  report.state = known ? "reported" : "unavailable";
  if (!known) report.reason = "El informe contiene filas sin cifras completas para este periodo.";
  else if (report.purchases === null) report.reason = "Las compras web atribuidas están sin confirmar para este periodo.";
  else report.reason = "";
  return report;
}
