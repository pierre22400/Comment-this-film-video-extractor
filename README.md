# Video Extractor — Cycle 3 (POC YouTube + Prime Video validé)

Extension Google Chrome (Manifest V3) qui **capture des images d'une vidéo
HTML5** dans l'onglet actif et les stocke localement. Trois modes coexistent :
**capture périodique** (Cycle 1/2), **sondes visuelles ciblées** (Cycle 2
révisé) et **scanner visuel planifié** (Cycle 3, voir plus bas). Sur activation
explicite, les images valides sont envoyées à **Gemini** (via un relais serveur
local) pour obtenir une **description visuelle courte et factuelle**.

> La description ci-dessous conserve l'historique complet des cycles 1 et 2 ;
> les nouveautés du Cycle 3 sont détaillées dans la section
> **« Cycle 3 — scanner visuel planifié »** et dans **`CYCLE3_REPORT.md`**.

> **Limite stricte du Cycle 2 :** Gemini décrit UNIQUEMENT ce qui est
> directement visible dans une image isolée. Il n'y a encore **aucune**
> identification de film/série/personne, aucune analyse de plusieurs images
> ensemble, aucune lecture de sous-titres, aucune recherche Internet, aucune
> vérification de faits, aucune anecdote, aucun commentaire ni interprétation
> narrative. Ces capacités appartiennent à des cycles ultérieurs.

Le Cycle 1 (chaîne **HTMLVideoElement → `currentTime` → capture Canvas → snapshot
WebP → stockage → galerie**) reste pleinement fonctionnel et n'a pas été dégradé.

---

## Amendement — le snapshot devient une source facultative

Un amendement limité rend le snapshot **facultatif** plutôt qu'un prérequis
permanent : lorsqu'une image est indisponible (raison technique ou
d'autorisation), la session **continue proprement** sans jamais envoyer d'image
invalide à Gemini. Cet amendement **ne construit pas encore** le moteur complet
sans image ; il fournit le vocabulaire structuré et les garde-fous que les
cycles suivants réutiliseront. La file Gemini, le relais local, l'interface et
les tests du Cycle 2 sont préservés.

### Contrat de disponibilité visuelle (`src/lib/visual.ts`, module pur)

- `VisualAvailability` : `available · unavailable · blocked · suspected_invalid · temporary_error`.
- `VisualUnavailableCause` : `canvas_security · capture_blocked · permission_denied · image_empty · image_undecodable · suspected_blank_frame · temporary_capture_error · unsupported`.
- `VisualIncident` : disponibilité, dernier code, message lisible, timecode, date.
- `TimecodeObservation` : `{ mediaTime, snapshotId: number | null, visualAvailability, visualDescription: string | null }` — snapshot **facultatif**, pour les cycles suivants.

> Formulation prudente : on n'affirme **jamais** qu'une DRM est responsable si le
> navigateur ne le confirme pas. Un blocage est décrit « capture bloquée ou
> inaccessible ».

### Analyse : nouvel état `not_applicable`

Une image absente, vide, indécodable, bloquée ou suspecte n'est **jamais**
envoyée au relais Gemini. Dans ce cas : **aucun retry**, **aucun échec global**,
état `not_applicable`, cause visuelle conservée, message clair dans l'interface,
et **poursuite normale** de la session. Le chemin d'une image valide est
**inchangé**.

### Captures suspectes et garde de session

Une frame presque noire ou uniforme est marquée `suspected_invalid` : elle est
ignorée pour Gemini, son timecode est conservé, et **les captures suivantes
continuent**. Une seule frame sombre ne condamne jamais la session : seule une
série de **blocages consécutifs** (par défaut 3) finit par suspendre, pour
éviter une boucle d'échecs. Les erreurs Canvas / de permission produisent
désormais un **état structuré** (affiché dans le panneau d'état) au lieu de
rester uniquement dans les logs.

### Interface

Le message d'image indisponible est **distinct** d'une erreur Gemini :
« Image indisponible — la session continue sans analyse visuelle », avec la
cause technique lorsqu'elle est connue. `not_applicable` n'est jamais présenté
comme un échec de Gemini (puce neutre, non rouge).

---

## Amendement (révision) — sonde visuelle ciblée et programmable

Une seconde révision ajoute une capacité **précise et bornée**, distincte de la
capture périodique : une **sonde visuelle** — « regarde entre `t1` et `t2`, dans
un but donné, et réponds à cette question précise » — créée **explicitement**
par l'utilisateur, jamais déclenchée par une capture automatique.

### Ce qui change

- **Plus aucun appel Gemini automatique lié à la capture périodique.** L'ancienne
  bascule « Analyse Gemini activée/désactivée » (qui décrivait chaque nouveau
  snapshot périodique) est **retirée**. Le panneau **Diagnostic manuel** ne
  conserve que des actions explicites (analyser les captures non analysées en un
  clic, réessayer un snapshot en échec) — jamais lié à la capture périodique.
- **Nouvelle sonde visuelle ciblée**, pilotée par le **timecode réel** de la
  vidéo (`timeupdate`/`seeked`/`pause`, jamais un minuteur mural indépendant) :
  gère nativement la pause/reprise, le seek en avant (fenêtre sautée = manquée,
  jamais de boucle) et le seek en arrière (idempotence stricte — une sonde déjà
  résolue ne capture jamais deux fois).
- **Nouveau modèle par défaut : `gemini-3.6-flash`** (`DEFAULT_GEMINI_MODEL`,
  surchargeable via `GEMINI_MODEL`). Le fournisseur reste inchangé : appel REST
  direct à `generativelanguage.googleapis.com/v1beta`, clé dans l'en-tête
  `x-goog-api-key` — aucun SDK propriétaire, aucun endpoint déprécié.

### Cycle de vie d'une sonde

```
scheduled → waiting → capturing → captured → analyzing → succeeded
                                        ↘ unavailable (image jamais exploitable)
                     ↘ missed (fenêtre dépassée sans la moindre tentative)
scheduled/waiting → cancelled (annulation explicite)
```

- **Capture** (`src/content/visualProbeScheduler.ts`) : une image presque
  noire/uniforme est conservée (`suspected_invalid`) mais **jamais** envoyée à
  Gemini ; une capture bloquée/en erreur répétée jusqu'à épuisement du budget
  (`maxCaptures`, 1 à 3) devient `unavailable` **sans aucune image stockée**.
  Une erreur sur une sonde n'affecte jamais les autres sondes actives.
- **Analyse** (`src/background/visualProbeQueue.ts`, file **séparée** de celle du
  diagnostic manuel) : ne reçoit QUE des sondes `captured` avec une image
  `available` ; retries bornés uniquement sur erreurs transitoires ; une réponse
  tardive après suppression (changement d'epoch) ne ressuscite rien.
- **Relais** (`POST /api/visual-probe`, nouvel endpoint **distinct** de
  `/api/describe`) : prompt strict en anglais (ne décrire que le visible, ne
  jamais inventer une marque/un modèle non certain, ne jamais identifier le
  film/la série/une personne réelle, ne jamais raconter d'intrigue) ; réponse
  structurée `{ answer, observations[], confidence, limitations[] }` **validée
  avant tout stockage** — une réponse vide, mal typée ou hors bornes devient une
  erreur, jamais un succès stocké.

### Interface

Nouveau panneau **Sondes visuelles** : création (fenêtre, intention, question),
liste avec statut et réponse, annulation d'une sonde non encore résolue, et un
raccourci démo (« sonde dans 10 s »). Panneau **Diagnostic manuel** distinct,
sans bascule automatique.

> Cette révision ne construit pas un moteur de sondes illimité : une image par
> sonde (au plus `maxCaptures` tentatives), aucune identification d'œuvre/de
> personne, aucun raisonnement inter-images, aucune recherche Internet. Ce sont
> les mêmes limites strictes que le Cycle 2 initial, simplement appliquées au
> nouveau contrat structuré.

---

## Cycle 3 — scanner visuel planifié

Un **mode séparé** s'ajoute aux deux précédents : l'utilisateur colle une
**fixture JSON de planner**, l'extension effectue les captures aux **timecodes
demandés**, crée une **nouvelle galerie locale à chaque exécution**, et —
uniquement sur **activation explicite** — envoie les images **valides** de cette
galerie au relais Gemini local. Les fonctionnalités et tests du Cycle 2 sont
**préservés**.

> **Sécurité (inchangée et stricte) :** aucun contournement DRM/EME/CORS/HDCP,
> aucune extraction de flux. Une image noire ou indisponible reste un résultat
> valable à diagnostiquer, jamais un échec à masquer ni une accusation de DRM.
> Le POC propose aussi, par activation explicite, une capture de l'onglet tel
> qu'il est affiché par Chrome, puis un recadrage du lecteur. Cette voie ne lit
> pas le flux Prime ; Chrome reste seul à décider si les pixels sont fournis.

### Planner JSON v1

```json
{
  "version": 1,
  "name": "stress-test-01",
  "mode": "seek",
  "settleMs": 450,
  "items": [
    { "at": "00:00:30" },
    { "at": "00:01:00" },
    { "from": "00:05:00", "count": 10, "everySeconds": 5 }
  ]
}
```

- Timecodes : `HH:MM:SS(.mmm)` **ou** secondes décimales positives.
- Rafales développées de façon **déterministe**, puis **tri + déduplication**
  avec une tolérance documentée de **50 ms**.
- Plan **borné à 500 captures** ; un plan **vide/invalide/hors durée** est rejeté
  avec un message lisible. `mode` : `seek` (défaut) ou `playback` ; `settleMs`
  entre 0 et 5000 (défaut 400).
- Exemples chargeables : `fixtures/planners/youtube-smoke.json` et
  `fixtures/planners/scanner-stress-300.json` (reproductibles).

### Runner de capture (`src/content/plannedCaptureRunner.ts`)

- **« Exécuter le plan »** / **« Annuler »**.
- **seek** (défaut) : règle `video.currentTime`, attend `seeked` puis une frame
  présentée si disponible, applique `settleMs`, capture. Attentes et retries
  **strictement bornés** (jamais de boucle infinie). Le lecteur et les sondes
  indépendantes sont restaurés après le scan.
- **playback** : suit la lecture **naturelle** jusqu'au timecode, respecte les
  pauses et ignore un timecode déjà dépassé — **aucune vitesse de lecture non
  exposée n'est jamais forcée**.
- Le timecode observé est **toujours** `video.currentTime`.
- Statuts persistants : `pending`, `seeking`, `capturing`, `captured`,
  `skipped`, `unavailable`, `failed`, `cancelled`, avec progression, timecode
  demandé et timecode capturé.

### Essai « onglet visible » pour Prime Video

La case **« Essai Prime : capturer l'onglet visible, puis recadrer le lecteur »**
active une seconde source d'image, distincte de la capture Canvas directe :

```
lecteur Prime affiché → chrome.tabs.captureVisibleTab()
→ image de l'onglet visible → recadrage sur le rectangle du lecteur → WebP
```

- L'utilisateur garde l'onglet Prime **au premier plan** et le lecteur
  **entièrement visible** pendant le scan.
- Cette capture est une représentation fournie par Chrome de l'affichage ; elle
  n'accède pas au média chiffré, ne déchiffre rien et n'extrait aucun flux.
- Si Chrome livre des pixels noirs, le statut reste `unavailable` et Gemini ne
  reçoit rien. Si l'image est exploitable, elle suit exactement le même cycle
  local (galerie, export, Gemini explicitement demandé) que YouTube.
- Le POC a été validé manuellement sur **YouTube** (capture Canvas directe) et
  sur **Prime Video** (capture d'onglet visible recadrée).

### Galeries locales, plateformes et export

- Images en **WebP** (max 1280×720, qualité 0,80), inchangé.
- Objet persistant **`GalleryRun`** (id, nom, date, URL/titre, plateforme,
  fixture, stratégie, état, compteurs et états détaillés des timecodes).
  **Une exécution = une nouvelle galerie.**
  Migration IndexedDB **v3 → v4 non destructive** (test dédié).
- **Reconnaissance de plateforme** : YouTube et Prime Video affichés
  explicitement, repli **HTML5 générique**.
- **Sélecteur de galerie** filtrant les images affichées + **effacement ciblé**
  après confirmation.
- **« Exporter la galerie »** : téléchargements **explicites** des WebP et d'un
  `manifest.json` sous `Téléchargements/Comment-this-film/<gallery-id>/`
  (permission minimale `downloads`). Une extension ne peut pas administrer
  silencieusement un dossier arbitraire hors de Téléchargements : la galerie
  **gérée** par l'extension est **IndexedDB**.

### Gemini activable séparément (par galerie)

Case **désactivée par défaut** : « Analyser avec Gemini les captures de cette
galerie ». Désactivée → **aucun** appel Gemini. Activée → seules les images
**valides** de la galerie choisie sont mises en file (concurrence bornée). Cela
**n'active jamais** l'analyse des captures périodiques ordinaires. Une frame
noire/uniforme/bloquée/non décodable devient `not_applicable` et ne part
**jamais** vers Gemini.

### Procédure de test manuel du scanner planifié

1. `pnpm build` puis recharger l'extension dans `chrome://extensions`.
2. Ouvrir une vidéo YouTube ou Prime Video. Pour Prime, garder le lecteur
   entièrement visible et cocher l'essai **« onglet visible »** décrit ci-dessus.
3. Ouvrir le popup → section **Scanner visuel planifié**.
4. Cliquer **« Exemple : YouTube smoke »** (ou coller un plan), vérifier
   l'**aperçu du plan résolu** (nombre de captures, mode, settle).
5. Cliquer **« Exécuter le plan »** → suivre la **progression** (statuts par
   item : positionnement, capture, capturé/ignoré/indisponible).
6. Vérifier qu'une **nouvelle galerie** apparaît dans le sélecteur avec ses
   compteurs.
7. (Facultatif, avec relais + clé) cocher **« Analyser avec Gemini les captures
   de cette galerie »** → seules les images valides sont décrites.
8. **« Exporter la galerie »** → vérifier les fichiers WebP + `manifest.json`
   sous `Téléchargements/Comment-this-film/<id>/`.
9. **« Effacer cette galerie »** (avec confirmation) → la galerie et ses images
   disparaissent, les autres galeries et les captures hors galerie restent.
10. Sur **Prime Video** : vérifier d'abord un petit plan (8 captures) avec
    l'essai **« onglet visible »**. Les images exploitables doivent apparaître
    dans une nouvelle galerie ; une image noire isolée reste `unavailable` et
    ne part jamais vers Gemini.

Le rapport factuel de ce cycle se trouve dans **`CYCLE3_REPORT.md`**.

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
suivants. Aucune analyse n'est automatique : le **diagnostic manuel** (analyser
les captures non analysées, réessayer un échec) et les **sondes visuelles
ciblées** (voir la section d'amendement ci-dessus) sont les deux seuls chemins
qui appellent Gemini, tous deux déclenchés explicitement par l'utilisateur.

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
  config.ts                 Lecture env : GEMINI_API_KEY, GEMINI_MODEL, host/port, CORS
  cors.ts                   Politique CORS PURE (origine autorisée, jamais de joker)
  geminiClient.ts           Client Gemini multimodal (describe() + probe() ; interface + implémentation)
  describeHandler.ts        Handler PUR /api/describe (diagnostic manuel)
  visualProbeHandler.ts     Handler PUR /api/visual-probe (sonde visuelle, réponse structurée validée)
  index.ts                  Serveur HTTP Node (127.0.0.1), CORS, timeouts, logs sans image
  tsconfig.json

src/lib/
  analysis.ts               Types + validation + classification retry PARTAGÉS (diagnostic manuel)
  visual.ts                 Contrat de disponibilité visuelle (image facultative)
  probe.ts                  Contrat de la sonde visuelle : types, validation requête/réponse
  types.ts                  Snapshot étendu (captureOrigin/probeId optionnels) + AnalysisPatch
  snapshotStore.ts          Migration IndexedDB v1→v2→v3 (NON destructive) + CRUD sondes
  messages.ts               Messages popup <-> content script <-> service worker

src/background/
  analysisQueue.ts          File PURE du diagnostic manuel (concurrence 1, retries, epoch)
  visualProbeQueue.ts       File PURE des sondes visuelles (séparée, même design éprouvé)
  index.ts                  Câblage : blob→base64, appels relais, CRUD sondes, récupération

src/content/
  visualProbeScheduler.ts   Sonde visuelle : capture pilotée par le timecode réel de la vidéo
  plannedCaptureRunner.ts   Cycle 3 : runner du scanner planifié (seek/lecture, statuts, annulation)

src/lib/ (ajouts Cycle 3)
  planner.ts                Planner JSON v1 PUR (parse, expansion rafales, tri+dédup, bornes 500)
  gallery.ts                Contrat GalleryRun (PUR) : métadonnées + compteurs + plateforme
  platform.ts               Détection de plateforme PURE (YouTube / Prime / repli HTML5)
  export.ts                 Manifest d'export PUR (noms de fichiers triés, chemins Téléchargements)

fixtures/planners/          Exemples de plans reproductibles (youtube-smoke, scanner-stress-300)

src/popup/
  analysisLabels.ts         Libellés/états du diagnostic manuel
  probeLabels.ts            Libellés FR des sondes visuelles (statuts, intentions)
  scannerLabels.ts          Cycle 3 : libellés FR des statuts d'items planifiés + plateformes
  components/ScannerPanel.tsx  Cycle 3 : plan JSON, aperçu, exécution, galeries, Gemini, export
  components/DiagnosticPanel.tsx    Actions explicites uniquement (jamais de bascule automatique)
  components/VisualProbePanel.tsx  Création/liste/annulation de sondes + raccourci démo
  (Gallery / SnapshotDetail mis à jour : origine de capture, description, erreur, réessai)

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
cp .env.example .env      # puis renseigner GEMINI_API_KEY et ALLOWED_EXTENSION_ORIGIN
pnpm server               # démarre le relais sur http://127.0.0.1:8787
# ou, avec rechargement :
pnpm server:watch
```

`pnpm server` et `pnpm server:watch` **chargent réellement le fichier `.env`**
au démarrage (parseur intégré, aucune dépendance ajoutée). Toute variable déjà
définie dans l'environnement **reste prioritaire** sur le fichier `.env` ; la clé
n'est jamais journalisée.

### Variables d'environnement (fichier `.env`, jamais committé)

| Variable                   | Rôle                                                             | Défaut              |
|----------------------------|------------------------------------------------------------------|---------------------|
| `GEMINI_API_KEY`           | Clé d'API Google Gemini (**obligatoire**)                        | —                   |
| `GEMINI_MODEL`             | Modèle Gemini Flash multimodal (optionnel)                       | `gemini-3.6-flash`  |
| `RELAY_HOST`               | Interface d'écoute (locale par défaut)                           | `127.0.0.1`         |
| `RELAY_PORT`               | Port d'écoute                                                    | `8787`              |
| `ALLOWED_EXTENSION_ORIGIN` | Origine d'extension autorisée (CORS), ex : `chrome-extension://<ID>` | — (voir ci-dessous) |

Seul `.env.example` (sans vraie clé) est suivi par Git ; tous les autres `.env*`
sont ignorés.

### Restriction d'accès au relais (CORS)

Le relais **n'utilise plus** `Access-Control-Allow-Origin: *`. Il autorise
**uniquement** l'origine configurée dans `ALLOWED_EXTENSION_ORIGIN` :

- origine autorisée → acceptée, avec un `Access-Control-Allow-Origin` **exact** (jamais de joker) ;
- toute autre origine de navigateur → **refusée** (`403 ORIGIN_NOT_ALLOWED`), préflight `OPTIONS` compris ;
- l'en-tête `Vary: Origin` est toujours renvoyé ;
- l'écoute reste **locale** (`127.0.0.1`) par défaut ;
- un appel **sans origine** (curl, tests serveur, outils non-navigateur) reste **permis**, ce qui conserve un moyen sûr de tester le serveur sans navigateur ;
- si `ALLOWED_EXTENSION_ORIGIN` n'est pas défini, **aucune** origine de navigateur n'est acceptée (posture stricte).

#### Récupérer l'identifiant d'extension (`chrome://extensions`)

1. Ouvrir `chrome://extensions`.
2. Activer le **Mode développeur** (coin supérieur droit).
3. **Charger l'extension non empaquetée** → sélectionner le dossier `dist/`.
4. Sous le nom de l'extension, repérer l'**ID** (ex : `abcdefghijklmnopabcdefghijklmnop`).
5. Renseigner dans `.env` : `ALLOWED_EXTENSION_ORIGIN=chrome-extension://<ID>`.
6. Redémarrer `pnpm server` pour prendre en compte la valeur.

### Contrat de l'endpoint `POST /api/describe`

Entrée : `{ snapshotId, mediaTime, mimeType, imageBase64 }`.
Succès : `{ snapshotId, description, model, latencyMs }`.
Erreur : `{ error: { code, message, retryable } }`.

Le relais valide strictement la méthode, le type MIME, la présence/taille de
l'image, l'identifiant, le timecode (fini et positif) et la taille de requête.
La réponse du modèle est **validée avant d'être renvoyée** : une réponse vide ou
mal formée devient une erreur (jamais une description stockée).

### Contrat de l'endpoint `POST /api/visual-probe`

Distinct de `/api/describe` (diagnostic manuel, description libre) : répond à
une **question ciblée** avec une réponse **structurée**, jamais stockée si invalide.

Entrée : `{ probeId, snapshotId, mediaTime, mimeType, imageBase64, purpose, question }`.
Succès : `{ probeId, snapshotId, mediaTime, purpose, question, answer, observations[], confidence, limitations[], model, latencyMs }`.
Erreur : `{ error: { code, message, retryable } }` (même contrat que `/api/describe`).

La réponse structurée est validée avant tout stockage : `answer` doit être une
chaîne non vide, `confidence` est bornée dans `[0, 1]`, `observations` et
`limitations` sont des tableaux de chaînes (éventuellement vides). Une réponse
vide, mal typée ou hors bornes devient une erreur `INVALID_MODEL_RESPONSE`,
jamais un succès stocké.

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
| `scripting` | Injecter programmatiquement le content script de capture (et de sonde visuelle) dans l'onglet actif. |
| `downloads` | **Cycle 3 uniquement** : export **explicite** d'une galerie planifiée (WebP + `manifest.json`) sous `Téléchargements/Comment-this-film/<id>/`. Aucune écriture silencieuse hors de Téléchargements n'est possible. |
| `tabs` | **Cycle 3, essai explicite Prime** : demander à Chrome une image de l'onglet visible (`captureVisibleTab`), puis recadrer localement la zone du lecteur. Aucun accès au flux vidéo. |

`host_permissions` : **uniquement** `http://127.0.0.1:8787/*` (le relais local,
pour `/api/describe` **et** `/api/visual-probe`), jamais une permission d'hôte
large. Le stockage des snapshots et des sondes visuelles utilise **IndexedDB**,
qui ne nécessite aucune permission. La permission `storage` n'est plus
nécessaire depuis le retrait de la bascule d'analyse automatique (diagnostic
manuel = actions explicites uniquement).

---

## Fonctionnement des captures

- Mode standard : `HTMLVideoElement` → `CanvasRenderingContext2D.drawImage()` →
  `canvas.toDataURL('image/webp', 0.80)`.
- Essai Prime explicite : `chrome.tabs.captureVisibleTab()` → image de l'onglet
  → recadrage local du rectangle du lecteur → WebP. Il nécessite un onglet
  visible au premier plan ; cette voie ne contourne aucune protection.
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

## Vidéos protégées (DRM) et rendu visible

Si une vidéo est protégée, la capture directe du `<video>` peut produire une
image noire ou refuser la lecture des pixels. L'extension **ne tente jamais de
contourner** cette protection. Elle peut alors effectuer, seulement sur action
explicite, l'essai de capture de l'onglet visible ; Chrome peut fournir une
image affichée ou la masquer selon le rendu et la politique du contenu.

> « La capture directe de cette vidéo est bloquée par le navigateur ou par la
> protection du contenu. »

Cette limite est **assumée par conception**. Le POC Cycle 3 a validé YouTube
par capture directe et Prime Video par capture de l'onglet visible recadrée.
Dans tous les cas, une image bloquée/noire devient un item `unavailable`, le
plan continue, et aucune image invalide n'est envoyée à Gemini.

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

- La capture Canvas directe fonctionne uniquement lorsque Chrome fournit les
  pixels de la vidéo ; elle est validée sur YouTube.
- L'essai d'onglet visible est validé sur Prime Video dans ce POC, mais dépend
  du lecteur, de l'état visible de l'onglet et de la politique Chrome ; il n'est
  pas une garantie universelle sur tous les contenus protégés.
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
