Cycle : 2
Objectif : description automatique des snapshots

Prompt initial : voir la spécification « Cycle 2 — Description automatique des
snapshots avec Gemini » fournie au démarrage du cycle (branche cycle2).

Nombre de générations V0 : à renseigner (valeur humaine, non inventée)
Crédits consommés : à renseigner (valeur humaine, non inventée)

Fonctions réussies au premier jet :
- Types d'analyse partagés (analysis.ts) + extension non destructive de Snapshot.
- Migration IndexedDB v1 -> v2 sans suppression des snapshots existants.
- Fonctions ciblées : claim atomique (anti double-analyse), patch d'analyse,
  reprise des travaux, ids non analysés.
- Relais serveur local (handler pur + client Gemini injectable + serveur HTTP)
  avec validation stricte d'entrée et de la réponse du modèle.
- File d'attente pure : concurrence 1, timeout, retries transitoires bornés,
  backoff exponentiel + jitter, garde par epoch, reprise après réveil.
- Câblage service worker : bascule persistée, auto-mise-en-file, appel relais.
- Interface : bascule (désactivée par défaut), états par snapshot, description,
  erreur lisible, bouton Réessayer, analyse par lot avec confirmation, modèle
  et latence en vue détaillée.
- 21 tests automatisés (Vitest) au vert avec un faux client Gemini.
- Sécurité de la clé : 0 référence à GEMINI_API_KEY dans src/ et dans dist/.

Amendement (snapshot facultatif) — ajouté au cours du cycle, branche cycle2 :
- Contrat de disponibilité visuelle pur (src/lib/visual.ts) : VisualAvailability,
  VisualUnavailableCause, VisualIncident, TimecodeObservation, classification
  d'erreur de capture, détection d'image suspecte, garde de session.
- Nouvel état d'analyse 'not_applicable' : une image non exploitable n'est jamais
  envoyée à Gemini, aucun retry, cause conservée, session poursuivie.
- Résilience de capture : erreurs Canvas/permission => état structuré (plus
  seulement des logs) ; frame suspecte ignorée pour Gemini mais conservée ; une
  seule observation ne stoppe jamais la session (garde de blocages consécutifs).
- Interface : message distinct d'une erreur Gemini + cause technique ; puce
  'Image indisponible' neutre (non rouge) ; notice d'incident dans le panneau.
- 8 tests d'amendement ajoutés => 29 tests au total, tous au vert.
- Le chemin Gemini d'une image valide reste inchangé.

Fonctions absentes : aucune fonction requise du Cycle 2 laissée de côté.
(Hors périmètre par conception, y compris pour l'amendement : identification
d'œuvre/personne, multi-images, sous-titres, recherche Internet, anecdotes,
commentaire — non implémentés volontairement. L'amendement prépare seulement le
terrain pour une image facultative, sans construire le moteur « sans image ».)

Bugs bloquants : aucun connu au terme du cycle.

Bugs mineurs :
- Correction en cours de cycle : `whenIdle()` de la file utilisait le `sleep`
  injecté (microtâche) et affamait les timers réels pendant les tests ; remplacé
  par un `setTimeout` réel. Sans impact sur le code de production hors attente.

Régressions : aucune. Le typecheck, les tests et le build passent ; la chaîne de
capture du Cycle 1 est inchangée (aucun fichier de capture réécrit dans sa
logique ; seuls des champs optionnels et un état 'not_requested' ont été ajoutés).

Corrections demandées à V0 : à renseigner (valeur humaine, non inventée)
Corrections effectuées hors V0 : à renseigner (valeur humaine, non inventée)

Tests réellement exécutés dans ce cycle (automatiques) :
- `pnpm typecheck` : succès (extension + serveur).
- `pnpm test` (Cycle 2 initial) : 3 fichiers, 21 tests, tous au vert.
- `pnpm test` (après amendement) : 4 fichiers, 29 tests, tous au vert
  (21 tests initiaux + 8 tests d'amendement de disponibilité visuelle).
- `pnpm build` : succès ; audit dist/ : 0 occurrence de GEMINI_API_KEY et 0 URL
  d'API Gemini (vérifié à nouveau après amendement).
- Test de fumée du relais HTTP (sans clé) : OPTIONS -> 204, POST -> 500
  SERVER_NOT_CONFIGURED (non retryable), route inconnue -> 404, logs sans image.

Test Gemini réel de bout en bout : NON exécuté (aucune clé valide fournie ici).
La procédure reproductible est documentée dans le README.

État final :
PARTIAL

Justification de l'état :
Toutes les fonctions du Cycle 2 sont implémentées et couvertes par des tests
automatisés au vert, la clé reste exclusivement côté serveur, la capture du
Cycle 1 est préservée, et le typecheck/test/build réussissent. L'état est marqué
PARTIAL — et non PASS — uniquement parce que le test Gemini RÉEL de bout en bout
n'a pas pu être exécuté faute de clé `GEMINI_API_KEY` valide dans cet
environnement. Après un test manuel réussi avec une vraie clé (procédure fournie
dans le README), l'état peut être promu à PASS.
