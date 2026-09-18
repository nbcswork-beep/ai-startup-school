import { defineConfig } from 'vite';

export default defineConfig({
  root: '.',
  base: './',
  server: {
    host: '127.0.0.1',
    port: 4174
  },
  preview: {
    host: '127.0.0.1',
    port: 4174
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true
  }
});
