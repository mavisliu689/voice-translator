import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
// Minimal typing for the dev-only env read below (avoids a @types/node dependency).
declare const process: { env: Record<string, string | undefined> };

export default defineConfig({
  plugins: [react()],
  server: {
    allowedHosts: true,
    proxy: (() => {
      // BACKEND_PORT overrides the dev backend port (e.g. when :3001 is taken).
      const port = process.env.BACKEND_PORT || '3001';
      return {
        '/api': `http://localhost:${port}`,
        '/health': `http://localhost:${port}`,
        // Live Translate WebSocket bridge (ws:true enables WS proxying so the dev
        // server works even when VITE_BACKEND_URL is empty / same-origin).
        '/ws': { target: `ws://localhost:${port}`, ws: true },
      };
    })(),
  },
})
