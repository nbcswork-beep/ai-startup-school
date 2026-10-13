import { getVercelApp } from '../server/vercel-preview.js';
import { keepAliveUntil, vercelRuntimeEnvironment } from '../server/vercel-runtime-env.js';

const runtimeEnvironment = vercelRuntimeEnvironment();

// Streams AI answers as server-sent events. Lives apart from api/backend.ts because that function
// buffers the whole response; the rewrite in vercel.json sends only the stream route here.
export default {
  async fetch(request: Request): Promise<Response> {
    const app = await getVercelApp(runtimeEnvironment);
    const { response, done } = await app.aiStreamHandler(request);
    // The final token charge and the saved messages must complete even if the student closed the app.
    if (done) keepAliveUntil(done);
    return response;
  }
};
