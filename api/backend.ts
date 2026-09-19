import { getVercelPreviewApp, injectVercelRequest } from '../server/vercel-preview.js';

export default {
  async fetch(request: Request): Promise<Response> {
    const app = await getVercelPreviewApp();
    return injectVercelRequest(app, request);
  }
};
