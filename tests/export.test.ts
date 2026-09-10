import { describe, it, expect } from 'vitest'
import { buildGalleryManifest, imageFilename, exportPath, extensionForMime, jsonToDataUrl } from '../src/lib/export'
import type { GalleryRun } from '../src/lib/gallery'
import type { Snapshot } from '../src/lib/types'

function fakeSnapshot(partial: Partial<Snapshot> & { id: number }): Snapshot {
  return {
    id: partial.id,
    capturedAt: '2026-09-10T10:00:00.000Z',
    mediaTime: partial.mediaTime ?? 10,
    pageTitle: 'Titre',
    pageUrl: 'https://example.test/v',
    videoWidth: 1280,
    videoHeight: 720,
    mimeType: partial.mimeType ?? 'image/webp',
    image: new Blob(['x'], { type: partial.mimeType ?? 'image/webp' }),
    ...partial,
  }
}

const run: GalleryRun = {
  id: 'gal-1',
  name: 'stress-test',
  createdAt: '2026-09-10T09:00:00.000Z',
  pageUrl: 'https://example.test/v',
  pageTitle: 'Titre',
  platform: 'youtube',
  fixtureName: 'stress-test',
  strategy: 'seek',
  state: 'completed',
  counters: { planned: 3, captured: 2, unavailable: 1, skipped: 0, failed: 0 },
}

describe('export — noms de fichiers', () => {
  it('déduit l’extension du type MIME', () => {
    expect(extensionForMime('image/webp')).toBe('webp')
    expect(extensionForMime('image/png')).toBe('png')
    expect(extensionForMime('image/jpeg')).toBe('jpg')
    expect(extensionForMime('inconnu')).toBe('webp')
  })

  it('nomme les images avec un index trié à 4 chiffres', () => {
    expect(imageFilename(0, 'image/webp')).toBe('snapshot-0001.webp')
    expect(imageFilename(11, 'image/png')).toBe('snapshot-0012.png')
  })

  it('construit un chemin sous Téléchargements/Comment-this-film/<id>/', () => {
    expect(exportPath('gal-1', 'manifest.json')).toBe('Comment-this-film/gal-1/manifest.json')
  })
})

describe('export — manifest', () => {
  it('inclut toutes les images ordonnées avec leurs métadonnées', () => {
    const snaps = [
      fakeSnapshot({ id: 3, mediaTime: 30, description: 'une scène', analysisState: 'succeeded' }),
      fakeSnapshot({ id: 1, mediaTime: 10, requestedTime: 10 }),
      fakeSnapshot({ id: 2, mediaTime: 20, visualAvailability: 'suspected_invalid', analysisState: 'not_applicable' }),
    ]
    const m = buildGalleryManifest(run, snaps, '2026-09-10T11:00:00.000Z')
    expect(m.galleryId).toBe('gal-1')
    expect(m.images).toHaveLength(3)
    // Ordre croissant d'id -> fichiers 0001,0002,0003.
    expect(m.images.map((i) => i.file)).toEqual([
      'snapshot-0001.webp',
      'snapshot-0002.webp',
      'snapshot-0003.webp',
    ])
    expect(m.images[0].snapshotId).toBe(1)
    expect(m.images[2].description).toBe('une scène')
    expect(m.images[1].visualAvailability).toBe('suspected_invalid')
    expect(m.geminiRequested).toBe(false)
  })

  it('jsonToDataUrl produit une data URL application/json base64 décodable', () => {
    const dataUrl = jsonToDataUrl({ é: 'accentué' }, (s) => Buffer.from(s, 'binary').toString('base64'))
    expect(dataUrl.startsWith('data:application/json;base64,')).toBe(true)
    const b64 = dataUrl.split(',')[1]
    const decoded = Buffer.from(b64, 'base64').toString('binary')
    // On récupère bien les octets UTF-8 encodés (les accents sont préservés).
    const text = decodeURIComponent(escape(decoded))
    expect(JSON.parse(text)).toEqual({ é: 'accentué' })
  })
})
