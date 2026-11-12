import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// The daemon serves dist/ itself (same origin as the API). For `vite dev`, run the daemon with
// AGGREGATOR_ALLOWED_ORIGINS=http://127.0.0.1:5173 and proxy the API.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: { host: '127.0.0.1', port: 5173, proxy: { '/api': 'http://127.0.0.1:4173', '/ws': { target: 'ws://127.0.0.1:4173', ws: true } } },
  build: { outDir: 'dist', chunkSizeWarningLimit: 1500 },
});
