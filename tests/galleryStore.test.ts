// Vérifie la migration NON destructive v3 -> v4 (ajout du store `galleryRuns`
// et de l'index `galleryId`) et le CRUD des galeries planifiées (Cycle 3).
import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { GalleryRun } from '../src/lib/gallery'
import type { Snapshot } from '../src/lib/types'

const DB_NAME = 'comment-this-film'

/** Peuple une base v3 (Cycle 2 révisé) avec un snapshot et une sonde. */
function openLegacyV3(): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 3)
    req.onupgradeneeded = () => {
      const db = req.result
      db.createObjectStore('snapshots', { keyPath: 'id', autoIncrement: true })
      const probeStore = db.createObjectStore('visualProbes', { keyPath: 'id' })
      probeStore.createIndex('status', 'status')
    }
    req.onsuccess = () => {
      const db = req.result
      const tx = db.transaction('snapshots', 'readwrite')
      tx.objectStore('snapshots').add({
        capturedAt: new Date().toISOString(),
        mediaTime: 12.5,
        pageTitle: 'Ancienne capture',
        pageUrl: 'https://example.test/v',
        videoWidth: 640,
        videoHeight: 360,
        mimeType: 'image/webp',
        image: new Blob(['x'], { type: 'image/webp' }),
        analysisState: 'succeeded',
        description: 'Décrite au Cycle 2.',
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

function galleryRun(id: string, planned = 3): GalleryRun {
  return {
    id,
    name: `run-${id}`,
    createdAt: new Date().toISOString(),
    pageUrl: 'https://example.test/v',
    pageTitle: 'Titre',
    platform: 'youtube',
    fixtureName: `run-${id}`,
    strategy: 'seek',
    state: 'running',
    counters: { planned, captured: 0, unavailable: 0, skipped: 0, failed: 0 },
  }
}

function snapshotFor(galleryId: string, extra: Partial<Snapshot> = {}): Omit<Snapshot, 'id'> {
  return {
    capturedAt: new Date().toISOString(),
    mediaTime: 10,
    pageTitle: 'Titre',
    pageUrl: 'https://example.test/v',
    videoWidth: 1280,
    videoHeight: 720,
    mimeType: 'image/webp',
    image: new Blob(['payload'], { type: 'image/webp' }),
    captureOrigin: 'manual',
    galleryId,
    analysisState: 'not_requested',
    ...extra,
  }
}

describe('galleryStore — migration v3 -> v4 + CRUD (Cycle 3)', () => {
  beforeEach(() => {
    vi.resetModules()
    ;(globalThis as { indexedDB: IDBFactory }).indexedDB = new IDBFactory()
  })

  it('un snapshot v3 reste intact après ouverture v4 ; le store galleryRuns existe', async () => {
    await openLegacyV3()
    const store = await import('../src/lib/snapshotStore')

    const all = await store.getAllSnapshots()
    expect(all).toHaveLength(1)
    expect(all[0].description).toBe('Décrite au Cycle 2.')

    // Le nouveau store fonctionne (migration non destructive réussie).
    await store.createGalleryRun(galleryRun('g1'))
    const runs = await store.listGalleryRuns()
    expect(runs).toHaveLength(1)
    expect(runs[0].id).toBe('g1')

    // Le snapshot Cycle 2 est toujours là après écriture d'une galerie.
    expect(await store.getAllSnapshots()).toHaveLength(1)
  })

  it('getSnapshotsByGallery ne renvoie que les snapshots de la galerie', async () => {
    const store = await import('../src/lib/snapshotStore')
    await store.createGalleryRun(galleryRun('gA'))
    await store.createGalleryRun(galleryRun('gB'))
    await store.addSnapshot(snapshotFor('gA', { mediaTime: 1 }))
    await store.addSnapshot(snapshotFor('gA', { mediaTime: 2 }))
    await store.addSnapshot(snapshotFor('gB', { mediaTime: 3 }))
    // Un snapshot hors galerie (Cycle 1/2) ne doit jamais remonter.
    await store.addSnapshot({ ...snapshotFor('gA'), galleryId: undefined, captureOrigin: 'periodic' })

    const a = await store.getSnapshotsByGallery('gA')
    const b = await store.getSnapshotsByGallery('gB')
    expect(a).toHaveLength(2)
    expect(b).toHaveLength(1)
  })

  it('deleteGalleryRun efface uniquement la galerie ciblée et ses snapshots', async () => {
    const store = await import('../src/lib/snapshotStore')
    await store.createGalleryRun(galleryRun('gA'))
    await store.createGalleryRun(galleryRun('gB'))
    await store.addSnapshot(snapshotFor('gA'))
    await store.addSnapshot(snapshotFor('gA'))
    await store.addSnapshot(snapshotFor('gB'))
    const outsider = await store.addSnapshot({
      ...snapshotFor('gA'),
      galleryId: undefined,
      captureOrigin: 'periodic',
    })

    const deleted = await store.deleteGalleryRun('gA')
    expect(deleted).toBe(2)
    expect(await store.getGalleryRun('gA')).toBeUndefined()
    expect(await store.getGalleryRun('gB')).toBeDefined()
    expect(await store.getSnapshotsByGallery('gB')).toHaveLength(1)
    // Le snapshot hors galerie survit à la suppression ciblée.
    expect(await store.getSnapshot(outsider)).toBeDefined()
  })

  it('updateGalleryRun applique un patch et ne ressuscite jamais une galerie disparue', async () => {
    const store = await import('../src/lib/snapshotStore')
    await store.createGalleryRun(galleryRun('gA', 5))
    const ok = await store.updateGalleryRun('gA', {
      state: 'completed',
      counters: { planned: 5, captured: 4, unavailable: 1, skipped: 0, failed: 0 },
    })
    expect(ok).toBe(true)
    const run = await store.getGalleryRun('gA')
    expect(run?.state).toBe('completed')
    expect(run?.counters.captured).toBe(4)

    const wrote = await store.updateGalleryRun('inexistant', { state: 'completed' })
    expect(wrote).toBe(false)
  })

  it('getAnalyzableGallerySnapshotIds n’inclut que les images valides non traitées', async () => {
    const store = await import('../src/lib/snapshotStore')
    await store.createGalleryRun(galleryRun('gA'))
    const valid = await store.addSnapshot(snapshotFor('gA', { visualAvailability: 'available' }))
    // Image suspecte : non applicable, jamais éligible.
    await store.addSnapshot(
      snapshotFor('gA', { visualAvailability: 'suspected_invalid', analysisState: 'not_applicable' }),
    )
    // Déjà décrite : ne doit pas être renvoyée.
    await store.addSnapshot(snapshotFor('gA', { analysisState: 'succeeded', description: 'ok' }))
    // Image vide (taille 0) : jamais éligible.
    await store.addSnapshot(snapshotFor('gA', { image: new Blob([], { type: 'image/webp' }) }))

    const ids = await store.getAnalyzableGallerySnapshotIds('gA')
    expect(ids).toEqual([valid])
  })
})
