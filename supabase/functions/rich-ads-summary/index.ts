import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";
const origin = "https://therichbutton.com";
const headers = { "Access-Control-Allow-Origin": origin, "Access-Control-Allow-Headers": "authorization,apikey,content-type", "Access-Control-Allow-Methods": "POST,OPTIONS", "Content-Type": "application/json", "Cache-Control": "no-store" };
const reply = (data: unknown, status = 200) => new Response(JSON.stringify(data), {status, headers});
Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, {headers});
  if (req.method !== "POST" || req.headers.get("origin") !== origin) return reply({error:"Forbidden"},403);
  const jwt = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i,"");
  if (!jwt) return reply({error:"Authentication required"},401);
  const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {auth:{persistSession:false}});
  const {data:{user}, error} = await supabase.auth.getUser(jwt);
  if (error || !user || !user.email_confirmed_at || user.email?.toLowerCase() !== "info@akademiaene.com") return reply({error:"Access denied"},403);
  const key = Deno.env.get("WINDSOR_API_KEY");
  if (!key) return reply({error:"Advertising connection is not configured"},503);
  const url = new URL("https://connectors.windsor.ai/facebook");
  url.searchParams.set("api_key", key);
  url.searchParams.set("date_preset","last_30dT");
  url.searchParams.set("fields","account_id,account_currency,spend,clicks,impressions,actions_post_engagement");
  url.searchParams.set("select_accounts","4729769513972199");
  try {
    const response = await fetch(url, {signal: AbortSignal.timeout(15000)});
    if (!response.ok) return reply({error:"Advertising data unavailable"},502);
    const body = await response.json();
    if (!body || !Array.isArray(body.data) || body.error || body.next || body.next_page || body.pagination?.next) return reply({error:"Advertising data unavailable or incomplete"},502);
    const rows = body.data;
    if (!rows.length) return reply({status:"no_data",period:"last_30d_including_today"});
    const currencies = new Set(rows.map((r: Record<string, unknown>) => String(r.account_currency || "")));
    if (currencies.size !== 1 || currencies.has("")) return reply({error:"Advertising currency unavailable"},502);
    const totals: Record<string, number> = {spend:0,clicks:0,impressions:0,actions_post_engagement:0};
    for (const r of rows) {
      if (String(r.account_id) !== "4729769513972199") return reply({error:"Unexpected advertising account"},502);
      for (const field of Object.keys(totals)) {
        if (r[field] === null || r[field] === undefined || r[field] === "" || !Number.isFinite(Number(r[field])) || Number(r[field]) < 0) return reply({error:"Incomplete advertising data"},502);
        totals[field] += Number(r[field]);
      }
    }
    return reply({status:"ok",period:"last_30d_including_today",currency:[...currencies][0],...totals});
  } catch { return reply({error:"Advertising data unavailable"},502); }
});