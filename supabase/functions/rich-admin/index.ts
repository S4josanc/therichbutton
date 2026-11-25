import {createClient} from "https://esm.sh/@supabase/supabase-js@2.49.4";
import { readMetaReport } from "./meta-report.ts";
const origin="https://therichbutton.com";
const headers={"Access-Control-Allow-Origin":origin,"Access-Control-Allow-Headers":"authorization,apikey,content-type","Access-Control-Allow-Methods":"POST,OPTIONS","Content-Type":"application/json","Cache-Control":"no-store"};
const reply=(obj:unknown,status=200)=>new Response(JSON.stringify(obj),{status,headers});
Deno.serve(async(req:Request)=>{
 if(req.method==="OPTIONS")return new Response(null,{headers});
 if(req.method!=="POST"||req.headers.get("origin")!==origin)return reply({error:"Forbidden"},403);
 const jwt=(req.headers.get("authorization")||"").replace(/^Bearer\s+/i,"");
 if(!jwt)return reply({error:"Authentication required"},401);
 const url=Deno.env.get("SUPABASE_URL")!,key=Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
 const db=createClient(url,key,{auth:{persistSession:false}});
 const {data:{user},error}=await db.auth.getUser(jwt);
 if(error||!user||!user.email_confirmed_at||user.email?.toLowerCase()!=="info@akademiaene.com")return reply({error:"Access denied"},403);
 let payload;try{payload=await req.json()}catch{return reply({error:"Invalid request"},400)}
 if(payload.action==="wall_list"){const {data,error}=await db.from("rich_wall_entries").select("id,display_name,edition,country_code,created_at,display_order").order("display_order",{ascending:true,nullsFirst:false}).order("created_at",{ascending:true}).order("id",{ascending:true});if(error)return reply({error:"Could not load wall"},500);return reply({entries:data})}
 if(payload.action==="wall_reorder"){
 const validIds=(ids:unknown)=>Array.isArray(ids)&&ids.length<=1000&&ids.every(id=>typeof id==="string"&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id))&&new Set(ids.map(id=>id.toLowerCase())).size===ids.length;
 if(!validIds(payload.order_ids)||!validIds(payload.expected_ids))return reply({error:"El orden contiene entradas no válidas."},400);
 const {data,error}=await db.rpc("rich_wall_reorder",{p_order_ids:payload.order_ids,p_expected_ids:payload.expected_ids,p_actor_email:user.email});
 if(error)return reply({error:"No se ha podido guardar el orden. Inténtalo de nuevo."},500);
 if(data?.error==="wall_changed")return reply({error:"La lista ha cambiado en otra sesión. Cancela los cambios y recarga la página antes de guardar.",code:"wall_changed"},409);
 if(data?.error==="access_denied")return reply({error:"Access denied"},403);
 if(data?.error)return reply({error:"El orden debe incluir todas las entradas, sin repetir ninguna."},400);
 return reply(data);
 }
 if(payload.action==="wall_add"){const display_name=String(payload.display_name||"").trim().slice(0,60),edition=String(payload.edition||"");if(!display_name||!["rich-gift","gold","platinum","diamond"].includes(edition))return reply({error:"Name and edition required"},400);const country_code=String(payload.country_code||"").trim().toUpperCase()||null;if(country_code&&!/^[A-Z]{2}$/.test(country_code))return reply({error:"Invalid country code"},400);const {error}=await db.from("rich_wall_entries").insert({display_name,edition,country_code});if(error)return reply({error:"Could not add entry"},500);return reply({ok:true})}
 if(payload.action==="wall_update"){const id=String(payload.id||"");const display_name=String(payload.display_name||"").trim();const edition=String(payload.edition||"");const country_code=String(payload.country_code||"").trim().toUpperCase()||null;if(!/^[0-9a-f-]{36}$/i.test(id)||!display_name||display_name.length>60||!["rich-gift","gold","platinum","diamond"].includes(edition)||(country_code&&!/^[A-Z]{2}$/.test(country_code)))return reply({error:"Invalid name, edition or country code"},400);const {data,error}=await db.from("rich_wall_entries").update({display_name,edition,country_code}).eq("id",id).select("id").maybeSingle();if(error)return reply({error:"Could not update entry"},500);if(!data)return reply({error:"Entry not found"},404);return reply({ok:true})}
 if(payload.action==="wall_remove"){const id=String(payload.id||"");if(!/^[0-9a-f-]{36}$/i.test(id))return reply({error:"Invalid entry"},400);const {error}=await db.from("rich_wall_entries").delete().eq("id",id);if(error)return reply({error:"Could not remove entry"},500);return reply({ok:true})}
 if (payload.action === "meta_report") {
   const meta = await readMetaReport(
     Deno.env.get("WINDSOR_API_KEY"), Deno.env.get("RICH_META_PURCHASE_VERIFIED_FROM"),
   );
   return reply({ meta });
 }
 if (payload.action === "organic_report") {
   const { data, error } = await db.rpc("rich_organic_report", { p_before_deadline: payload.before_deadline === true });
   if (error) return reply({ error: "Organic report unavailable" }, 503);
   return reply({ posts: data });
 }
 if (payload.action === "campaign_report") {
   const { data, error } = await db.rpc("rich_campaign_report");
   if (error) return reply({ error: "Campaign report unavailable" }, 503);
   return reply({ ads: data });
 }
 if(payload.action==="overview"){
 const [orders,throne,audit,complimentary,analytics]=await Promise.all([db.from("rich_gift_orders").select("id,status,amount_cents,currency,recipient_name,buyer_email,paid_at,created_at,referral_kind,referral_token,wall_opt_in,wall_alias").order("created_at",{ascending:false}).limit(100),db.from("rich_throne_state").select("*").eq("id",1).single(),db.from("rich_admin_audit").select("action,reason,created_at").order("created_at",{ascending:false}).limit(20),db.from("rich_complimentary_gifts").select("id,edition,recipient_name,sender_name,created_at,revoked_at,token").order("created_at",{ascending:false}).limit(100),db.from("rich_analytics_events").select("event_type,page,gift_kind,gift_id,created_at")
   .in("event_type", ["page_view", "gift_open", "gift_reveal", "gift_cta_click"])
   .gte("created_at",new Date(Date.now()-30*86400000).toISOString()).order("created_at",{ascending:false}).limit(10000)]);
 if(orders.error||throne.error||audit.error||complimentary.error||analytics.error)return reply({error:"Unable to load dashboard"},500);
 const paid=orders.data.filter(o=>o.status==="paid");const referralPaid={};for(const o of paid){if(o.referral_token){const k=o.referral_kind+":"+o.referral_token;referralPaid[k]=(referralPaid[k]||0)+1}}
 const events=analytics.data||[];const count=(type,page)=>events.filter(e=>e.event_type===type&&(!page||e.page===page)).length;const byGift={};for(const e of events){if(!e.gift_id)continue;const k=e.gift_kind+":"+e.gift_id;if(!byGift[k])byGift[k]={opens:0,reveals:0,cta_clicks:0};if(e.event_type==="gift_open")byGift[k].opens++;if(e.event_type==="gift_reveal")byGift[k].reveals++;if(e.event_type==="gift_cta_click")byGift[k].cta_clicks++}const daily={};for(const e of events){if(e.event_type!=="page_view")continue;const d=e.created_at.slice(0,10);daily[d]=(daily[d]||0)+1}return reply({analytics:{page_views:count("page_view"),home_views:count("page_view","home"),gift_opens:count("gift_open"),reveals:count("gift_reveal"),cta_clicks:count("gift_cta_click"),by_gift:byGift,referral_paid:referralPaid,daily:Object.entries(daily).sort((a,b)=>a[0].localeCompare(b[0]))},orders:orders.data,throne:throne.data,audit:audit.data,complimentary:complimentary.data,summary:{orders:orders.data.length,complimentary:complimentary.data.filter(g=>!g.revoked_at).length,paid:paid.length,revenue_cents:paid.reduce((s,o)=>s+o.amount_cents,0)},notice:"Orders limited to 100. Analytics covers up to 10,000 events from the last 30 days; these are events, not unique people. Stripe reconciliation is not connected."});
 }
 if(payload.action==="issue_complimentary"){
 const edition=String(payload.edition||"");
 const recipient=String(payload.recipient||"").trim().slice(0,70),sender=String(payload.sender||"The Rich Button").trim().slice(0,70),message=String(payload.message||"").trim().slice(0,180);
 if(!["rich-gift","gold","platinum","diamond"].includes(edition)||!recipient)return reply({error:"Select an edition and enter a recipient"},400);
 const {data:gift,error:giftError}=await db.from("rich_complimentary_gifts").insert({edition,recipient_name:recipient,sender_name:sender||"The Rich Button",dedication:message,issued_by:user.email}).select("id,token,edition,recipient_name").single();
 if(giftError||!gift)return reply({error:"Unable to issue gift"},500);
 const {error:auditError}=await db.from("rich_admin_audit").insert({actor_email:user.email,action:"complimentary_gift_issued",new_value:{gift_id:gift.id,edition,recipient},reason:"Complimentary promotional gift; no payment"});
 if(auditError)console.error("complimentary audit failed",auditError);
 return reply({ok:true,link:"https://therichbutton.com/open-gift.html?complimentary="+gift.token,edition,recipient,classification:"COMPLIMENTARY · €0 PAID"});
 }
 if(payload.action==="revoke_complimentary"){
 const id=String(payload.id||""),reason=String(payload.reason||"").trim().slice(0,300);
 if(!/^[a-f0-9-]{36}$/i.test(id)||!reason)return reply({error:"Gift ID and reason required"},400);
 const {data:gift,error:giftError}=await db.from("rich_complimentary_gifts").update({revoked_at:new Date().toISOString()}).eq("id",id).is("revoked_at",null).select("id,edition,recipient_name").maybeSingle();
 if(giftError||!gift)return reply({error:"Gift not found or already revoked"},404);
 await db.from("rich_admin_audit").insert({actor_email:user.email,action:"complimentary_gift_revoked",old_value:gift,reason});
 return reply({ok:true});
 }
 if(payload.action==="correct_throne"){
 const name=String(payload.name||"").trim().slice(0,70),country=String(payload.country||"").trim().slice(0,70),reason=String(payload.reason||"").trim().slice(0,300);
 const amount=Number(payload.amount);
 if(!name||!reason||!Number.isInteger(amount)||amount<100)return reply({error:"Enter a name, amount of at least €100 and a reason"},400);
 const {data:previous,error:readError}=await db.from("rich_throne_state").select("*").eq("id",1).single();
 if(readError)return reply({error:"Unable to read throne"},500);
 const next={owner_name:name,country,amount_cents:amount*100,verified_payment:false,updated_at:new Date().toISOString()};
 const {error:writeError}=await db.from("rich_throne_state").update(next).eq("id",1);
 if(writeError)return reply({error:"Unable to update throne"},500);
 const {error:auditError}=await db.from("rich_admin_audit").insert({actor_email:user.email,action:"manual_throne_correction",old_value:previous,new_value:next,reason});
 if(auditError){console.error("audit failure",auditError);return reply({error:"Throne changed but audit failed. Contact support immediately."},500)}
 return reply({ok:true,throne:next,notice:"Manual display override only. No Stripe payment or verified ownership was created."});
 }
 return reply({error:"Unknown action"},400);
});
