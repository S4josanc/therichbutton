import { matchEditionPrice } from "../rich-edition-access/handler.js";

export const editions = {
  Gold: { id: "plink_1Uc13YLqa85X23XWz0MWwicl", cents: 49900 },
  Platinum: { id: "plink_1Uc15QLqa85X23XWoPHuBvGf", cents: 199900 },
  Diamond: { id: "plink_1Uc16lLqa85X23XWZ2ewpcpd", cents: 999900 },
};

const returnPage = "https://therichbutton.com/edition-access.html";
const uuid4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const publicHeaders = { "Content-Type": "application/json", "Cache-Control": "private, no-store" };
const response = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: publicHeaders });
const absent = (payment, detail) => ({ payment, detail, access: "sin verificar", link: "sin verificar" });

function validReturn(link) {
  if (link?.after_completion?.type !== "redirect") return false;
  return validReturnUrl(link.after_completion.redirect.url);
}

function validReturnUrl(value) {
  try {
    const url = new URL(value);
    return url.origin + url.pathname === returnPage && url.searchParams.get("session_id") === "{CHECKOUT_SESSION_ID}";
  } catch { return false; }
}

export function reviewSession(session, edition, email, order) {
  const product = matchEditionPrice(session);
  if (!product || product.edition !== edition.toLowerCase()) {
    return absent("no coincide", "La sesión no coincide con el enlace, el importe o la moneda de esta edición.");
  }
  const stripeEmail = session.customer_details?.email || session.customer_email;
  if (email && stripeEmail && email.toLowerCase().trim() !== stripeEmail.toLowerCase().trim()) {
    return absent("no coincide", "El correo de la ficha difiere del que figura en Stripe.");
  }
  const charge = session.payment_intent?.latest_charge;
  if (typeof session.payment_intent === "string" || (session.payment_status === "paid" && (!charge || typeof charge !== "object"))) {
    throw new Error("No se pudo comprobar el cargo y sus reembolsos en Stripe.");
  }
  let payment = "pendiente";
  if (charge?.refunded || (charge?.amount_refunded > 0 && charge.amount_refunded >= charge.amount)) payment = "reembolsado";
  else if (charge?.amount_refunded > 0) payment = "reembolso parcial";
  else if (session.payment_status === "paid" && session.status === "complete") payment = "pagado";
  else if (session.status === "expired") payment = "caducado";
  let access = "pendiente";
  let link = "pendiente";
  let detail = "Aún no hay un acceso registrado para esta sesión.";
  if (order) {
    if (order.edition !== edition.toLowerCase() || order.amount_cents !== product.cents ||
        (order.stripe_payment_intent_id && order.stripe_payment_intent_id !== session.payment_intent?.id)) {
      access = link = "no coincide"; detail = "El pedido de entrega y la sesión de Stripe contienen datos distintos.";
    } else if (order.status === "refunded" || order.status === "revoked") {
      access = link = "revocado"; detail = "El registro de entrega marca el acceso como inactivo.";
    } else if (order.status === "paid" && uuid4.test(order.access_token || "")) {
      access = "generado";
      const validDestination = session.payment_link ? validReturn(session.payment_link) : validReturnUrl(session.success_url);
      link = validDestination ? "generado" : "no coincide";
      detail = link === "generado" ? "El acceso tiene un identificador válido y Stripe redirige a la página de entrega. La recepción la confirma el comprador." : "El acceso existe, pero el enlace de Stripe tiene otra página de entrega.";
      if (payment === "reembolsado" || payment === "reembolso parcial") detail += " El acceso sigue activo después del reembolso. Revisa el caso.";
    } else if (order.status === "paid") {
      access = link = "no coincide"; detail = "El pedido está pagado pero el identificador del acceso no es válido.";
    }
  }
  if (email && !stripeEmail) detail += " Stripe no devolvió un correo para contrastarlo.";
  return { payment, access, link, detail };
}

export function createReviewer({ getEnv, digest, fetcher = fetch }) {
  async function stripe(path) {
    const key = getEnv("STRIPE_SECRET_KEY");
    if (!key) throw new Error("La conexión de Stripe no está configurada.");
    const r = await fetcher("https://api.stripe.com/v1/" + path, {
      headers: { Authorization: "Bearer " + key }, signal: AbortSignal.timeout(9500),
    });
    if (r.status === 404) {
      const e = await r.json().catch(() => ({}));
      if (e.error?.code === "resource_missing") return null;
    }
    if (!r.ok) throw new Error("Stripe no ha podido responder a la consulta. Vuelve a intentarlo.");
    return r.json();
  }
  async function orders(session) {
    const url = new URL("/rest/v1/rich_edition_orders", getEnv("SUPABASE_URL"));
    url.searchParams.set("select", session ? "edition,status,amount_cents,access_token,stripe_payment_intent_id" : "id");
    if (session) url.searchParams.set("stripe_session_id", "eq." + session);
    url.searchParams.set("limit", session ? "2" : "0");
    const key = getEnv("SUPABASE_SERVICE_ROLE_KEY");
    const result = await fetcher(url, { headers: { apikey: key, Authorization: "Bearer " + key }, signal: AbortSignal.timeout(9500) });
    if (!result.ok) throw new Error("No se pudo leer el registro de entregas. Vuelve a intentarlo.");
    return result.json();
  }
  return async function handle(req) {
    if (req.method !== "POST") return response({ error: "Método no admitido." },405);
    const auth = req.headers.get("authorization") || "";
    if (!/^Bearer [A-Za-z0-9_-]{64}$/.test(auth)) return response({ error: "Acceso denegado." },401);
    const hash = new Uint8Array(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(auth.slice(7))));
    const hex = Array.from(hash,n=>n.toString(16).padStart(2,"0")).join("");
    if (hex !== digest) return response({ error: "Acceso denegado." },401);
    let payload;
    try { payload = await req.json(); } catch { return response({error:"Petición no válida."},400); }
    if (!payload || typeof payload !== "object") return response({error:"Petición no válida."},400);
    try {
      if (payload.action === "status") {
        const [links] = await Promise.all([
          Promise.all(Object.values(editions).map(e => stripe("payment_links/" + e.id))),
          orders(""),
        ]);
        const ok = links.every(x => x?.active === true && x?.livemode === true && validReturn(x));
        return response({ ok, message: ok ? "Stripe y el registro de entregas responden. Los tres enlaces de pago están activos y llevan a la página de entrega." : "El registro de entregas responde. Revisa en Stripe los enlaces de pago y sus redirecciones." });
      }
      const { session, edition, email } = payload;
      if (payload.action !== "verify" || !/^cs_live_[A-Za-z0-9]{15,200}$/.test(session) || !Object.hasOwn(editions, edition) || typeof email !== "string" || email.length > 254) return response({error:"Datos de sesión no válidos."},400);
      const s = await stripe("checkout/sessions/" + session + "?expand%5B%5D=payment_intent.latest_charge&expand%5B%5D=payment_link");
      if (!s) return response(absent("no encontrado","Stripe no encontró esta sesión en la cuenta de The Rich Button."));
      if (s.id !== session) throw new Error("Stripe no devolvió la sesión solicitada.");
      const rows = await orders(session);
      if (!Array.isArray(rows) || rows.length > 1) throw new Error("El registro de entregas no identifica un único pedido.");
      return response(reviewSession(s,edition,email,rows[0] || null));
    } catch (err) {
      return response({ error: err instanceof Error && /^(Stripe |La conexión|No se pudo|No se pudieron|El registro|No se pudo comprobar)/.test(err.message) ? err.message : "La consulta no se ha completado. Vuelve a intentarlo." },502);
    }
  };
}
