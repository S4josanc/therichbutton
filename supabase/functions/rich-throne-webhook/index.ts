import { createRuntime, createWebhookHandler } from '../_shared/throne-service.mjs';
const runtime = createRuntime();
Deno.serve(createWebhookHandler(runtime));
