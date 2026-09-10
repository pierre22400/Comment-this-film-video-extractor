import { describe, it, expect } from 'vitest'
import {
  parseTimecode,
  sortAndDedupe,
  resolvePlan,
  parseAndResolvePlan,
  MAX_PLAN_CAPTURES,
  DEDUP_TOLERANCE_SECONDS,
} from '../src/lib/planner'

describe('planner — parseTimecode', () => {
  it('analyse HH:MM:SS(.mmm)', () => {
    expect(parseTimecode('00:00:30')).toBe(30)
    expect(parseTimecode('00:01:00')).toBe(60)
    expect(parseTimecode('01:02:03')).toBe(3723)
    expect(parseTimecode('00:00:02.250')).toBeCloseTo(2.25, 3)
    expect(parseTimecode('1:2:3')).toBe(3723)
  })

  it('accepte des secondes décimales positives (chaîne ou nombre)', () => {
    expect(parseTimecode('42')).toBe(42)
    expect(parseTimecode('42.5')).toBe(42.5)
    expect(parseTimecode(12.75)).toBe(12.75)
    expect(parseTimecode(0)).toBe(0)
  })

  it('rejette les entrées invalides ou négatives', () => {
    expect(parseTimecode('')).toBeNull()
    expect(parseTimecode('  ')).toBeNull()
    expect(parseTimecode('-5')).toBeNull()
    expect(parseTimecode(-1)).toBeNull()
    expect(parseTimecode('abc')).toBeNull()
    expect(parseTimecode('00:99:99')).toBeNull()
    expect(parseTimecode(Number.POSITIVE_INFINITY)).toBeNull()
  })
})

describe('planner — sortAndDedupe (tri + déduplication tolérante)', () => {
  it('trie croissant et supprime les quasi-doublons dans la tolérance', () => {
    const out = sortAndDedupe([10, 5, 10.02, 5.01, 20])
    expect(out).toEqual([5, 10, 20])
  })

  it('conserve deux timecodes distants de plus que la tolérance', () => {
    const out = sortAndDedupe([1, 1 + DEDUP_TOLERANCE_SECONDS + 0.001])
    expect(out).toHaveLength(2)
  })
})

describe('planner — resolvePlan (validation + expansion)', () => {
  it('développe une rafale de façon déterministe et reproductible', () => {
    const doc = {
      version: 1,
      items: [{ from: '00:05:00', count: 10, everySeconds: 5 }],
    }
    const a = resolvePlan(doc)
    const b = resolvePlan(doc)
    expect(a.ok).toBe(true)
    if (a.ok && b.ok) {
      expect(a.plan.timecodes).toEqual(b.plan.timecodes) // idempotence stricte
      expect(a.plan.timecodes[0]).toBe(300)
      expect(a.plan.timecodes[9]).toBe(345)
      expect(a.plan.timecodes).toHaveLength(10)
    }
  })

  it('fusionne items ponctuels et rafales, trie et déduplique', () => {
    const doc = {
      version: 1,
      items: [{ at: '00:00:30' }, { at: '00:01:00' }, { from: '00:00:30', count: 2, everySeconds: 30 }],
    }
    const r = resolvePlan(doc)
    expect(r.ok).toBe(true)
    if (r.ok) {
      // 30 (dédupliqué avec la rafale) et 60.
      expect(r.plan.timecodes).toEqual([30, 60])
    }
  })

  it('applique les valeurs par défaut (mode seek, settle par défaut)', () => {
    const r = resolvePlan({ version: 1, items: [{ at: 1 }] })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.plan.mode).toBe('seek')
      expect(r.plan.settleMs).toBe(400)
      expect(r.plan.name).toBe('plan-sans-nom')
    }
  })

  it('rejette une version non prise en charge', () => {
    const r = resolvePlan({ version: 2, items: [{ at: 1 }] })
    expect(r.ok).toBe(false)
  })

  it('rejette un plan vide', () => {
    expect(resolvePlan({ version: 1, items: [] }).ok).toBe(false)
  })

  it('rejette un item mal formé (ni at ni rafale complète)', () => {
    expect(resolvePlan({ version: 1, items: [{ foo: 'bar' }] }).ok).toBe(false)
    expect(resolvePlan({ version: 1, items: [{ from: '00:00:01', count: 0, everySeconds: 5 }] }).ok).toBe(
      false,
    )
    expect(
      resolvePlan({ version: 1, items: [{ from: '00:00:01', count: 3, everySeconds: 0 }] }).ok,
    ).toBe(false)
  })

  it(`borne le plan à ${MAX_PLAN_CAPTURES} captures`, () => {
    const r = resolvePlan({
      version: 1,
      items: [{ from: 0, count: MAX_PLAN_CAPTURES + 1, everySeconds: 1 }],
    })
    expect(r.ok).toBe(false)
  })

  it(`accepte exactement ${MAX_PLAN_CAPTURES} captures`, () => {
    const r = resolvePlan({
      version: 1,
      items: [{ from: 0, count: MAX_PLAN_CAPTURES, everySeconds: 1 }],
    })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.plan.timecodes).toHaveLength(MAX_PLAN_CAPTURES)
  })

  it('rejette un timecode au-delà de la durée connue', () => {
    const r = resolvePlan({ version: 1, items: [{ at: 5000 }] }, 120)
    expect(r.ok).toBe(false)
  })

  it('tolère une légère imprécision de durée (0,5 s)', () => {
    const r = resolvePlan({ version: 1, items: [{ at: 120.4 }] }, 120)
    expect(r.ok).toBe(true)
  })

  it('rejette settleMs hors bornes', () => {
    expect(resolvePlan({ version: 1, settleMs: 99999, items: [{ at: 1 }] }).ok).toBe(false)
    expect(resolvePlan({ version: 1, settleMs: -1, items: [{ at: 1 }] }).ok).toBe(false)
  })

  it('rejette un mode inconnu', () => {
    expect(resolvePlan({ version: 1, mode: 'turbo', items: [{ at: 1 }] }).ok).toBe(false)
  })
})

describe('planner — parseAndResolvePlan (JSON)', () => {
  it('distingue une erreur de syntaxe JSON d’une erreur de validation', () => {
    const bad = parseAndResolvePlan('{ not json')
    expect(bad.ok).toBe(false)
    if (!bad.ok) expect(bad.message).toMatch(/JSON invalide/i)
  })

  it('résout un JSON valide', () => {
    const r = parseAndResolvePlan(JSON.stringify({ version: 1, items: [{ at: '00:00:30' }] }))
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.plan.timecodes).toEqual([30])
  })
})
