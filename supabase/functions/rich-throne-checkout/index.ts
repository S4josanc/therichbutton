import { createRuntime, createCheckoutHandler } from '../_shared/throne-service.mjs';
const runtime = createRuntime();
Deno.serve(createCheckoutHandler(runtime));
