import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { crx } from '@crxjs/vite-plugin'
import manifest from './manifest.config'

// Extension Chrome Manifest V3 construite avec Vite + CRXJS.
// Le popup React est le point d'entrée HTML ; le content script est injecté
// programmatiquement (voir src/popup/api.ts) via l'import `?iife`.
export default defineConfig({
  plugins: [react(), crx({ manifest })],
  build: {
    target: 'esnext',
    rollupOptions: {
      // Le popup est déclaré via manifest.action.default_popup = index.html
    },
  },
  server: {
    port: 5173,
    strictPort: true,
  },
})
