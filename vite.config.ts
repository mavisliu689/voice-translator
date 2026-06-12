import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    allowedHosts: true,
    proxy: {
      '/api': 'http://localhost:3001',
      '/health': 'http://localhost:3001',
      // Live Translate WebSocket bridge (ws:true enables WS proxying so the dev
      // server works even when VITE_BACKEND_URL is empty / same-origin).
      '/ws': { target: 'ws://localhost:3001', ws: true },
    },
  },
})
