import { createRuntime, createPublicHandler } from '../_shared/throne-service.mjs';
const runtime = createRuntime();
Deno.serve(createPublicHandler(runtime));
