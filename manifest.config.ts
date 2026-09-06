import { defineManifest } from '@crxjs/vite-plugin'
import pkg from './package.json'

// Permissions minimales (Cycle 1) :
// - activeTab : accès temporaire à l'onglet courant uniquement lorsque l'utilisateur
//   ouvre le popup, sans permission large de type <all_urls>.
// - scripting : injection programmatique du content script de capture dans l'onglet actif.
// Le stockage utilise IndexedDB (aucune permission requise).
export default defineManifest({
  manifest_version: 3,
  name: 'Comment-this-film',
  version: pkg.version,
  description:
    "Cycle 1 — Capture périodique de frames d'une vidéo HTML5 dans l'onglet actif. Aucune intelligence artificielle.",
  action: {
    default_popup: 'index.html',
    default_title: 'Comment-this-film',
  },
  background: {
    service_worker: 'src/background/index.ts',
    type: 'module',
  },
  permissions: ['activeTab', 'scripting'],
})
