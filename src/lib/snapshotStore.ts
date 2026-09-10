import type { Snapshot, AnalysisPatch } from './types'
import type { AnalysisState } from './analysis'
import type { VisualProbeRequest, ProbeStatus } from './probe'
import { isTerminalProbeStatus } from './probe'
import type { GalleryRun } from './gallery'

// Stockage local des snapshots dans IndexedDB (origine de l'extension).
// Partagé par le service worker (écriture) et le popup (lecture) : les deux
// s'exécutent dans l'origine chrome-extension:// et voient donc la même base.
// Aucune donnée n'est envoyée sur Internet.

const DB_NAME = 'comment-this-film'
const STORE = 'snapshots'
const PROBE_STORE = 'visualProbes'
const GALLERY_STORE = 'galleryRuns'
// v3 (Cycle 2 révisé) : ajout du store `visualProbes` (sondes visuelles ciblées).
// v4 (Cycle 3)        : ajout du store `galleryRuns` (galeries planifiées) et
//                       d'un index `galleryId` sur `snapshots` (filtrage par galerie).
// La migration reste NON destructive — le store `snapshots` n'est jamais vidé ni
// réécrit, les snapshots existants (Cycle 1, Cycle 2, sondes) restent lisibles
// sans changement. Les nouveaux stores/index sont seulement AJOUTÉS.
const VERSION = 4

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      const tx = req.transaction
      // Création initiale OU montée de version : on garantit la présence des
      // stores/index sans jamais supprimer ni réécrire les enregistrements existants.
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true })
      }
      if (!db.objectStoreNames.contains(PROBE_STORE)) {
        const probeStore = db.createObjectStore(PROBE_STORE, { keyPath: 'id' })
        probeStore.createIndex('status', 'status')
      }
      if (!db.objectStoreNames.contains(GALLERY_STORE)) {
        db.createObjectStore(GALLERY_STORE, { keyPath: 'id' })
      }
      // Ajoute l'index `galleryId` au store existant `snapshots` s'il manque.
      // On passe par la transaction de mise à niveau pour accéder au store déjà créé.
      if (tx && db.objectStoreNames.contains(STORE)) {
        const snapStore = tx.objectStore(STORE)
        if (!snapStore.indexNames.contains('galleryId')) {
          snapStore.createIndex('galleryId', 'galleryId')
        }
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

/** État d'analyse effectif d'un snapshot (champ absent = non demandé). */
export function analysisStateOf(s: Snapshot): AnalysisState {
  return s.analysisState ?? 'not_requested'
}

/** Ajoute un snapshot et renvoie l'id généré (incrémental durant la session). */
export async function addSnapshot(data: Omit<Snapshot, 'id'>): Promise<number> {
  const db = await openDB()
  try {
    return await new Promise<number>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite')
      const req = tx.objectStore(STORE).add(data as Snapshot)
      req.onsuccess = () => resolve(req.result as number)
      req.onerror = () => reject(req.error)
    })
  } finally {
    db.close()
  }
}

/** Renvoie tous les snapshots (ordre croissant d'id). */
export async function getAllSnapshots(): Promise<Snapshot[]> {
  const db = await openDB()
  try {
    return await new Promise<Snapshot[]>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly')
      const req = tx.objectStore(STORE).getAll()
      req.onsuccess = () => resolve(req.result as Snapshot[])
      req.onerror = () => reject(req.error)
    })
  } finally {
    db.close()
  }
}

/** Lit un snapshot unique par id (undefined s'il n'existe pas / a été effacé). */
export async function getSnapshot(id: number): Promise<Snapshot | undefined> {
  const db = await openDB()
  try {
    return await new Promise<Snapshot | undefined>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly')
      const req = tx.objectStore(STORE).get(id)
      req.onsuccess = () => resolve(req.result as Snapshot | undefined)
      req.onerror = () => reject(req.error)
    })
  } finally {
    db.close()
  }
}

/** Nombre de snapshots stockés. */
export async function countSnapshots(): Promise<number> {
  const db = await openDB()
  try {
    return await new Promise<number>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly')
      const req = tx.objectStore(STORE).count()
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
    })
  } finally {
    db.close()
  }
}

/**
 * Met à jour UNIQUEMENT les champs d'analyse d'un snapshot existant.
 * Ne crée jamais d'enregistrement : si l'id a disparu (effacement), l'appel est
 * ignoré silencieusement — une réponse tardive ne peut donc pas ressusciter un
 * snapshot effacé. Renvoie true si le snapshot existait et a été mis à jour.
 */
export async function updateAnalysisFields(id: number, patch: AnalysisPatch): Promise<boolean> {
  const db = await openDB()
  try {
    return await new Promise<boolean>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite')
      const store = tx.objectStore(STORE)
      const getReq = store.get(id)
      getReq.onsuccess = () => {
        const current = getReq.result as Snapshot | undefined
        if (!current) {
          resolve(false)
          return
        }
        const updated: Snapshot = {
          ...current,
          ...patch,
          analysisUpdatedAt: patch.analysisUpdatedAt ?? new Date().toISOString(),
        }
        const putReq = store.put(updated)
        putReq.onsuccess = () => resolve(true)
        putReq.onerror = () => reject(putReq.error)
      }
      getReq.onerror = () => reject(getReq.error)
    })
  } finally {
    db.close()
  }
}

/**
 * Réclame un snapshot pour analyse de façon ATOMIQUE (une seule transaction
 * read-modify-write) : passe l'état 'queued' → 'analyzing' et renvoie le snapshot.
 * Renvoie null si le snapshot est absent ou déjà 'analyzing' (déjà pris en charge),
 * ce qui empêche deux travaux d'analyser deux fois le même snapshot.
 */
export async function claimForAnalysis(id: number): Promise<Snapshot | null> {
  const db = await openDB()
  try {
    return await new Promise<Snapshot | null>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite')
      const store = tx.objectStore(STORE)
      const getReq = store.get(id)
      getReq.onsuccess = () => {
        const current = getReq.result as Snapshot | undefined
        if (!current) {
          resolve(null)
          return
        }
        const state = current.analysisState ?? 'not_requested'
        if (state === 'analyzing') {
          // Déjà réclamé par un autre travail.
          resolve(null)
          return
        }
        const claimed: Snapshot = {
          ...current,
          analysisState: 'analyzing',
          analysisUpdatedAt: new Date().toISOString(),
        }
        const putReq = store.put(claimed)
        putReq.onsuccess = () => resolve(claimed)
        putReq.onerror = () => reject(putReq.error)
      }
      getReq.onerror = () => reject(getReq.error)
    })
  } finally {
    db.close()
  }
}

/**
 * Marque un snapshot comme 'queued' (mise en file) s'il existe et n'est pas déjà
 * en cours ou en file. Réinitialise les champs d'erreur. Renvoie true si mis en file.
 */
export async function markQueued(id: number): Promise<boolean> {
  const db = await openDB()
  try {
    return await new Promise<boolean>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite')
      const store = tx.objectStore(STORE)
      const getReq = store.get(id)
      getReq.onsuccess = () => {
        const current = getReq.result as Snapshot | undefined
        if (!current) {
          resolve(false)
          return
        }
        const state = current.analysisState ?? 'not_requested'
        // 'not_applicable' est terminal (image non exploitable) : jamais remis en file.
        if (state === 'queued' || state === 'analyzing' || state === 'not_applicable') {
          resolve(false)
          return
        }
        const queued: Snapshot = {
          ...current,
          analysisState: 'queued',
          analysisErrorCode: undefined,
          analysisErrorMessage: undefined,
          analysisUpdatedAt: new Date().toISOString(),
        }
        const putReq = store.put(queued)
        putReq.onsuccess = () => resolve(true)
        putReq.onerror = () => reject(putReq.error)
      }
      getReq.onerror = () => reject(getReq.error)
    })
  } finally {
    db.close()
  }
}

/** Ids des snapshots non analysés (état 'not_requested' ou 'failed'). */
export async function getUnanalyzedIds(): Promise<number[]> {
  const all = await getAllSnapshots()
  return all
    .filter((s) => {
      const st = s.analysisState ?? 'not_requested'
      return st === 'not_requested' || st === 'failed'
    })
    .map((s) => s.id)
}

/**
 * Ids des travaux à reprendre après le réveil du service worker : tout snapshot
 * resté 'queued' ou 'analyzing'. Les 'analyzing' interrompus sont remis en 'queued'.
 */
export async function getResumableIds(): Promise<number[]> {
  const all = await getAllSnapshots()
  const ids: number[] = []
  for (const s of all) {
    const st = s.analysisState ?? 'not_requested'
    if (st === 'queued' || st === 'analyzing') {
      if (st === 'analyzing') {
        await updateAnalysisFields(s.id, { analysisState: 'queued' })
      }
      ids.push(s.id)
    }
  }
  return ids
}

/**
 * Efface tous les snapshots ET leurs métadonnées, ET toutes les sondes visuelles.
 * On supprime la base entière afin que le compteur d'id reparte proprement.
 */
export function clearAll(): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.deleteDatabase(DB_NAME)
    req.onsuccess = () => resolve()
    req.onerror = () => reject(req.error)
    // Si une connexion est encore ouverte ailleurs, on résout quand même.
    req.onblocked = () => resolve()
  })
}

// --- Sondes visuelles ciblées (Cycle 2 révisé) ---
// Source de vérité PERSISTÉE du cycle de vie complet d'une sonde (capture +
// analyse). Le content script n'a qu'une vue en direct éphémère de la phase
// de capture (voir CaptureState.liveProbes) ; ce store est la référence.

/** Crée une sonde (état initial, généralement 'scheduled'). Idempotent par id. */
export async function createProbe(probe: VisualProbeRequest): Promise<void> {
  const db = await openDB()
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(PROBE_STORE, 'readwrite')
      const req = tx.objectStore(PROBE_STORE).put(probe)
      req.onsuccess = () => resolve()
      req.onerror = () => reject(req.error)
    })
  } finally {
    db.close()
  }
}

/** Lit une sonde par id (undefined si absente). */
export async function getProbe(id: string): Promise<VisualProbeRequest | undefined> {
  const db = await openDB()
  try {
    return await new Promise<VisualProbeRequest | undefined>((resolve, reject) => {
      const tx = db.transaction(PROBE_STORE, 'readonly')
      const req = tx.objectStore(PROBE_STORE).get(id)
      req.onsuccess = () => resolve(req.result as VisualProbeRequest | undefined)
      req.onerror = () => reject(req.error)
    })
  } finally {
    db.close()
  }
}

/** Renvoie toutes les sondes, triées par date de création croissante. */
export async function listProbes(): Promise<VisualProbeRequest[]> {
  const db = await openDB()
  try {
    const all = await new Promise<VisualProbeRequest[]>((resolve, reject) => {
      const tx = db.transaction(PROBE_STORE, 'readonly')
      const req = tx.objectStore(PROBE_STORE).getAll()
      req.onsuccess = () => resolve(req.result as VisualProbeRequest[])
      req.onerror = () => reject(req.error)
    })
    return all.sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  } finally {
    db.close()
  }
}

/**
 * Applique un patch partiel à une sonde existante. N'écrit RIEN si la sonde a
 * disparu (aucune résurrection possible après suppression/effacement) et
 * n'écrit rien non plus si la sonde est déjà dans un état TERMINAL (sauf si le
 * patch la fait justement entrer dans cet état — transition, pas régression).
 * Renvoie true si l'écriture a eu lieu.
 */
export async function updateProbe(
  id: string,
  patch: Partial<VisualProbeRequest>,
): Promise<boolean> {
  const db = await openDB()
  try {
    return await new Promise<boolean>((resolve, reject) => {
      const tx = db.transaction(PROBE_STORE, 'readwrite')
      const store = tx.objectStore(PROBE_STORE)
      const getReq = store.get(id)
      getReq.onsuccess = () => {
        const current = getReq.result as VisualProbeRequest | undefined
        if (!current) {
          resolve(false)
          return
        }
        // Une sonde déjà terminale ne peut être modifiée QUE si le patch ne
        // tente pas de la faire régresser vers un statut non terminal.
        if (isTerminalProbeStatus(current.status) && patch.status && !isTerminalProbeStatus(patch.status)) {
          resolve(false)
          return
        }
        const updated: VisualProbeRequest = {
          ...current,
          ...patch,
          updatedAt: new Date().toISOString(),
        }
        const putReq = store.put(updated)
        putReq.onsuccess = () => resolve(true)
        putReq.onerror = () => reject(putReq.error)
      }
      getReq.onerror = () => reject(getReq.error)
    })
  } finally {
    db.close()
  }
}

/**
 * Annule une sonde SI ET SEULEMENT SI elle n'est pas déjà dans un état
 * terminal (une sonde 'succeeded'/'failed'/'missed'/'unavailable' ne peut plus
 * être annulée ; une sonde déjà 'cancelled' reste 'cancelled').
 */
export async function cancelProbe(id: string): Promise<boolean> {
  const probe = await getProbe(id)
  if (!probe || isTerminalProbeStatus(probe.status)) return false
  return updateProbe(id, { status: 'cancelled' as ProbeStatus })
}

/**
 * Ids des sondes à reprendre après le réveil du service worker : toute sonde
 * restée 'captured' (jamais mise en file) ou 'analyzing' (interrompue, remise
 * en 'captured' pour être réclamée à nouveau).
 */
export async function getResumableProbeIds(): Promise<string[]> {
  const all = await listProbes()
  const ids: string[] = []
  for (const p of all) {
    if (p.status === 'analyzing') {
      await updateProbe(p.id, { status: 'captured' })
      ids.push(p.id)
    } else if (p.status === 'captured') {
      ids.push(p.id)
    }
  }
  return ids
}

/**
 * Réclame ATOMIQUEMENT une sonde 'captured' pour analyse (captured -> analyzing).
 * Renvoie null si absente, déjà en analyse, ou dans un autre état (annulée,
 * par exemple) — empêche toute double-analyse.
 */
export async function claimProbeForAnalysis(id: string): Promise<VisualProbeRequest | null> {
  const db = await openDB()
  try {
    return await new Promise<VisualProbeRequest | null>((resolve, reject) => {
      const tx = db.transaction(PROBE_STORE, 'readwrite')
      const store = tx.objectStore(PROBE_STORE)
      const getReq = store.get(id)
      getReq.onsuccess = () => {
        const current = getReq.result as VisualProbeRequest | undefined
        if (!current || current.status !== 'captured') {
          resolve(null)
          return
        }
        const claimed: VisualProbeRequest = {
          ...current,
          status: 'analyzing',
          updatedAt: new Date().toISOString(),
        }
        const putReq = store.put(claimed)
        putReq.onsuccess = () => resolve(claimed)
        putReq.onerror = () => reject(putReq.error)
      }
      getReq.onerror = () => reject(getReq.error)
    })
  } finally {
    db.close()
  }
}

// --- Galeries planifiées (Cycle 3) ---
// Source de vérité PERSISTÉE d'une exécution de plan : métadonnées, compteurs,
// plateforme, stratégie, état. Une exécution crée TOUJOURS une nouvelle galerie.
// Migration NON destructive : les snapshots sans `galleryId` (Cycle 1/2, sondes)
// ne sont jamais affectés.

/** Crée (ou remplace idempotemment) une galerie planifiée. */
export async function createGalleryRun(run: GalleryRun): Promise<void> {
  const db = await openDB()
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(GALLERY_STORE, 'readwrite')
      const req = tx.objectStore(GALLERY_STORE).put(run)
      req.onsuccess = () => resolve()
      req.onerror = () => reject(req.error)
    })
  } finally {
    db.close()
  }
}

/** Lit une galerie par id (undefined si absente). */
export async function getGalleryRun(id: string): Promise<GalleryRun | undefined> {
  const db = await openDB()
  try {
    return await new Promise<GalleryRun | undefined>((resolve, reject) => {
      const tx = db.transaction(GALLERY_STORE, 'readonly')
      const req = tx.objectStore(GALLERY_STORE).get(id)
      req.onsuccess = () => resolve(req.result as GalleryRun | undefined)
      req.onerror = () => reject(req.error)
    })
  } finally {
    db.close()
  }
}

/** Renvoie toutes les galeries, triées de la plus récente à la plus ancienne. */
export async function listGalleryRuns(): Promise<GalleryRun[]> {
  const db = await openDB()
  try {
    const all = await new Promise<GalleryRun[]>((resolve, reject) => {
      const tx = db.transaction(GALLERY_STORE, 'readonly')
      const req = tx.objectStore(GALLERY_STORE).getAll()
      req.onsuccess = () => resolve(req.result as GalleryRun[])
      req.onerror = () => reject(req.error)
    })
    return all.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  } finally {
    db.close()
  }
}

/**
 * Applique un patch partiel à une galerie existante. N'écrit RIEN si la galerie
 * a disparu (aucune résurrection après effacement). Renvoie true si écrit.
 */
export async function updateGalleryRun(id: string, patch: Partial<GalleryRun>): Promise<boolean> {
  const db = await openDB()
  try {
    return await new Promise<boolean>((resolve, reject) => {
      const tx = db.transaction(GALLERY_STORE, 'readwrite')
      const store = tx.objectStore(GALLERY_STORE)
      const getReq = store.get(id)
      getReq.onsuccess = () => {
        const current = getReq.result as GalleryRun | undefined
        if (!current) {
          resolve(false)
          return
        }
        const updated: GalleryRun = {
          ...current,
          ...patch,
          // Les compteurs sont fusionnés en surface (le patch fournit l'objet complet).
          counters: patch.counters ?? current.counters,
        }
        const putReq = store.put(updated)
        putReq.onsuccess = () => resolve(true)
        putReq.onerror = () => reject(putReq.error)
      }
      getReq.onerror = () => reject(getReq.error)
    })
  } finally {
    db.close()
  }
}

/** Renvoie les snapshots d'une galerie donnée (ordre croissant d'id). */
export async function getSnapshotsByGallery(galleryId: string): Promise<Snapshot[]> {
  const db = await openDB()
  try {
    return await new Promise<Snapshot[]>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly')
      const index = tx.objectStore(STORE).index('galleryId')
      const req = index.getAll(galleryId)
      req.onsuccess = () => {
        const rows = (req.result as Snapshot[]).sort((a, b) => a.id - b.id)
        resolve(rows)
      }
      req.onerror = () => reject(req.error)
    })
  } finally {
    db.close()
  }
}

/**
 * Efface UNE galerie ciblée : supprime son enregistrement ET tous ses snapshots.
 * N'affecte jamais les autres galeries ni les snapshots hors galerie (Cycle 1/2,
 * sondes). Renvoie le nombre de snapshots supprimés.
 */
export async function deleteGalleryRun(galleryId: string): Promise<number> {
  const db = await openDB()
  try {
    return await new Promise<number>((resolve, reject) => {
      const tx = db.transaction([STORE, GALLERY_STORE], 'readwrite')
      const snapStore = tx.objectStore(STORE)
      const index = snapStore.index('galleryId')
      let deleted = 0
      const cursorReq = index.openCursor(galleryId)
      cursorReq.onsuccess = () => {
        const cursor = cursorReq.result
        if (cursor) {
          cursor.delete()
          deleted += 1
          cursor.continue()
        } else {
          tx.objectStore(GALLERY_STORE).delete(galleryId)
        }
      }
      cursorReq.onerror = () => reject(cursorReq.error)
      tx.oncomplete = () => resolve(deleted)
      tx.onerror = () => reject(tx.error)
    })
  } finally {
    db.close()
  }
}

/**
 * Ids des snapshots ANALYSABLES d'une galerie (image `available`, non déjà
 * en file/en cours/décrite/non applicable) — base de l'analyse Gemini activée
 * séparément par galerie. Une image non exploitable n'est JAMAIS incluse.
 */
export async function getAnalyzableGallerySnapshotIds(galleryId: string): Promise<number[]> {
  const rows = await getSnapshotsByGallery(galleryId)
  return rows
    .filter((s) => {
      const availability = s.visualAvailability ?? 'available'
      if (availability !== 'available') return false
      if (s.image.size === 0) return false
      const st = s.analysisState ?? 'not_requested'
      return st === 'not_requested' || st === 'failed'
    })
    .map((s) => s.id)
}
