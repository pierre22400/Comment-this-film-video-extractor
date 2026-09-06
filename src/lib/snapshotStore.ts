import type { Snapshot } from './types'

// Stockage local des snapshots dans IndexedDB (origine de l'extension).
// Partagé par le service worker (écriture) et le popup (lecture) : les deux
// s'exécutent dans l'origine chrome-extension:// et voient donc la même base.
// Aucune donnée n'est envoyée sur Internet.

const DB_NAME = 'comment-this-film'
const STORE = 'snapshots'
const VERSION = 1

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORE)) {
        // autoIncrement : l'id (snapshotId) est généré et injecté dans l'objet.
        db.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true })
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
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
