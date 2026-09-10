import { describe, it, expect } from 'vitest'
import { AnalysisQueue, type DescribeOutcome, type QueueDeps } from '../src/background/analysisQueue'
import type { AnalysisPatch } from '../src/lib/types'

interface Rec {
  state: string
  attempts: number
  saves: AnalysisPatch[]
}

/** Fabrique une file avec un store en mémoire et un `describe` contrôlé. */
function createHarness(
  describeFn: (id: number) => Promise<DescribeOutcome> | DescribeOutcome,
  opts: { exists?: Set<number> } = {},
) {
  const records = new Map<number, Rec>()
  const rec = (id: number): Rec => {
    let r = records.get(id)
    if (!r) {
      r = { state: 'queued', attempts: 0, saves: [] }
      records.set(id, r)
    }
    return r
  }

  let epoch = 0
  let activeNow = 0
  let activeMax = 0
  const describeCalls = new Map<number, number>()

  const deps: QueueDeps = {
    async claim(id) {
      if (opts.exists && !opts.exists.has(id)) return null
      const r = rec(id)
      if (r.state === 'analyzing') return null
      r.state = 'analyzing'
      return { mediaTime: 0, mimeType: 'image/webp', imageBase64: 'x', attempts: r.attempts }
    },
    async describe(req) {
      describeCalls.set(req.snapshotId, (describeCalls.get(req.snapshotId) ?? 0) + 1)
      activeNow += 1
      activeMax = Math.max(activeMax, activeNow)
      try {
        return await describeFn(req.snapshotId)
      } finally {
        activeNow -= 1
      }
    },
    async save(id, patch) {
      const r = rec(id)
      r.saves.push(patch)
      if (patch.analysisState) r.state = patch.analysisState
      if (patch.analysisAttempts != null) r.attempts = patch.analysisAttempts
    },
    sleep: async () => {},
    now: () => 0,
    epoch: () => epoch,
    random: () => 0,
  }

  const queue = new AnalysisQueue(deps, { maxAttempts: 3, baseBackoffMs: 1, maxBackoffMs: 4 })
  return {
    queue,
    records,
    describeCalls,
    getActiveMax: () => activeMax,
    bumpEpoch: () => {
      epoch += 1
    },
  }
}

const ok = (description = 'Une scène.'): DescribeOutcome => ({
  ok: true,
  description,
  model: 'fake-model',
  latencyMs: 5,
})
const transient = (): DescribeOutcome => ({ ok: false, code: 'RATE_LIMITED', message: 'x', retryable: true })
const permanent = (): DescribeOutcome => ({ ok: false, code: 'INVALID_REQUEST', message: 'x', retryable: false })

const tick = () => new Promise((r) => setTimeout(r, 0))

describe('AnalysisQueue', () => {
  it('1. une analyse réussie met à jour le bon snapshot', async () => {
    const h = createHarness(() => ok('Un homme dans un salon.'))
    h.queue.enqueue(42)
    await h.queue.whenIdle()
    const r = h.records.get(42)!
    const last = r.saves.at(-1)!
    expect(last.analysisState).toBe('succeeded')
    expect(last.description).toBe('Un homme dans un salon.')
    expect(last.analysisModel).toBe('fake-model')
  })

  it('2. la concurrence ne dépasse jamais un appel', async () => {
    // describe attend un tick pour laisser le temps à un éventuel chevauchement.
    const h = createHarness(async () => {
      await tick()
      return ok()
    })
    h.queue.enqueueMany([1, 2, 3, 4, 5])
    await h.queue.whenIdle()
    expect(h.getActiveMax()).toBe(1)
  })

  it('3. les erreurs transitoires sont retentées dans la limite fixée', async () => {
    let n = 0
    const h = createHarness(() => {
      n += 1
      return n < 3 ? transient() : ok()
    })
    h.queue.enqueue(7)
    await h.queue.whenIdle()
    expect(h.describeCalls.get(7)).toBe(3) // 1 initiale + 2 retries
    expect(h.records.get(7)!.state).toBe('succeeded')
  })

  it('4. les erreurs permanentes ne sont pas retentées', async () => {
    const h = createHarness(() => permanent())
    h.queue.enqueue(8)
    await h.queue.whenIdle()
    expect(h.describeCalls.get(8)).toBe(1)
    expect(h.records.get(8)!.state).toBe('failed')
  })

  it('5. un échec n’empêche pas le traitement du snapshot suivant', async () => {
    const h = createHarness((id) => (id === 1 ? permanent() : ok()))
    h.queue.enqueueMany([1, 2])
    await h.queue.whenIdle()
    expect(h.records.get(1)!.state).toBe('failed')
    expect(h.records.get(2)!.state).toBe('succeeded')
  })

  it('7. deux travaux ne peuvent pas analyser deux fois le même snapshot', async () => {
    // Un doublon est ré-enfilé pendant que le snapshot est actif : il est ignoré.
    const h = createHarness((id) => {
      h.queue.enqueue(id) // tentative de doublon concurrent
      return ok()
    })
    h.queue.enqueue(5)
    await h.queue.whenIdle()
    expect(h.describeCalls.get(5)).toBe(1)
  })

  it('7b. un snapshot absent (déjà effacé/pris) n’est pas analysé', async () => {
    const h = createHarness(() => ok(), { exists: new Set<number>() })
    h.queue.enqueue(99)
    await h.queue.whenIdle()
    expect(h.describeCalls.get(99)).toBeUndefined()
    expect(h.records.get(99)?.saves.length ?? 0).toBe(0)
  })

  it('8. l’effacement ignore toute réponse tardive', async () => {
    let resolveDescribe!: (o: DescribeOutcome) => void
    const pending = new Promise<DescribeOutcome>((res) => {
      resolveDescribe = res
    })
    const h = createHarness(() => pending)
    h.queue.enqueue(3)
    await tick() // describe est lancé, en attente
    // Effacement pendant l'appel : on invalide et on vide la file.
    h.bumpEpoch()
    h.queue.clear()
    resolveDescribe(ok()) // réponse tardive
    await h.queue.whenIdle()
    // Aucun résultat persisté : le snapshot effacé n'est pas ressuscité.
    expect(h.records.get(3)!.saves.length).toBe(0)
  })
})
