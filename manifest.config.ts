import { defineManifest } from '@crxjs/vite-plugin'
import pkg from './package.json'

// Permissions minimales :
// - activeTab : accès temporaire à l'onglet courant uniquement lorsque l'utilisateur
//   ouvre le popup, sans permission large de type <all_urls>.
// - scripting : injection programmatique du content script de capture dans l'onglet actif.
// - storage : mémoriser la bascule « Analyse Gemini » (désactivée par défaut).
// Le stockage des snapshots utilise IndexedDB (aucune permission requise).
//
// host_permissions (Cycle 2) : accès ciblé au SEUL relais local, jamais une
// permission d'hôte large. Le service worker appelle ce relais pour l'analyse ;
// la clé Gemini reste exclusivement côté serveur.
export default defineManifest({
  manifest_version: 3,
  name: 'Comment-this-film',
  version: pkg.version,
  description:
    "Cycle 2 — Capture périodique de frames d'une vidéo HTML5 puis description visuelle via un relais Gemini local.",
  action: {
    default_popup: 'index.html',
    default_title: 'Comment-this-film',
  },
  background: {
    service_worker: 'src/background/index.ts',
    type: 'module',
  },
  permissions: ['activeTab', 'scripting', 'storage'],
  host_permissions: ['http://127.0.0.1:8787/*'],
})
