import{createClient}from"https://esm.sh/@supabase/supabase-js@2.49.4";
import { approvedAd, rejectedCampaignAd } from "../_shared/campaign-ad.mjs";
const origin="https://therichbutton.com";
const headers={"Access-Control-Allow-Origin":origin,"Access-Control-Allow-Methods":"POST,OPTIONS","Access-Control-Allow-Headers":"content-type","Cache-Control":"no-store"};
Deno.serve(async req=>{if(req.method==="OPTIONS")return new Response(null,{headers});if(req.method!=="POST"||req.headers.get("origin")!==origin)return new Response(null,{status:403,headers});let x;try{x=await req.json()}catch{return new Response(null,{status:400,headers})}
const event=String(x.event||""),page=String(x.page||"").slice(0,60),kind=String(x.kind||"");
if(!["page_view","gift_open","gift_reveal","gift_cta_click"].includes(event)||!["home","gift","open-gift"].includes(page))return new Response(null,{status:400,headers});
let giftId=null;if(["gift_open","gift_reveal","gift_cta_click"].includes(event)){if(!["complimentary","paid","preview"].includes(kind)||!/^[0-9a-f-]{36}$/i.test(String(x.id||"")))return new Response(null,{status:400,headers});giftId=String(x.id)}
const db=createClient(Deno.env.get("SUPABASE_URL")!,Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,{auth:{persistSession:false}});
const row={event_type:event,page,gift_kind:giftId?kind:null,gift_id:giftId};
const ad=event==="page_view" && page==="home" ? approvedAd(x.campaign_ad) : null;
let {error}=await db.from("rich_analytics_events").insert(ad ? {...row,campaign_ad:ad} : row);
if(ad && rejectedCampaignAd(error,"rich_analytics_events")){
  ({error}=await db.from("rich_analytics_events").insert(row));
}
if(error)return new Response(null,{status:503,headers});return new Response(null,{status:204,headers})});
