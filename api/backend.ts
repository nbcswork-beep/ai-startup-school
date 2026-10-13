import { getVercelApp, injectVercelRequest } from '../server/vercel-preview.js';
import { vercelRuntimeEnvironment } from '../server/vercel-runtime-env.js';

const runtimeEnvironment = vercelRuntimeEnvironment();

export default {
  async fetch(request: Request): Promise<Response> {
    const app = await getVercelApp(runtimeEnvironment);
    return injectVercelRequest(app, request);
  }
};
