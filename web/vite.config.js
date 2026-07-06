import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// During `npm run dev` the React app runs on Vite's own port, so we proxy the
// API, uploads, and WebSocket over to the Go server on :3000. In production the
// Go server serves the built files directly and no proxy is involved.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:3000',
      '/uploads': 'http://localhost:3000',
      '/ws': { target: 'http://localhost:3000', ws: true },
    },
  },
  build: {
    outDir: 'dist',
  },
})
