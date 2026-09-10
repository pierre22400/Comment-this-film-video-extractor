import { defineManifest } from '@crxjs/vite-plugin'
import pkg from './package.json'

// Permissions minimales :
// - activeTab : accÃ¨s temporaire Ã  l'onglet courant uniquement lorsque l'utilisateur
//   ouvre le popup, sans permission large de type <all_urls>.
// - scripting : injection programmatique du content script de capture dans l'onglet actif.
// - downloads : uniquement pour l'export EXPLICITE d'une galerie planifiÃ©e
//   (Cycle 3) sous TÃ©lÃ©chargements/Comment-this-film/<id>/. Aucune Ã©criture
//   silencieuse hors du dossier TÃ©lÃ©chargements n'est possible.
// Le stockage des snapshots, des sondes visuelles et des galeries planifiÃ©es
// utilise IndexedDB (aucune permission requise). Il n'y a plus de bascule
// d'analyse automatique persistÃ©e (diagnostic manuel = actions explicites),
// donc pas de permission `storage`.
//
// host_permissions (Cycle 2) : accÃ¨s ciblÃ© au SEUL relais local (/api/describe
// ET /api/visual-probe), jamais une permission d'hÃ´te large. Le service
// worker appelle ce relais pour l'analyse ; la clÃ© Gemini reste exclusivement
// cÃ´tÃ© serveur.
export default defineManifest({
  manifest_version: 3,
  name: 'SceneVibe Visual Scanner — POC',
  version: pkg.version,
  description:
    'POC technique - Scanner visuel planifi\u00e9 pour YouTube et Prime Video : captures horodat\u00e9es, galeries locales et analyse Gemini facultative.',  action: {
    default_popup: 'index.html',
    default_title: 'SceneVibe Visual Scanner - POC',
  },
  background: {
    service_worker: 'src/background/index.ts',
    type: 'module',
  },
  // `tabs` est requis uniquement pour l'essai explicite Â« onglet visible Â» :
  // Chrome fournit alors une image de ce qui est affichÃ©, sans accÃ¨s au flux
  // Prime ni contournement DRM. L'essai reste limitÃ© Ã  l'onglet actif.
  permissions: ['activeTab', 'scripting', 'downloads', 'tabs'],
  host_permissions: ['http://127.0.0.1:8787/*'],
})
