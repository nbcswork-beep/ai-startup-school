import { runWorker } from './ai-worker.js';

// Cloud Run Job entry point: `node server-dist/server/worker/main.js`, with AI_JOB_ID set per execution.
const { exitCode } = await runWorker();
process.exitCode = exitCode;
