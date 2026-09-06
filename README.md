# Comment-this-film — Cycle 1

Extension Google Chrome (Manifest V3) dont l'unique fonction est de **capturer
périodiquement des images d'une vidéo HTML5** en cours de lecture dans l'onglet
actif, puis de les stocker localement et de les présenter dans une galerie.

> **Ce prototype ne contient aucune intelligence artificielle.**
> Pas de Gemini, LLM, OCR, sous-titres, recherche Internet, reconnaissance
> d'image, identification de film, base de données distante ni backend.

Objectif du Cycle 1 : valider la chaîne
**HTMLVideoElement → `currentTime` → capture Canvas → snapshot WebP → stockage → galerie.**

---

## Architecture

Le code est séparé par responsabilité (aucun fichier monolithique) :

```
manifest.config.ts          Manifest V3 (permissions minimales)
vite.config.ts              Build Vite + CRXJS
index.html                  Point d'entrée du popup React

src/
  lib/
    types.ts                Type Snapshot + types partagés
    errors.ts               Codes d'erreur explicites + messages FR
    timecode.ts             Formatage HH:MM:SS.mmm et intervalles
    messages.ts             Types des messages inter-contextes
    snapshotStore.ts        Stockage IndexedDB (add / getAll / clear)

  content/                  Injecté dans l'onglet actif (isolated world)
    index.ts                Orchestration + messagerie
    videoDetector.ts        Détection de la meilleure vidéo
    frameCapture.ts         video → canvas → drawImage → WebP
    captureScheduler.ts     Timer d'intervalle

  background/
    index.ts                Service worker : reçoit les images, écrit IndexedDB

  popup/                    Interface React
    main.tsx / Popup.tsx
    api.ts                  Injection + messagerie côté popup
    components/             StatusPanel, IntervalSelector, Gallery, SnapshotDetail
    popup.css
```

### Flux d'exécution

1. L'utilisateur clique sur l'icône → le **popup** s'ouvre (permission `activeTab`
   accordée pour l'onglet courant).
2. Le popup **injecte le content script** dans l'onglet via `chrome.scripting`.
3. Le content script détecte la vidéo, lit `video.currentTime`, capture une frame
   sur un canvas invisible et l'encode en WebP.
4. Chaque image (data URL) est envoyée au **service worker**, qui la convertit en
   `Blob` et la stocke dans **IndexedDB** (origine de l'extension).
5. Le popup lit IndexedDB pour afficher la **galerie**. La capture continue même
   popup fermé (le content script reste actif dans la page).

---

## Installation & compilation

Prérequis : Node 18+ et `pnpm`.

```bash
pnpm install     # installe les dépendances
pnpm build       # vérifie les types (tsc) puis construit dans dist/
```

Pour le développement avec rechargement :

```bash
pnpm dev         # sert dist/ avec HMR pour le popup
```

Le dossier chargeable dans Chrome est **`dist/`**.

---

## Chargement dans Chrome

1. Ouvrir `chrome://extensions`.
2. Activer le **Mode développeur** (coin supérieur droit).
3. Cliquer sur **Charger l'extension non empaquetée**.
4. Sélectionner le dossier **`dist/`** généré par `pnpm build`.

---

## Procédure de test manuel

1. Ouvrir une page contenant une vidéo HTML5 standard non protégée.
2. Lancer la lecture.
3. Ouvrir l'extension (icône dans la barre d'outils).
4. Vérifier l'affichage « Vidéo détectée » (dimensions, durée, timecode, état).
5. Choisir l'intervalle **10 secondes**.
6. Cliquer sur **Démarrer**.
7. Regarder ~1 minute → environ **6 snapshots** apparaissent dans la galerie.
8. Cliquer sur **Arrêter** → aucun nouveau snapshot.
9. Vérifier que chaque snapshot a une frame et un timecode différents.
10. Mettre en **pause** → aucune nouvelle capture (« capture suspendue »).
11. Reprendre la lecture → les captures reprennent.
12. Avancer/reculer dans la timeline → le nouveau `currentTime` est utilisé.
13. Cliquer une miniature → image agrandie + métadonnées + **Télécharger cette image**.

---

## Permissions Chrome utilisées

| Permission  | Pourquoi |
|-------------|----------|
| `activeTab` | Accès **temporaire** à l'onglet courant, accordé uniquement quand l'utilisateur ouvre le popup. Évite une permission large de type `<all_urls>`. |
| `scripting` | Injecter programmatiquement le content script de capture dans l'onglet actif. |

Le stockage utilise **IndexedDB**, qui ne nécessite aucune permission. Aucune
permission d'hôte large n'est déclarée.

---

## Fonctionnement de la capture Canvas

- Méthode unique : `HTMLVideoElement` → `CanvasRenderingContext2D.drawImage()` →
  `canvas.toDataURL('image/webp', 0.80)`.
- Quand disponible, `requestVideoFrameCallback()` est utilisé pour capturer une
  frame **réellement présentée** par le lecteur ; sinon repli sur une capture directe.
- Résolution bornée à **1280 × 720** en conservant le ratio (jamais d'agrandissement
  d'une vidéo plus petite).
- Métadonnées associées à chaque snapshot : `snapshotId`, `capturedAt` (ISO),
  `mediaTime` (= `video.currentTime`), `pageTitle`, `pageUrl`, `videoWidth`,
  `videoHeight`, `imageFormat`.

Aucune capture d'écran du bureau, aucun OCR, aucun FFmpeg/Puppeteer/Playwright,
aucun service distant.

---

## Vidéos protégées (DRM)

Si une vidéo est protégée, le navigateur renvoie une image noire ou refuse la
lecture des pixels. L'extension **ne tente jamais de contourner** cette protection.
Elle affiche simplement :

> « La capture directe de cette vidéo est bloquée par le navigateur ou par la
> protection du contenu. »

Cette limitation est **acceptable pour le Cycle 1** (Netflix, Prime Video,
Disney+, Apple TV+, etc. seront étudiés dans un cycle ultérieur).

---

## États d'erreur

| Code | Message |
|------|---------|
| `VIDEO_NOT_FOUND` | Aucune vidéo HTML5 détectée. |
| `VIDEO_CAPTURE_BLOCKED` | La vidéo est détectée mais Chrome refuse de fournir les pixels. |
| `CANVAS_SECURITY_ERROR` | Capture bloquée par une restriction de sécurité / d'origine. |
| `VIDEO_NOT_READY` | La vidéo n'a pas encore chargé assez de données. |
| `CAPTURE_ERROR` | Erreur de capture inconnue. |

Les erreurs sont toujours gérées : l'extension ne plante pas.

---

## Limitations connues (Cycle 1)

- Fonctionne uniquement sur les vidéos HTML5 non protégées.
- Les contenus DRM ne sont pas capturables (par conception).
- La session de capture est locale à l'appareil ; « Effacer les captures »
  supprime définitivement les images et métadonnées.
- L'interface popup ne fonctionne que chargée comme extension (les API `chrome.*`
  sont absentes d'un simple onglet de navigateur).

---

## Préparation du Cycle 2

Le type `Snapshot` prévoit déjà un champ optionnel `description?: string`,
**jamais renseigné au Cycle 1**. Il servira ultérieurement à recevoir la
description générée par Gemini.
