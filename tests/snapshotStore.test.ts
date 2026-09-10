// Vérifie que l'ajout du store `visualProbes` (Cycle 2 révisé) est une
// migration NON destructive : un snapshot déjà présent dans une base v2
// (Cycle 2 initial, sans sondes visuelles) reste lisible après l'ouverture par
// le code actuel (v3), et le nouveau store est bien disponible.
import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import { beforeEach, describe, expect, it } from 'vitest'

const DB_NAME = 'comment-this-film'

function openLegacyV2WithOneSnapshot(): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 2)
    req.onupgradeneeded = () => {
      const db = req.result
      db.createObjectStore('snapshots', { keyPath: 'id', autoIncrement: true })
    }
    req.onsuccess = () => {
      const db = req.result
      const tx = db.transaction('snapshots', 'readwrite')
      tx.objectStore('snapshots').add({
        capturedAt: new Date().toISOString(),
        mediaTime: 12.5,
        pageTitle: 'Page Cycle 1/2',
        pageUrl: 'https://example.test/video',
        videoWidth: 640,
        videoHeight: 360,
        mimeType: 'image/webp',
        image: new Blob(['x'], { type: 'image/webp' }),
        analysisState: 'succeeded',
        description: 'Une scène déjà décrite au Cycle 2 initial.',
      })
      tx.oncomplete = () => {
        db.close()
        resolve()
      }
      tx.onerror = () => reject(tx.error)
    }
    req.onerror = () => reject(req.error)
  })
}

describe('snapshotStore — migration non destructive (v2 -> v3)', () => {
  beforeEach(() => {
    // Base fraîche à chaque test (fake-indexeddb ne persiste pas entre fichiers,
    // mais on repart explicitement de zéro par précaution entre les tests).
    ;(globalThis as { indexedDB: IDBFactory }).indexedDB = new IDBFactory()
  })

  it('un snapshot créé en v2 reste lisible après l’ouverture par le code v3, et le store visualProbes existe', async () => {
    await openLegacyV2WithOneSnapshot()

    // Import dynamique APRÈS avoir peuplé la base v2, pour que l'ouverture du
    // module déclenche bien la montée de version v2 -> v3 attendue par le code actuel.
    const store = await import('../src/lib/snapshotStore')

    const all = await store.getAllSnapshots()
    expect(all).toHaveLength(1)
    expect(all[0].description).toBe('Une scène déjà décrite au Cycle 2 initial.')
    expect(all[0].analysisState).toBe('succeeded')

    // Le nouveau store est bien disponible et fonctionnel (aucune régression).
    await store.createProbe({
      id: 'p1',
      startTime: 1,
      endTime: 5,
      preferredTime: null,
      purpose: 'open_observation',
      question: 'Que voit-on ?',
      maxCaptures: 1,
      status: 'scheduled',
      createdAt: new Date().toISOString(),
    })
    const probes = await store.listProbes()
    expect(probes).toHaveLength(1)
    expect(probes[0].id).toBe('p1')

    // Le snapshot Cycle 1/2 est toujours intact après l'écriture d'une sonde.
    const stillThere = await store.getAllSnapshots()
    expect(stillThere).toHaveLength(1)
  })

  it('cancelProbe n’annule jamais une sonde déjà terminale (succeeded)', async () => {
    const store = await import('../src/lib/snapshotStore')
    await store.createProbe({
      id: 'p2',
      startTime: 1,
      endTime: 5,
      preferredTime: null,
      purpose: 'open_observation',
      question: 'Que voit-on ?',
      maxCaptures: 1,
      status: 'succeeded',
      createdAt: new Date().toISOString(),
      answer: 'Réponse déjà obtenue.',
    })
    const cancelled = await store.cancelProbe('p2')
    expect(cancelled).toBe(false)
    const probe = await store.getProbe('p2')
    expect(probe?.status).toBe('succeeded')
  })

  it('updateProbe n’écrit rien si la sonde a disparu (pas de résurrection)', async () => {
    const store = await import('../src/lib/snapshotStore')
    const wrote = await store.updateProbe('inexistant', { status: 'succeeded' })
    expect(wrote).toBe(false)
  })
})
