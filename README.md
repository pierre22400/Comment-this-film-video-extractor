# Comment-this-film — Cycle 2

Extension Google Chrome (Manifest V3) qui **capture périodiquement des images
d'une vidéo HTML5** dans l'onglet actif, les stocke localement, puis — sur
activation explicite — envoie chaque image à **Gemini** (via un relais serveur
local) pour obtenir une **description visuelle courte et factuelle**.

> **Limite stricte du Cycle 2 :** Gemini décrit UNIQUEMENT ce qui est
> directement visible dans une image isolée. Il n'y a encore **aucune**
> identification de film/série/personne, aucune analyse de plusieurs images
> ensemble, aucune lecture de sous-titres, aucune recherche Internet, aucune
> vérification de faits, aucune anecdote, aucun commentaire ni interprétation
> narrative. Ces capacités appartiennent à des cycles ultérieurs.

Le Cycle 1 (chaîne **HTMLVideoElement → `currentTime` → capture Canvas → snapshot
WebP → stockage → galerie**) reste pleinement fonctionnel et n'a pas été dégradé.

---

## Nouveautés du Cycle 2

Pipeline d'analyse, **indépendant de la capture** :

```
snapshot WebP
→ file d'attente (service worker)
→ relais serveur local (127.0.0.1:8787)
→ Gemini multimodal
→ réponse JSON validée
→ description stockée dans IndexedDB
→ affichage dans la galerie
```

Une analyse lente ou en échec **ne bloque jamais** la capture des snapshots
suivants. La bascule « Analyse Gemini » est **désactivée par défaut** pour éviter
tout appel payant involontaire.

### Données envoyées à Gemini

Pour chaque snapshot, le relais transmet **uniquement** :

- l'image (base64) et son type MIME ;
- l'identifiant technique du snapshot ;
- le timecode (`mediaTime`).

Ne sont **jamais** transmis : le titre de la page, l'URL, l'historique, ni les
autres captures. Le prompt interdit explicitement d'identifier une œuvre ou une
personne et d'inventer un nom propre.

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

## Architecture (ajouts Cycle 2)

```
server/                     Relais serveur local (SÉPARÉ de l'extension)
  config.ts                 Lecture env : GEMINI_API_KEY, GEMINI_MODEL, host/port
  geminiClient.ts           Client Gemini multimodal (interface + implémentation)
  describeHandler.ts        Handler PUR /api/describe (validation + appel + validation réponse)
  index.ts                  Serveur HTTP Node (127.0.0.1), CORS, timeouts, logs sans image
  tsconfig.json

src/lib/
  analysis.ts               Types + validation + classification retry PARTAGÉS
  types.ts                  Snapshot étendu (champs d'analyse optionnels) + AnalysisPatch
  snapshotStore.ts          Migration IndexedDB v1→v2 + claim atomique + patch ciblé
  messages.ts               Messages d'analyse popup <-> service worker

src/background/
  analysisQueue.ts          File d'attente PURE (concurrence 1, retries, epoch)
  index.ts                  Câblage : blob→base64, appel relais, bascule, récupération

src/popup/
  analysisLabels.ts         Libellés/états d'analyse
  components/AnalysisControl.tsx   Bascule + analyse par lot
  (Gallery / SnapshotDetail mis à jour : état, description, erreur, réessai, modèle, latence)

tests/                      Tests Vitest (faux client Gemini, aucun appel payant)
```

**Sécurité de la clé :** la clé Gemini n'existe QUE côté serveur. Elle n'est
jamais dans le dépôt, ni dans le code de l'extension, ni dans le bundle `dist/`,
ni dans IndexedDB, ni dans l'interface, ni dans les logs. Un test automatisé
vérifie qu'aucune référence à `GEMINI_API_KEY` n'existe dans `src/`.

---

## Installation & compilation

Prérequis : Node 18+ et `pnpm`.

```bash
pnpm install         # installe les dépendances
pnpm typecheck       # vérifie les types (extension + serveur)
pnpm test            # tests Vitest (faux Gemini, aucun appel réseau)
pnpm build           # tsc --noEmit puis build de l'extension dans dist/
```

Pour le développement avec rechargement :

```bash
pnpm dev             # sert dist/ avec HMR pour le popup
```

Le dossier chargeable dans Chrome est **`dist/`**.

---

## Configuration & lancement du relais Gemini

Le relais est **séparé** de l'extension et lit la clé côté serveur uniquement.

```bash
cp .env.example .env      # puis renseigner GEMINI_API_KEY
pnpm server               # démarre le relais sur http://127.0.0.1:8787
# ou, avec rechargement :
pnpm server:watch
```

### Variables d'environnement (fichier `.env`, jamais committé)

| Variable         | Rôle                                             | Défaut              |
|------------------|--------------------------------------------------|---------------------|
| `GEMINI_API_KEY` | Clé d'API Google Gemini (**obligatoire**)        | —                   |
| `GEMINI_MODEL`   | Modèle Gemini Flash multimodal (optionnel)       | `gemini-2.5-flash`  |
| `RELAY_HOST`     | Interface d'écoute                               | `127.0.0.1`         |
| `RELAY_PORT`     | Port d'écoute                                    | `8787`              |

Seul `.env.example` (sans vraie clé) est suivi par Git ; tous les autres `.env*`
sont ignorés.

### Contrat de l'endpoint `POST /api/describe`

Entrée : `{ snapshotId, mediaTime, mimeType, imageBase64 }`.
Succès : `{ snapshotId, description, model, latencyMs }`.
Erreur : `{ error: { code, message, retryable } }`.

Le relais valide strictement la méthode, le type MIME, la présence/taille de
l'image, l'identifiant, le timecode (fini et positif) et la taille de requête.
La réponse du modèle est **validée avant d'être renvoyée** : une réponse vide ou
mal formée devient une erreur (jamais une description stockée).

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

### Test manuel de l'analyse Gemini (Cycle 2)

> Nécessite une **vraie clé** `GEMINI_API_KEY` dans `.env`.

1. Démarrer le relais : `cp .env.example .env`, renseigner la clé, puis `pnpm server`.
2. `pnpm build` puis recharger l'extension dans `chrome://extensions`.
3. Ouvrir une vidéo HTML5 non protégée et lancer la lecture.
4. Dans le popup, activer **Analyse Gemini** (désactivée par défaut).
5. Capturer **trois** snapshots espacés de **10 secondes**.
6. Vérifier que les trois descriptions apparaissent (état « Décrit »).
7. Vérifier que chaque description correspond **uniquement** à son image.
8. Simuler une panne : arrêter le relais (ou pointer un port fermé) → les
   snapshots passent en **Erreur**.
9. Confirmer que la **capture continue** malgré les erreurs d'analyse.
10. Confirmer que les erreurs restent visibles et que **Réessayer** relance
    l'analyse une fois le relais redémarré.

> Note : ce dépôt ne prétend pas avoir exécuté le test Gemini réel — aucune clé
> valide n'est fournie ici. Les tests automatisés (`pnpm test`) utilisent un
> **faux client Gemini** et n'effectuent aucun appel payant.

---

## Permissions Chrome utilisées

| Permission  | Pourquoi |
|-------------|----------|
| `activeTab` | Accès **temporaire** à l'onglet courant, accordé uniquement quand l'utilisateur ouvre le popup. Évite une permission large de type `<all_urls>`. |
| `scripting` | Injecter programmatiquement le content script de capture dans l'onglet actif. |
| `storage`   | Mémoriser la bascule « Analyse Gemini » (désactivée par défaut). |

`host_permissions` : **uniquement** `http://127.0.0.1:8787/*` (le relais local),
jamais une permission d'hôte large. Le stockage des snapshots utilise
**IndexedDB**, qui ne nécessite aucune permission.

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

### Comportement en cas d'erreur d'analyse (Cycle 2)

La file distingue les erreurs **transitoires** (retentées) des erreurs
**permanentes** (non retentées) :

| Situation | `retryable` | Politique |
|-----------|-------------|-----------|
| Timeout (~20 s), réseau, `408`, `429`, `5xx` | oui | jusqu'à **1 tentative + 2 retries**, backoff exponentiel court avec jitter |
| `400`, `401`, `403`, réponse invalide | non | échec immédiat, visible dans l'interface, **Réessayer** manuel possible |
| Relais absent / non configuré (`SERVER_NOT_CONFIGURED`) | non | message clair ; **la capture locale n'est pas affectée** |

Concurrence : **un seul** appel Gemini actif à la fois. Les travaux `queued`
sont **repris** après le réveil du service worker. « Effacer les captures »
annule les travaux en attente ; une réponse tardive ne peut pas ressusciter un
snapshot effacé (garde par génération/epoch).

---

## Limitations connues

**Cycle 1 (capture) :**

- Fonctionne uniquement sur les vidéos HTML5 non protégées.
- Les contenus DRM ne sont pas capturables (par conception).
- La session de capture est locale à l'appareil ; « Effacer les captures »
  supprime définitivement les images et métadonnées.
- L'interface popup ne fonctionne que chargée comme extension (les API `chrome.*`
  sont absentes d'un simple onglet de navigateur).

**Cycle 2 (analyse) :**

- L'analyse nécessite le **relais local démarré** avec une clé Gemini valide.
- Gemini décrit **une image isolée** : pas d'identification d'œuvre/personne, pas
  de mise en relation de plusieurs images, pas de sous-titres, pas de recherche.
- La qualité et la latence dépendent du modèle et de l'API Gemini.

---

## Ce que le Cycle 2 ne fait PAS (rappel explicite)

Il n'existe **encore aucune** recherche Internet, **aucun** caption enrichi
(identification de film/série/épisode/personne), **aucune** génération de
commentaire, d'anecdote, d'opinion ou d'interprétation narrative, et **aucune**
mise en relation de plusieurs snapshots. Le Cycle 2 se limite strictement à la
description visuelle factuelle d'images isolées. Ces capacités relèvent de cycles
ultérieurs.

Le rapport factuel de ce cycle se trouve dans **`CYCLE2_REPORT.md`**.
