import Stripe from "https://esm.sh/stripe@17.7.0?target=denonext";
import {createClient} from "https://esm.sh/@supabase/supabase-js@2.49.4";
import {validGiftPayment} from "../_shared/gift-payment.mjs";
const cors={"Access-Control-Allow-Origin":"https://therichbutton.com","Access-Control-Allow-Methods":"GET,OPTIONS","Access-Control-Allow-Headers":"content-type","Cache-Control":"no-store","Content-Type":"application/json"};
const response=(data:unknown,status=200)=>new Response(JSON.stringify(data),{status,headers:cors});
Deno.serve(async(req:Request)=>{
 if(req.method==="OPTIONS")return new Response(null,{headers:cors});
 if(req.method!=="GET")return response({error:"Method not allowed"},405);
 const params=new URL(req.url).searchParams,token=params.get("token");
 if(!token||!/^[0-9a-f-]{36}$/i.test(token))return response({error:"Invalid token"},400);
 const db=createClient(Deno.env.get("SUPABASE_URL")!,Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,{auth:{persistSession:false}});
 const fields="id,amount_cents,status,recipient_name,sender_name,dedication,gift_token,stripe_checkout_session_id";
 let {data:order,error}=await db.from("rich_gift_orders").select(fields).eq("access_token",token).single();
 if(error||!order)return response({error:"Order not found"},404);
 const sessionId=params.get("session_id");
 if(params.get("purchase")!=="1"&&order.status==="pending"&&sessionId&&sessionId===order.stripe_checkout_session_id){
  const key=Deno.env.get("STRIPE_SECRET_KEY");
  if(key&&(key.startsWith("sk_live_")||key.startsWith("rk_live_"))){
   try{
    const stripe=new Stripe(key,{apiVersion:"2024-12-18.acacia"});
    const session=await stripe.checkout.sessions.retrieve(sessionId);
    if(session.client_reference_id===order.id && validGiftPayment(session, order)){
     const {error:updateError}=await db.from("rich_gift_orders").update({status:"paid",buyer_email:session.customer_details?.email||session.customer_email||null,stripe_payment_intent_id:typeof session.payment_intent==="string"?session.payment_intent:null,gift_token:crypto.randomUUID(),paid_at:new Date().toISOString()}).eq("id",order.id).eq("status","pending");
     if(updateError)console.error("status recovery update failed",updateError);
     const refreshed=await db.from("rich_gift_orders").select(fields).eq("id",order.id).single();
     if(!refreshed.error&&refreshed.data)order=refreshed.data;
    }
   }catch(e){console.error("Stripe status recovery failed",String(e))}
  }
 }
 if(params.get("purchase")==="1") {
  // Only a live checkout return may request a conversion. A saved recovery link remains usable.
  if(order.status!=="paid" || !order.gift_token || !sessionId?.startsWith("cs_live_") ||
     sessionId!==order.stripe_checkout_session_id) return response({purchase:null});
  try {
   const {data:receipt}=await db.from("rich_gift_orders")
    .select("status,marketing_event_id,paid_at,stripe_payment_intent_id")
    .eq("id",order.id).single();
   const key=Deno.env.get("STRIPE_SECRET_KEY");
   if(!receipt?.paid_at || receipt.status!=="paid" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(receipt.marketing_event_id || "") ||
      !key || !(key.startsWith("sk_live_") || key.startsWith("rk_live_"))) return response({purchase:null});

   const stripe=new Stripe(key,{apiVersion:"2024-12-18.acacia"});
   const session=await stripe.checkout.sessions.retrieve(sessionId,{expand:["payment_intent.latest_charge"]});
   const intent=session.payment_intent;
   if(!validGiftPayment(session,order) || session.client_reference_id!==order.id ||
      !intent || typeof intent==="string" || intent.id!==receipt.stripe_payment_intent_id ||
      intent.status!=="succeeded" || intent.amount_received!==session.amount_total) return response({purchase:null});
   const charge=intent.latest_charge;
   if(!charge || typeof charge==="string" || !charge.livemode || !charge.paid ||
      charge.refunded || charge.amount_refunded!==0 || charge.disputed ||
      charge.currency!==session.currency || charge.amount!==session.amount_total ||
      session.amount_total==null || session.amount_total<=0 || !session.currency) return response({purchase:null});
   return response({purchase:{eventId:receipt.marketing_event_id,value:session.amount_total/100,
     currency:session.currency.toUpperCase()}});
  } catch {
   return response({purchase:null});
  }
 }
 return response({status:order.status,...(order.status==="paid"&&order.gift_token?{recipient:order.recipient_name,sender:order.sender_name,message:order.dedication,gift_url:"https://therichbutton.com/open-gift.html?gift_token="+order.gift_token}:{})});
});
