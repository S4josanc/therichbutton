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
 if(order.status==="pending"&&sessionId&&sessionId===order.stripe_checkout_session_id){
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
 return response({status:order.status,...(order.status==="paid"&&order.gift_token?{recipient:order.recipient_name,sender:order.sender_name,message:order.dedication,gift_url:"https://therichbutton.com/open-gift.html?gift_token="+order.gift_token}:{})});
});
