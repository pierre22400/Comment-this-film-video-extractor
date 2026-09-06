import type { Snapshot, AnalysisPatch } from './types'
import type { AnalysisState } from './analysis'

// Stockage local des snapshots dans IndexedDB (origine de l'extension).
// Partagé par le service worker (écriture) et le popup (lecture) : les deux
// s'exécutent dans l'origine chrome-extension:// et voient donc la même base.
// Aucune donnée n'est envoyée sur Internet.

const DB_NAME = 'comment-this-film'
const STORE = 'snapshots'
// v2 (Cycle 2) : ajout des champs d'analyse Gemini. La migration est NON
// destructive — les snapshots du Cycle 1 sont conservés tels quels (les champs
// d'analyse sont optionnels et traités comme 'not_requested' à la lecture).
const VERSION = 2

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      // Création initiale (v1) OU montée de version : on garantit la présence
      // du store sans jamais supprimer ni réécrire les enregistrements existants.
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true })
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
        if (state === 'queued' || state === 'analyzing') {
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
 * Efface tous les snapshots ET leurs métadonnées.
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
