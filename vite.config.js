import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  build: {
    rollupOptions: {
      input: { student: `${root}index.html`, teacher: `${root}teacher.html`, admin: `${root}admin.html` }
    }
  },
  server: {
    proxy: {
      '/api': {
        target: process.env.BFF_PROXY_TARGET || 'http://127.0.0.1:3000',
        changeOrigin: true
      }
    }
  }
});
