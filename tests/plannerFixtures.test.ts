import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { parseAndResolvePlan } from '../src/lib/planner'

function readFixture(name: string): string {
  const url = new URL(`../fixtures/planners/${name}`, import.meta.url)
  return readFileSync(fileURLToPath(url), 'utf8')
}

describe('fixtures de planner', () => {
  it('youtube-smoke.json est valide et développe un plan cohérent', () => {
    const r = parseAndResolvePlan(readFixture('youtube-smoke.json'))
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.plan.name).toBe('youtube-smoke')
      // 3 items ponctuels (5, 15, 30) + rafale de 5 à partir de 60 par pas de 10.
      expect(r.plan.timecodes).toEqual([5, 15, 30, 60, 70, 80, 90, 100])
    }
  })

  it('scanner-stress-300.json développe exactement 300 captures, de façon reproductible', () => {
    const text = readFixture('scanner-stress-300.json')
    const a = parseAndResolvePlan(text)
    const b = parseAndResolvePlan(text)
    expect(a.ok).toBe(true)
    if (a.ok && b.ok) {
      expect(a.plan.timecodes).toHaveLength(300)
      expect(a.plan.timecodes).toEqual(b.plan.timecodes)
      expect(a.plan.timecodes[0]).toBe(2)
      expect(a.plan.timecodes[299]).toBe(2 + 299 * 5)
    }
  })
})
