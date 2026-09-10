import { describe, expect, it } from 'vitest'
import { countersFromItems, type GalleryItemState } from '../src/lib/gallery'

/**
 * Vérifie que la synthèse persistée distingue une image exploitable d'une
 * image suspecte stockée mais interdite d'analyse Gemini.
 */
describe('countersFromItems', () => {
  it('reconstruit tous les compteurs finaux du plan', () => {
    const items: GalleryItemState[] = [
      { index: 0, requestedTime: 1, status: 'captured', availability: 'available' },
      {
        index: 1,
        requestedTime: 2,
        status: 'captured',
        availability: 'suspected_invalid',
      },
      { index: 2, requestedTime: 3, status: 'unavailable', availability: 'blocked' },
      { index: 3, requestedTime: 4, status: 'skipped' },
      { index: 4, requestedTime: 5, status: 'failed' },
      { index: 5, requestedTime: 6, status: 'cancelled' },
    ]

    expect(countersFromItems(items)).toEqual({
      planned: 6,
      captured: 1,
      unavailable: 2,
      skipped: 1,
      failed: 1,
    })
  })
})
