import { describe, it, expect } from 'vitest'
import {
  VisualProbeQueue,
  type ProbeOutcome,
  type ProbeQueueDeps,
  type ClaimedProbeJob,
} from '../src/background/visualProbeQueue'
import type { VisualProbeRequest } from '../src/lib/probe'

interface Rec {
  status: string
  patches: Partial<VisualProbeRequest>[]
}

function createHarness(
  probeFn: (id: string) => Promise<ProbeOutcome> | ProbeOutcome,
  opts: { unavailable?: Set<string>; exists?: Set<string> } = {},
) {
  const records = new Map<string, Rec>()
  const rec = (id: string): Rec => {
    let r = records.get(id)
    if (!r) {
      r = { status: 'captured', patches: [] }
      records.set(id, r)
    }
    return r
  }

  let epoch = 0
  let activeNow = 0
  let activeMax = 0
  const probeCalls = new Map<string, number>()

  const deps: ProbeQueueDeps = {
    async claim(id) {
      if (opts.exists && !opts.exists.has(id)) return null
      const r = rec(id)
      if (r.status === 'analyzing') return null
      r.status = 'analyzing'
      const job: ClaimedProbeJob = {
        snapshotId: 1,
        mediaTime: 10,
        mimeType: 'image/webp',
        imageBase64: 'x',
        purpose: 'open_observation',
        question: 'Que voit-on ?',
      }
      if (opts.unavailable?.has(id)) {
        job.imageBase64 = ''
        job.unavailable = { cause: 'image_empty', message: 'Image vide.' }
      }
      return job
    },
    async probe(req) {
      probeCalls.set(req.probeId, (probeCalls.get(req.probeId) ?? 0) + 1)
      activeNow += 1
      activeMax = Math.max(activeMax, activeNow)
      try {
        return await probeFn(req.probeId)
      } finally {
        activeNow -= 1
      }
    },
    async save(id, patch) {
      const r = rec(id)
      r.patches.push(patch)
      if (patch.status) r.status = patch.status
    },
    sleep: async () => {},
    now: () => 0,
    epoch: () => epoch,
    random: () => 0,
  }

  const queue = new VisualProbeQueue(deps, { maxAttempts: 3, baseBackoffMs: 1, maxBackoffMs: 4 })
  return {
    queue,
    records,
    probeCalls,
    getActiveMax: () => activeMax,
    bumpEpoch: () => {
      epoch += 1
    },
  }
}

const ok = (answer = 'Une voiture rouge.'): ProbeOutcome => ({
  ok: true,
  answer,
  observations: ['plaque non lisible'],
  confidence: 0.7,
  limitations: [],
})
const transient = (): ProbeOutcome => ({ ok: false, code: 'RATE_LIMITED', message: 'x', retryable: true })
const permanent = (): ProbeOutcome => ({ ok: false, code: 'INVALID_REQUEST', message: 'x', retryable: false })

const tick = () => new Promise((r) => setTimeout(r, 0))

describe('VisualProbeQueue', () => {
  it('1. une réponse structurée réussie met à jour la bonne sonde', async () => {
    const h = createHarness(() => ok('Une voiture rouge garée devant un immeuble.'))
    h.queue.enqueue('p1')
    await h.queue.whenIdle()
    const last = h.records.get('p1')!.patches.at(-1)!
    expect(last.status).toBe('succeeded')
    expect(last.answer).toContain('voiture rouge')
    expect(last.confidence).toBe(0.7)
  })

  it('2. la concurrence ne dépasse jamais un appel', async () => {
    const h = createHarness(async () => {
      await tick()
      return ok()
    })
    for (const id of ['a', 'b', 'c']) h.queue.enqueue(id)
    await h.queue.whenIdle()
    expect(h.getActiveMax()).toBe(1)
  })

  it('3. une erreur transitoire est retentée dans la limite fixée', async () => {
    let n = 0
    const h = createHarness(() => {
      n += 1
      return n < 3 ? transient() : ok()
    })
    h.queue.enqueue('p1')
    await h.queue.whenIdle()
    expect(h.probeCalls.get('p1')).toBe(3)
    expect(h.records.get('p1')!.status).toBe('succeeded')
  })

  it('4. une erreur permanente n’est jamais retentée', async () => {
    const h = createHarness(() => permanent())
    h.queue.enqueue('p1')
    await h.queue.whenIdle()
    expect(h.probeCalls.get('p1')).toBe(1)
    expect(h.records.get('p1')!.status).toBe('failed')
  })

  it('5. une erreur sur une sonde n’empêche pas le traitement des suivantes', async () => {
    const h = createHarness((id) => (id === 'bad' ? permanent() : ok()))
    h.queue.enqueue('bad')
    h.queue.enqueue('good')
    await h.queue.whenIdle()
    expect(h.records.get('bad')!.status).toBe('failed')
    expect(h.records.get('good')!.status).toBe('succeeded')
  })

  it('6. une image non exploitable n’est JAMAIS envoyée à Gemini (statut unavailable, aucun appel)', async () => {
    const h = createHarness(() => ok(), { unavailable: new Set(['p1']) })
    h.queue.enqueue('p1')
    await h.queue.whenIdle()
    expect(h.probeCalls.get('p1')).toBeUndefined()
    expect(h.records.get('p1')!.status).toBe('unavailable')
  })

  it('7. une sonde absente (déjà supprimée/prise) n’est pas analysée', async () => {
    const h = createHarness(() => ok(), { exists: new Set<string>() })
    h.queue.enqueue('ghost')
    await h.queue.whenIdle()
    expect(h.probeCalls.get('ghost')).toBeUndefined()
    expect(h.records.get('ghost')?.patches.length ?? 0).toBe(0)
  })

  it('8. une réponse tardive après suppression (changement d’epoch) ne ressuscite rien', async () => {
    let resolveProbe!: (o: ProbeOutcome) => void
    const pending = new Promise<ProbeOutcome>((res) => {
      resolveProbe = res
    })
    const h = createHarness(() => pending)
    h.queue.enqueue('p1')
    await tick()
    h.bumpEpoch()
    h.queue.clear()
    resolveProbe(ok())
    await h.queue.whenIdle()
    // Seule la mise à 'analyzing' (via claim) a été enregistrée côté state,
    // mais AUCUN patch de résultat n'a été sauvegardé après le changement d'epoch.
    expect(h.records.get('p1')!.patches.length).toBe(0)
  })
})
