import { defineManifest } from '@crxjs/vite-plugin'
import pkg from './package.json'

// Permissions minimales :
// - activeTab : accès temporaire à l'onglet courant uniquement lorsque l'utilisateur
//   ouvre le popup, sans permission large de type <all_urls>.
// - scripting : injection programmatique du content script de capture dans l'onglet actif.
// - downloads : uniquement pour l'export EXPLICITE d'une galerie planifiée
//   (Cycle 3) sous Téléchargements/Comment-this-film/<id>/. Aucune écriture
//   silencieuse hors du dossier Téléchargements n'est possible.
// Le stockage des snapshots, des sondes visuelles et des galeries planifiées
// utilise IndexedDB (aucune permission requise). Il n'y a plus de bascule
// d'analyse automatique persistée (diagnostic manuel = actions explicites),
// donc pas de permission `storage`.
//
// host_permissions (Cycle 2) : accès ciblé au SEUL relais local (/api/describe
// ET /api/visual-probe), jamais une permission d'hôte large. Le service
// worker appelle ce relais pour l'analyse ; la clé Gemini reste exclusivement
// côté serveur.
export default defineManifest({
  manifest_version: 3,
  name: 'SceneVibe video extractor',
  version: pkg.version,
  description:
    "Cycle 3 — Capture de frames d'une vidéo HTML5 : capture périodique, sondes visuelles ciblées et scanner visuel planifié (galeries locales) via un relais Gemini local.",
  action: {
    default_popup: 'index.html',
    default_title: 'SceneVibe video extractor',
  },
  background: {
    service_worker: 'src/background/index.ts',
    type: 'module',
  },
  // `tabs` est requis uniquement pour l'essai explicite « onglet visible » :
  // Chrome fournit alors une image de ce qui est affiché, sans accès au flux
  // Prime ni contournement DRM. L'essai reste limité à l'onglet actif.
  permissions: ['activeTab', 'scripting', 'downloads', 'tabs'],
  host_permissions: ['http://127.0.0.1:8787/*'],
})
