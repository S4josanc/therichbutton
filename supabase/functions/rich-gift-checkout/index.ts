import Stripe from "https://esm.sh/stripe@17.7.0?target=denonext";
import {createClient} from "https://esm.sh/@supabase/supabase-js@2.49.4";
import { approvedAd, rejectedCampaignAd } from "../_shared/campaign-ad.mjs";
const headers={"Access-Control-Allow-Origin":"https://therichbutton.com","Access-Control-Allow-Headers":"content-type","Access-Control-Allow-Methods":"POST,OPTIONS","Content-Type":"application/json"};
const respond=(obj:unknown,status=200)=>new Response(JSON.stringify(obj),{status,headers});
Deno.serve(async(req:Request)=>{
 if(req.method==="OPTIONS")return new Response(null,{headers});
 if(req.method!=="POST"||req.headers.get("origin")!=="https://therichbutton.com")return respond({error:"Forbidden"},403);
 const key=Deno.env.get("STRIPE_SECRET_KEY");
 const url=Deno.env.get("SUPABASE_URL"),service=Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
 if(!key||!(key.startsWith("sk_live_")||key.startsWith("rk_live_"))||!url||!service)return respond({error:"Checkout is not configured"},503);
 let data;try{data=await req.json()}catch{return respond({error:"Invalid request"},400)}
 const recipient=String(data.recipient||"").trim().slice(0,42);
 const sender=String(data.sender||"").trim().slice(0,42);
 const message=String(data.message||"").trim().slice(0,180);
 const wallOptIn=data.wall_opt_in===true, wallAlias=wallOptIn?String(data.wall_alias||"").trim().slice(0,60):null;
 if(wallOptIn&&!wallAlias)return respond({error:"Please enter your name or alias for the wall"},400);
 if(!recipient)return respond({error:"Recipient name is required"},400);
 const ad=data.referral || data.referral_kind ? null : approvedAd(data.campaign_ad);
 const db=createClient(url,service,{auth:{persistSession:false}});
 let referralKind:null|"complimentary"|"paid"=null,referralToken:null|string=null;
 const candidate=String(data.referral||"");
 if(/^[0-9a-f-]{36}$/i.test(candidate)&&["complimentary","paid"].includes(data.referral_kind)){
  const kind=data.referral_kind==="paid"?"paid":"complimentary";
  const source=kind==="paid"?await db.from("rich_gift_orders").select("id").eq("gift_token",candidate).eq("status","paid").maybeSingle():await db.from("rich_complimentary_gifts").select("id").eq("token",candidate).is("revoked_at",null).maybeSingle();
  if(!source.error&&source.data){referralKind=kind;referralToken=candidate}
 }

 const {data:order,error}=await db.from("rich_gift_orders").insert({recipient_name:recipient,sender_name:sender,dedication:message,wall_opt_in:wallOptIn,wall_alias:wallAlias,referral_kind:referralKind,referral_token:referralToken}).select("id,access_token").single();
 if(error||!order)return respond({error:"Unable to prepare order"},500);
 const stripe=new Stripe(key,{apiVersion:"2024-12-18.acacia"});
 try{
  const session=await stripe.checkout.sessions.create({
   mode:"payment",customer_creation:"always",billing_address_collection:"auto",
   line_items:[{price_data:{currency:"eur",unit_amount:4900,tax_behavior:"inclusive",product_data:{name:"🎁 THE RICH GIFT™ | The Art of Giving Nothing ✨",description:"Personalized digital gift with a private reveal and virtual button"}},quantity:1}],
   client_reference_id:order.id,metadata:{order_id:order.id,product:"rich-gift"},
   success_url:"https://therichbutton.com/gift.html?order="+encodeURIComponent(order.access_token)+"&session_id={CHECKOUT_SESSION_ID}",
   cancel_url:"https://therichbutton.com/gift.html?tier=rich-gift&checkout=cancelled"+(ad?"&trb_ad="+encodeURIComponent(ad):"")
  },{idempotencyKey:"rich-gift-"+order.id});
  if(session.livemode!==true){await stripe.checkout.sessions.expire(session.id).catch(()=>{});return respond({error:"Checkout mode mismatch"},503)}
  const linkSession=(campaignAd:string|null)=>db.from("rich_gift_orders")
    .update({stripe_checkout_session_id:session.id,...(campaignAd?{campaign_ad:campaignAd}:{})})
    .eq("id",order.id).eq("status","pending").select("id").single();
  let updated=await linkSession(ad);
  if(ad && rejectedCampaignAd(updated.error,"rich_gift_orders"))updated=await linkSession(null);
  if(updated.error){await stripe.checkout.sessions.expire(session.id).catch(()=>{});return respond({error:"Unable to prepare checkout"},500)}
  return respond({checkout_url:session.url});
 }catch(e){console.error("checkout creation failed",String(e));return respond({error:"Checkout temporarily unavailable"},503)}
});
