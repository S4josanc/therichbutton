import { createRuntime, createStatusHandler } from '../_shared/throne-service.mjs';
const runtime = createRuntime();
Deno.serve(createStatusHandler(runtime));
