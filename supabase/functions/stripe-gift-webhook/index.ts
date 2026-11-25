import Stripe from "https://esm.sh/stripe@17.7.0?target=denonext";
import {createClient} from "https://esm.sh/@supabase/supabase-js@2.49.4";
import { validatePaidSession, editionOrganicFields } from "../rich-edition-access/handler.js";
import { writeOrganicOrder } from "../_shared/organic-order.mjs";
import { validGiftPayment, giftOrganicFields } from "../_shared/gift-payment.mjs";
const key=Deno.env.get("STRIPE_SECRET_KEY"),secret=Deno.env.get("STRIPE_WEBHOOK_SECRET");
const stripe=key?new Stripe(key,{apiVersion:"2024-12-18.acacia"}):null;
const cryptoProvider=Stripe.createSubtleCryptoProvider();
Deno.serve(async(req:Request)=>{
 if(req.method!=="POST")return new Response("Method not allowed",{status:405});
 if(!key||!(key.startsWith("sk_live_")||key.startsWith("rk_live_"))||!stripe||!secret)return new Response("Webhook not configured",{status:503});
 const signature=req.headers.get("stripe-signature");
 if(!signature)return new Response("Missing signature",{status:400});
 let event:Stripe.Event;
 try{event=await stripe.webhooks.constructEventAsync(await req.text(),signature,secret,undefined,cryptoProvider)}
 catch{return new Response("Invalid signature",{status:400})}
 if(event.type!=="checkout.session.completed"&&event.type!=="checkout.session.async_payment_succeeded")return Response.json({received:true});
 const session=event.data.object as Stripe.Checkout.Session;
 if(event.livemode!==true||session.livemode!==true)return new Response("Webhook mode mismatch",{status:400});
 // Edition checkouts and the personalised Gift have separate order records.
 const edition = validatePaidSession(session);
 if (edition) {
   const databaseUrl = Deno.env.get("SUPABASE_URL");
   const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
   if (!databaseUrl || !serviceKey) return new Response("Database not configured", { status: 503 });
   const db = createClient(databaseUrl, serviceKey, { auth: { persistSession: false } });
   const paymentIntent = typeof session.payment_intent === "string" ? session.payment_intent : session.payment_intent?.id;
   const order = {
     edition: edition.edition, amount_cents: edition.cents, status: "paid",
     stripe_session_id: session.id, stripe_payment_intent_id: paymentIntent,
     paid_at: new Date(event.created * 1000).toISOString()
   };
   // The return page may have already issued a private link. Keep that row and
   // its access token, including any refund recorded since the original payment.
   const fields = editionOrganicFields(session, order.paid_at);
   const saved = await writeOrganicOrder("rich_edition_orders", fields, (optional:Record<string, string>) => db.from("rich_edition_orders").upsert({ ...order, ...optional }, {
     onConflict: "stripe_session_id", ignoreDuplicates: true
   }));
   if (saved.error) return new Response("Edition confirmation will be retried", { status: 503 });
   // A pending row can be upgraded, but replaying a signed event must never
   // reactivate a refunded edition or overwrite an already-issued token.
   const updated = await writeOrganicOrder("rich_edition_orders", fields, (optional:Record<string, string>) => db.from("rich_edition_orders")
     .update({ status: "paid", stripe_payment_intent_id: paymentIntent, paid_at: order.paid_at, ...optional })
     .eq("stripe_session_id", session.id).eq("edition", edition.edition)
     .eq("amount_cents", edition.cents).eq("status", "pending"));
   if (updated.error) return new Response("Edition confirmation will be retried", { status: 503 });
   return Response.json({ received: true });
 }

 if(session.payment_status!=="paid"||session.mode!=="payment"||session.currency!=="eur"||session.metadata?.product!=="rich-gift"||!session.metadata?.order_id)return Response.json({received:true,ignored:true});
 const url=Deno.env.get("SUPABASE_URL"),service=Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
 if(!url||!service)return new Response("Database not configured",{status:503});
 const db=createClient(url,service,{auth:{persistSession:false}});
 const {data:order,error}=await db.from("rich_gift_orders").select("id,status,stripe_checkout_session_id,amount_cents").eq("id",session.metadata.order_id).single();
 if(error||!order)return new Response("Order lookup failed",{status:500});
 if(order.stripe_checkout_session_id!==session.id)return new Response("Session mismatch",{status:409});
 if(!validGiftPayment(session,order))return Response.json({received:true,ignored:true});
 if(order.status!=="paid"&&order.status!=="pending")return Response.json({received:true,ignored:true});
 if(order.status==="pending"){
   const paidAt = new Date().toISOString();
   const payment = {
     status:"paid", paid_at:paidAt, gift_token:crypto.randomUUID(),
     buyer_email:session.customer_details?.email || session.customer_email || null,
     stripe_payment_intent_id:typeof session.payment_intent === "string" ? session.payment_intent : null,
   };
   const saved = await writeOrganicOrder("rich_gift_orders", giftOrganicFields(session, paidAt),
     (fields:Record<string, string>) => db.from("rich_gift_orders").update({...payment, ...fields})
       .eq("id", order.id).eq("status", "pending"));
   if(saved.error)return new Response("Fulfillment failed",{status:500});
 }
 try{
   const {data:fulfilled,error:fulfillmentError}=await db.from("rich_gift_orders").select("status,gift_token,email_sent_at,buyer_email").eq("id",order.id).single();
   if(fulfillmentError||!fulfilled||fulfilled.status!=="paid"||!fulfilled.gift_token){
     console.error("Gift fulfillment lookup failed for order "+order.id);
     return new Response("Fulfillment retry needed",{status:503});
   }
   if(!fulfilled.email_sent_at){
     const email=session.customer_details?.email||session.customer_email||fulfilled.buyer_email;
     if(!email){
       console.error("Gift receipt missing buyer email for order "+order.id);
       return new Response("Buyer email missing; manual resolution needed",{status:503});
     }
     const resendKey=Deno.env.get("RESEND_API_KEY");
     if(!resendKey)return new Response("Email service not configured",{status:503});
       const giftUrl="https://therichbutton.com/open-gift.html?gift_token="+encodeURIComponent(fulfilled.gift_token);
       const safeUrl=giftUrl.replaceAll("&","&amp;");
       const payload={from:"The Rich Button <gifts@mail.therichbutton.com>",to:[email],subject:"Your Rich Gift is ready",html:`<div style="background:#14110e;color:#f2e4c9;padding:36px;font-family:Georgia,serif;text-align:center"><h1 style="color:#e6c58b">THE RICH BUTTON</h1><p>Your Rich Gift is ready.</p><p>Keep this private link to open or share your gift:</p><p><a href="${safeUrl}" style="color:#e6c58b">OPEN YOUR RICH GIFT</a></p><p style="font-size:12px;color:#c1ae90">Keep this email to recover your gift later.</p></div>`,text:"Your Rich Gift is ready. Open or share: "+giftUrl};
       const mail=await fetch("https://api.resend.com/emails",{method:"POST",headers:{"Authorization":"Bearer "+resendKey,"Content-Type":"application/json","Idempotency-Key":"rich-gift-"+order.id},body:JSON.stringify(payload)});
       if(mail.ok){const {error:markError}=await db.from("rich_gift_orders").update({email_sent_at:new Date().toISOString()}).eq("id",order.id).is("email_sent_at",null);if(markError)throw markError;console.log("Gift receipt email accepted for order "+order.id)}
       else {console.error("Gift email provider rejected request: "+mail.status);return new Response("Email delivery retry needed",{status:503})}
     }
   }catch(err){console.error("Gift receipt email error",String(err));return new Response("Email delivery retry needed",{status:503})}
 console.log(JSON.stringify({event:event.id,order:order.id,status:"paid"}));
 return Response.json({received:true});
});

