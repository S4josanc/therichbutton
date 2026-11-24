import Stripe from "https://esm.sh/stripe@17.7.0?target=denonext";
import { createEditionCheckoutHandler } from "./handler.mjs";

const key = Deno.env.get("STRIPE_SECRET_KEY") || "";
const stripe = /^(sk|rk)_live_/.test(key) ? new Stripe(key, { apiVersion: "2024-12-18.acacia" }) : null;
Deno.serve(createEditionCheckoutHandler({ stripe }));
