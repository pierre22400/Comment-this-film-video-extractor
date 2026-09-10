Cycle : 2 (révision)
Branche : cycle2-revision (créée depuis cycle2, qui reste intacte)

Objectif : ajouter une sonde visuelle ciblée et programmable ("regarde entre
t1 et t2, dans un but donné, et réponds à cette question précise"), déclenchée
EXPLICITEMENT par l'utilisateur, jamais par la capture périodique. Retirer tout
appel Gemini automatique lié à la capture périodique (l'ancienne bascule
"Analyse Gemini activée/désactivée" contredisait cette exigence).

Prompt initial : voir la spécification collée en début de conversation
(fichier joint, 814 lignes) + les consignes complémentaires (39 lignes).

Nombre de générations V0 : à renseigner (valeur humaine, non inventée)
Crédits consommés : à renseigner (valeur humaine, non inventée)

Décisions validées avec l'utilisateur avant implémentation (AskUserQuestions) :
- Retrait complet de la bascule d'analyse automatique, remplacée par un panneau
  "Diagnostic manuel" à actions explicites uniquement (analyser les captures
  non analysées en un clic, réessayer un snapshot en échec).
- Nouvel endpoint dédié POST /api/visual-probe (contrat structuré), distinct de
  /api/describe qui reste inchangé pour le diagnostic manuel.

Fonctions réussies au premier jet :
- Modèle Gemini par défaut mis à jour vers `gemini-3.6-flash`
  (DEFAULT_GEMINI_MODEL, un seul endroit, surchargeable via GEMINI_MODEL) ;
  fournisseur REST inchangé (aucun SDK, aucun endpoint déprécié réintroduit).
- Contrat pur de la sonde visuelle (src/lib/probe.ts) : VisualProbeRequest,
  ProbePurpose, ProbeStatus (avec transitions terminales explicites),
  validation de la requête (fenêtre t1<t2, question non vide, maxCaptures
  borné 1-3) et validation stricte de la réponse structurée Gemini
  (answer non vide, confidence dans [0,1], observations/limitations = tableaux
  de chaînes) — une réponse vide/mal typée/hors bornes devient une erreur,
  jamais un succès stocké.
- Migration IndexedDB v2 -> v3 NON destructive : nouveau store `visualProbes`
  ajouté ; le store `snapshots` n'est jamais touché (testé explicitement :
  les snapshots du Cycle 1/2 restent lisibles après la migration).
- CRUD pur des sondes (createProbe/getProbe/listProbes/updateProbe/cancelProbe/
  claimProbeForAnalysis/getResumableProbeIds) avec garde anti-régression
  d'état terminal et réclamation atomique captured -> analyzing (anti double-
  analyse, même design éprouvé que analysisQueue.ts).
- Sonde temporelle content script (src/content/visualProbeScheduler.ts) :
  pilotée par le timecode RÉEL de la vidéo (timeupdate/seeked/pause), jamais un
  minuteur mural indépendant. Gère : pause (aucune tentative pendant la pause,
  reprise normale ensuite), seek en avant qui saute la fenêtre (=> missed, pas
  de boucle), seek en arrière dans une fenêtre déjà résolue (=> aucune
  deuxième capture, idempotence stricte), image presque noire/uniforme
  conservée mais jamais envoyée à Gemini avant épuisement du budget de
  tentatives, capture bloquée de façon répétée => unavailable SANS aucune
  image stockée. Une erreur sur une sonde n'affecte jamais les autres sondes
  actives (isolation testée).
- File d'attente séparée des sondes (src/background/visualProbeQueue.ts) :
  même design que analysisQueue.ts (concurrence 1, timeout, retries transitoires
  bornés, backoff+jitter, garde epoch, reprise après réveil) ; ne reçoit QUE des
  sondes captured avec image 'available' — jamais une image 'suspected_invalid'.
- Nouvel endpoint POST /api/visual-probe (server/visualProbeHandler.ts) :
  handler pur, prompt anglais strict (ne décrire que le visible, ne jamais
  inventer une marque/un modèle non certain, ne jamais identifier le film/la
  série/une personne réelle, ne jamais raconter d'intrigue), réponse structurée
  validée avant tout renvoi. Même politique CORS restrictive que /api/describe
  (aucune régression, testée).
- Câblage service worker : CREATE_VISUAL_PROBE / CANCEL_VISUAL_PROBE /
  LIST_VISUAL_PROBES / PROBE_STATUS_UPDATE / PROBE_CAPTURED / PROBE_UNAVAILABLE
  / PROBE_MISSED, reprise des sondes interrompues après réveil du service
  worker (analyzing -> captured -> réclamée à nouveau).
- Interface : nouveau panneau "Sondes visuelles" (création avec fenêtre/but/
  question, liste avec statut et réponse, annulation d'une sonde non résolue,
  raccourci démo "+10 s"). Panneau "Diagnostic manuel" qui remplace l'ancienne
  bascule automatique (actions explicites uniquement). Badge "Sonde" sur les
  snapshots issus d'une sonde visuelle (galerie + vue détaillée).
- Permission Chrome `storage` retirée du manifest (devenue inutile : plus de
  bascule persistée à mémoriser).
- 47 nouveaux tests automatisés (Vitest) avec un faux client Gemini, couvrant
  les scénarios du cahier des charges (pause/reprise, seek avant/arrière,
  idempotence, image suspecte non envoyée, capture bloquée => unavailable sans
  image, annulation, validation stricte de la réponse structurée, non-
  régression CORS/modèle/config) => 90 tests au total, tous au vert.
- Sécurité de la clé : 0 référence à GEMINI_API_KEY et 0 URL d'API Gemini dans
  dist/ (vérifié après build).

Fonctions absentes : aucune fonction requise par cette révision laissée de
côté. Hors périmètre par conception (comme pour le Cycle 2 initial) :
identification d'œuvre/personne, raisonnement inter-images, recherche
Internet, anecdotes/commentaire narratif, moteur de sondes illimité (bornées à
1-3 tentatives par sonde, une seule image par sonde).

Bugs bloquants : aucun connu au terme de cette révision.

Bugs mineurs : aucun connu. Le point d'attention identifié en amont (le
`whenIdle()` de la file d'attente doit utiliser un `setTimeout` réel et non le
`sleep` injecté, sous peine d'affamer les timers pendant les tests) a été
directement appliqué à `visualProbeQueue.ts` dès l'écriture, en s'appuyant sur
la correction déjà documentée pour `analysisQueue.ts`.

Régressions : aucune détectée.
- La bascule automatique et le message `SET_ANALYSIS_ENABLED` ont été retirés
  intentionnellement (changement de contrat demandé), pas une régression.
- `/api/describe` (diagnostic manuel), le contrat CORS, le contrat de
  disponibilité visuelle (src/lib/visual.ts) et la chaîne de capture périodique
  du Cycle 1/2 restent inchangés dans leur logique.
- Les 43 tests du Cycle 2 initial (+ amendement) passent toujours sans
  modification de leur assertion, à l'exception du stub `fakeGemini` dans
  describeHandler.test.ts (ajout d'une méthode `probe()` requise par
  l'interface GeminiClient étendue) et du modèle par défaut dans
  serverConfig.test.ts (gemini-2.5-flash -> gemini-3.6-flash).

Corrections demandées à V0 : à renseigner (valeur humaine, non inventée)
Corrections effectuées hors V0 : à renseigner (valeur humaine, non inventée)

Tests réellement exécutés dans cette révision (automatiques) :
- `pnpm typecheck` : succès (extension + serveur).
- `pnpm test` : 11 fichiers, 90 tests, tous au vert.
- `pnpm build` : succès ; audit dist/ : 0 occurrence de GEMINI_API_KEY, 0 URL
  d'API Gemini, 0 occurrence littérale du modèle en dur hors config.ts.
- Test de fumée du relais HTTP (sans clé, endpoint /api/visual-probe) :
  POST -> 500 SERVER_NOT_CONFIGURED (non retryable), OPTIONS origine refusée ->
  403, route inconnue -> 404. Comportement identique à /api/describe.

Test Gemini réel de bout en bout (sonde visuelle) : NON exécuté (aucune clé
valide fournie dans cet environnement). La procédure reproductible (créer une
sonde depuis le popup pendant la lecture d'une vidéo, avec GEMINI_API_KEY
valide) est documentée dans le README, section "Amendement (révision)".

État final :
PARTIAL

Justification de l'état :
Toutes les fonctions de cette révision sont implémentées et couvertes par des
tests automatisés au vert, la clé Gemini reste exclusivement côté serveur, la
bascule automatique contraire au cahier des charges a été retirée, aucune
régression n'a été détectée sur le Cycle 2 initial ni sur l'amendement de
disponibilité visuelle, et le typecheck/test/build réussissent tous. L'état
est marqué PARTIAL — et non PASS — uniquement parce que le test Gemini RÉEL de
bout en bout (création d'une sonde visuelle pendant la lecture d'une vraie
vidéo, avec une clé API valide) n'a pas pu être exécuté faute de clé fournie
dans cet environnement. Après un test manuel réussi avec une vraie clé, l'état
peut être promu à PASS.
