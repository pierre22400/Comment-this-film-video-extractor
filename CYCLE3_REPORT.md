# Cycle 3 — Scanner visuel planifié (rapport factuel)

Ce cycle ajoute un **mode séparé de scanner visuel planifié** : l'utilisateur
colle une fixture JSON de planner, l'extension effectue les captures aux
timecodes demandés, crée une **nouvelle galerie locale à chaque exécution**, et
— uniquement sur activation explicite — envoie les images **valides** de cette
galerie au relais Gemini local.

Toutes les fonctionnalités et tous les tests du **Cycle 2** sont **préservés**
(capture périodique, sondes visuelles ciblées, diagnostic manuel, relais local,
sécurité de la clé). Le POC cible **YouTube** et **Prime Video**, avec un repli
HTML5 générique, **sans jamais contourner** de protection de contenu
(DRM/EME/CORS/HDCP) ni extraire de flux vidéo. Une image indisponible ou noire
sur Prime est un **résultat valable à diagnostiquer proprement**, jamais un
échec à masquer.

---

## 1. Architecture

Le Cycle 3 est construit exclusivement à partir de **modules purs** testables et
de couches d'orchestration minces, dans la continuité du style des cycles
précédents.

```
src/lib/
  planner.ts            Planner JSON v1 (PUR) : parse timecode, expansion des
                        rafales, tri + déduplication tolérante, bornage à 500
                        captures, validation (version, mode, settleMs, durée).
  gallery.ts            Contrat GalleryRun (PUR) : id, nom, date, URL/titre,
                        plateforme, fixture, stratégie, état, compteurs.
  platform.ts           detectPlatform(url) -> 'youtube' | 'prime' | 'html5'.
  export.ts             Manifest d'export (PUR) : noms de fichiers triés,
                        chemins sous Téléchargements/Comment-this-film/<id>/.
  snapshotStore.ts      Migration IndexedDB v3 -> v4 NON destructive : ajout du
                        store `galleryRuns` + index `galleryId` sur `snapshots`,
                        CRUD galeries, requêtes par galerie, suppression ciblée,
                        sélection des images analysables.
  types.ts              Snapshot étendu (galleryId, requestedTime optionnels).
  messages.ts           Nouveaux messages RUN_PLAN / CANCEL_PLAN / GET_PLAN_STATE
                        et CREATE/FINALIZE/LIST/DELETE/ANALYZE/EXPORT_GALLERY.

src/content/
  plannedCaptureRunner.ts   RUNNER de capture (testable) : parcours séquentiel
                            du plan en mode `seek` (défaut) ou `playback` ;
                            attentes et retries STRICTEMENT bornés ; statuts
                            persistants ; annulation coopérative.
  index.ts                  Câblage : instancie le runner, remonte chaque image
                            au service worker, finalise la galerie.

src/background/
  index.ts              Cycle de vie des galeries : création, stockage des
                        snapshots planifiés (compteurs), finalisation, liste,
                        suppression ciblée, analyse Gemini activée PAR GALERIE,
                        export (téléchargements explicites via chrome.downloads).

src/popup/
  scannerLabels.ts               Libellés FR des statuts d'items + plateformes.
  components/ScannerPanel.tsx    Zone JSON + validation lisible + aperçu du plan
                                 résolu + exemples chargeables + Exécuter/Annuler
                                 + progression + sélecteur de galerie + case
                                 « Analyser avec Gemini » + Exporter + Effacer.

fixtures/planners/
  youtube-smoke.json          Plan léger reproductible (8 captures).
  scanner-stress-300.json     Plan de stress reproductible (300 captures).
```

### Planner JSON v1

Deux formes d'items :

```json
{ "at": "00:00:30" }
{ "from": "00:05:00", "count": 10, "everySeconds": 5 }
```

- Timecodes acceptés : `HH:MM:SS(.mmm)` **et** secondes décimales positives.
- Les rafales sont développées de façon **déterministe** (arrondi milliseconde),
  puis l'ensemble est **trié et dédupliqué** avec une tolérance documentée de
  **50 ms** (`DEDUP_TOLERANCE_SECONDS`).
- Le plan est **borné à 500 captures** ; un plan **vide**, **invalide**, avec un
  **mode** ou un **settleMs** hors bornes, ou **hors durée connue** est rejeté
  avec un message lisible.
- `mode` : `seek` (défaut) ou `playback`. `settleMs` : délai de stabilisation
  après positionnement (0 à 5000 ms, défaut 400).

### Runner de capture

- Boutons **« Exécuter le plan »** et **« Annuler »**.
- **seek** (défaut) : règle `video.currentTime`, attend l'événement `seeked`
  (avec repli borné par `seekTimeoutMs`), attend une frame réellement présentée
  via `requestVideoFrameCallback` si disponible (borné par `frameTimeoutMs`),
  applique `settleMs`, puis capture (retries bornés par `maxAttemptsPerItem`).
- **playback** : laisse la lecture **naturelle** atteindre chaque timecode. Une
  pause ne consomme pas le délai d'inactivité ; le délai est réarmé tant que la
  vidéo progresse. Un timecode déjà dépassé est ignoré au lieu de recapturer la
  frame courante. **Aucune vitesse de lecture non exposée par le player n'est
  jamais forcée** ; le mode n'est pas un « turbo » de lecture.
- Le timecode observé est **toujours** `video.currentTime`, jamais une horloge
  murale.
- Statuts persistants d'item : `pending`, `seeking`, `capturing`, `captured`,
  `skipped`, `unavailable`, `failed`, `cancelled`. La progression, le timecode
  demandé et le timecode capturé sont affichés.
- En mode seek, le lecteur est mis en pause, les sondes indépendantes sont
  temporairement détachées, puis le timecode et l'état de lecture initiaux sont
  restaurés avant leur réactivation.

### Galeries locales et export

- Les images restent en **WebP** (max 1280×720, qualité 0,80) — inchangé par
  rapport aux cycles précédents. Gemini accepte le WebP ; aucun passage en PNG
  n'a été nécessaire.
- Objet persistant **`GalleryRun`** : id, nom, date, URL/titre, plateforme,
  fixture, stratégie, état (`running`/`completed`/`cancelled`) et compteurs
  (`planned`, `captured`, `unavailable`, `skipped`, `failed`), ainsi que les
  états détaillés de chaque timecode.
- **Une exécution crée toujours une nouvelle galerie.** La migration IndexedDB
  v3 → v4 est **non destructive** (test dédié).
- **Sélecteur de galerie** et **effacement ciblé** d'une galerie **après
  confirmation**. La galerie d'images est filtrée sur la sélection ; une option
  permet de revoir toutes les captures. Les autres galeries et snapshots hors
  galerie survivent.
- **« Exporter la galerie »** : téléchargements **explicites** des WebP et d'un
  `manifest.json` sous **`Téléchargements/Comment-this-film/<gallery-id>/`**, via
  la permission Chrome **minimale** `downloads`.
- Une extension **ne peut pas** créer ni administrer silencieusement un dossier
  arbitraire hors de Téléchargements : la galerie **gérée** par l'extension est
  **IndexedDB** ; l'export est un téléchargement explicite déclenché par
  l'utilisateur.

### Gemini activable séparément (par galerie)

- Contrôle **désactivé par défaut** : « Analyser avec Gemini les captures de
  cette galerie ».
- Désactivé : **aucun** appel au relais Gemini.
- Activé : seules les **images valides** de la galerie choisie sont mises en
  file (concurrence bornée par la file de diagnostic existante, réutilisée sans
  régression).
- N'active **jamais** l'analyse des captures périodiques ordinaires.
- Une frame noire, uniforme, bloquée ou non décodable devient `not_applicable`
  et ne part **jamais** vers Gemini. La clé reste hors extension, le relais reste
  local, les validateurs de réponse existants sont conservés.

---

## 2. Limites constatées sur YouTube et Prime

Ces limites relèvent de la conception (respect strict du périmètre de sécurité),
pas de bugs.

### YouTube

- Sur une vidéo YouTube **standard non protégée**, la chaîne
  `HTMLVideoElement → canvas.drawImage → toDataURL('image/webp')` fonctionne : le
  runner peut positionner `currentTime` et capturer aux timecodes du plan.
- Le seek dépend du **bufferisation** du lecteur : un seek loin en avant peut
  nécessiter un rechargement ; le runner attend `seeked` **de façon bornée** puis
  poursuit (jamais de boucle infinie). Un item dont le seek n'aboutit pas dans le
  délai est marqué `unavailable`.
- Certaines vidéos YouTube (contenu protégé, publicités interstitielles) peuvent
  refuser la capture des pixels : l'image est alors `blocked`/`unavailable`,
  **jamais** contournée.

### Prime Video

- Prime Video utilise en général la **protection de contenu (EME/DRM)**. Le
  navigateur renvoie alors une **image noire** ou refuse la lecture des pixels du
  canvas. C'est le comportement **attendu** : l'extension **ne tente jamais** de
  neutraliser DRM/EME/CORS/HDCP.
- Dans ce cas, le runner enregistre un **incident structuré** (`blocked` /
  `suspected_blank_frame` selon le cas), marque l'item `unavailable`, **poursuit
  le plan**, et **n'envoie jamais** l'image à Gemini. La galerie reflète
  fidèlement le diagnostic (compteur `unavailable`).
- Une frame presque noire mais techniquement lisible est classée
  `suspected_invalid` : l'image est **conservée** (timecode gardé) mais **jamais
  analysée**.

> Aucune de ces situations n'est présentée comme un échec de Gemini. Le message
> reste prudent : « capture bloquée ou inaccessible », jamais une accusation de
> DRM que le navigateur ne confirme pas.

---

## 3. Tests réalisés et résultats

Les tests utilisent Vitest, des **modules purs** et des **faux objets**
(faux `HTMLVideoElement` par duck-typing, `fake-indexeddb`, faux client Gemini) :
**aucun appel réseau réel, aucun appel Gemini payant**.

### Tests ajoutés au Cycle 3

| Fichier | Portée | Nb |
|---------|--------|----|
| `tests/planner.test.ts` | parse timecode, tri/déduplication, expansion des rafales, **idempotence**, bornes 500, mode/settleMs, hors durée, erreurs JSON | 19 |
| `tests/plannerFixtures.test.ts` | validité + reproductibilité des deux fixtures (dont 300 captures exactes) | 2 |
| `tests/platform.test.ts` | détection YouTube / Prime / repli HTML5 | 4 |
| `tests/export.test.ts` | noms de fichiers triés, chemins, **manifest**, data URL JSON | 5 |
| `tests/galleryStore.test.ts` | **migration v3 → v4 non destructive**, CRUD galeries, requêtes par galerie, **suppression ciblée**, progression concurrente, éligibilité Gemini | 6 |
| `tests/gallery.test.ts` | reconstruction autoritaire des compteurs depuis les états finaux | 1 |
| `tests/plannedCaptureRunner.test.ts` | intégration mockée d'un `HTMLVideoElement` : **seek**, pause/reprise (playback), timecode dépassé, **annulation**, **timeout borné**, **image indisponible**, image suspecte, `onDone` unique | 11 |

### Résultats des trois commandes obligatoires

Toutes exécutées avec succès (voir la section « Commandes » du README pour la
procédure exacte) :

- **`pnpm typecheck`** → succès (extension + serveur, `tsc --noEmit`).
- **`pnpm test`** → **138 tests passés / 138** (90 du Cycle 2 **préservés** + 48
  ajoutés au Cycle 3). Aucun test existant supprimé ni dégradé.
- **`pnpm build`** → succès. Le bundle `dist/` se construit ; un test automatisé
  (`tests/noSecrets.test.ts`) vérifie qu'**aucune** référence à `GEMINI_API_KEY`,
  à `process.env` ni à l'URL directe de l'API Gemini n'apparaît dans `src/` (donc
  jamais dans `dist/`).

---

## 4. Stockage, export et confidentialité

- **Stockage** : IndexedDB (origine de l'extension). Store `galleryRuns` ajouté
  en **v4** ; index `galleryId` ajouté au store existant `snapshots`. Les
  snapshots des cycles précédents (sans `galleryId`) restent **intacts et
  lisibles**.
- **Export** : téléchargements **explicites** (WebP + `manifest.json`) sous
  `Téléchargements/Comment-this-film/<gallery-id>/`. Permission ajoutée :
  `downloads` (minimale). Aucune écriture silencieuse hors de Téléchargements
  n'est possible.
- **Confidentialité** : lorsqu'une galerie est analysée, le relais ne transmet à
  Gemini que l'**image (base64)**, son **type MIME**, l'**identifiant technique**
  du snapshot et le **timecode**. Le titre de page, l'URL et l'historique **ne
  sont jamais** transmis à Gemini (ils figurent uniquement dans le manifest
  d'export **local**, qui reste sur la machine de l'utilisateur). La clé Gemini
  reste **exclusivement côté serveur**.

---

## 5. Hors périmètre (rappel)

Ce cycle **ne fait pas** : extraction de flux vidéo, contournement DRM/EME/
CORS/HDCP, capture du bureau, OCR, identification d'œuvre/de personne, analyse
inter-images, génération d'audiodescription, TTS. Il valide **exclusivement** le
scanner d'images planifié et son envoi **optionnel** à Gemini.
