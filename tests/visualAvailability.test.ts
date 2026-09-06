import { describe, it, expect } from 'vitest'
import {
  AnalysisQueue,
  type ClaimedJob,
  type DescribeOutcome,
  type QueueDeps,
} from '../src/background/analysisQueue'
import type { AnalysisPatch } from '../src/lib/types'
import {
  classifyCaptureError,
  buildVisualIncident,
  isAnalyzable,
  isSuspectFrame,
  newSessionGate,
  registerCaptureOutcome,
  visualCauseMessage,
} from '../src/lib/visual'

interface Rec {
  state: string
  attempts: number
  saves: AnalysisPatch[]
}

/**
 * File avec store en mémoire. `claimImpl` permet de simuler un snapshot dont
 * l'image est exploitable ou non (drapeau unanalyzable / image vide).
 */
function createHarness(
  claimImpl: (id: number, attempts: number) => ClaimedJob | null,
  describeFn: (id: number) => Promise<DescribeOutcome> | DescribeOutcome,
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

  const describeCalls = new Map<number, number>()

  const deps: QueueDeps = {
    async claim(id) {
      const r = rec(id)
      if (r.state === 'analyzing') return null
      r.state = 'analyzing'
      return claimImpl(id, r.attempts)
    },
    async describe(req) {
      describeCalls.set(req.snapshotId, (describeCalls.get(req.snapshotId) ?? 0) + 1)
      return describeFn(req.snapshotId)
    },
    async save(id, patch) {
      const r = rec(id)
      r.saves.push(patch)
      if (patch.analysisState) r.state = patch.analysisState
      if (patch.analysisAttempts != null) r.attempts = patch.analysisAttempts
    },
    sleep: async () => {},
    now: () => 0,
    epoch: () => 0,
    random: () => 0,
  }

  const queue = new AnalysisQueue(deps, { maxAttempts: 3, baseBackoffMs: 1, maxBackoffMs: 4 })
  return { queue, records, describeCalls }
}

const okOutcome = (): DescribeOutcome => ({
  ok: true,
  description: 'Une scène visible.',
  model: 'fake-model',
  latencyMs: 4,
})

const validJob = (attempts: number): ClaimedJob => ({
  mediaTime: 12.5,
  mimeType: 'image/webp',
  imageBase64: 'AAAABBBB',
  attempts,
})

const suspectJob = (attempts: number): ClaimedJob => ({
  mediaTime: 12.5,
  mimeType: 'image/webp',
  imageBase64: '',
  attempts,
  unanalyzable: {
    availability: 'suspected_invalid',
    cause: 'suspected_blank_frame',
    message: visualCauseMessage('suspected_blank_frame'),
  },
})

describe('Amendement — disponibilité visuelle', () => {
  it('1. aucune requête Gemini pour une image non exploitable', async () => {
    const h = createHarness(
      (_id, attempts) => suspectJob(attempts),
      () => okOutcome(),
    )
    h.queue.enqueue(1)
    await h.queue.whenIdle()
    // Gemini n'est jamais appelé...
    expect(h.describeCalls.get(1)).toBeUndefined()
    // ...et l'état devient 'not_applicable' avec la cause conservée.
    const last = h.records.get(1)!.saves.at(-1)!
    expect(last.analysisState).toBe('not_applicable')
    expect(last.visualCause).toBe('suspected_blank_frame')
  })

  it('1b. une image vide (base64 vide) n’est jamais envoyée à Gemini', async () => {
    const h = createHarness(
      (_id, attempts) => ({ mediaTime: 0, mimeType: 'image/webp', imageBase64: '', attempts }),
      () => okOutcome(),
    )
    h.queue.enqueue(2)
    await h.queue.whenIdle()
    expect(h.describeCalls.get(2)).toBeUndefined()
    const last = h.records.get(2)!.saves.at(-1)!
    expect(last.analysisState).toBe('not_applicable')
    expect(last.visualCause).toBe('image_empty')
  })

  it('2. un snapshot not_applicable n’est jamais retenté et ne consomme aucune tentative', async () => {
    const h = createHarness(
      (_id, attempts) => suspectJob(attempts),
      () => okOutcome(),
    )
    h.queue.enqueue(3)
    await h.queue.whenIdle()
    // Nouvelle tentative de mise en file : toujours aucun appel Gemini.
    h.queue.enqueue(3)
    await h.queue.whenIdle()
    expect(h.describeCalls.get(3)).toBeUndefined()
    const r = h.records.get(3)!
    expect(r.attempts).toBe(0) // aucune tentative Gemini consommée
    expect(r.saves.every((s) => s.analysisState === 'not_applicable')).toBe(true)
  })

  it('3. une restriction Canvas produit un état structuré et prudent', () => {
    const { availability, cause } = classifyCaptureError('CANVAS_SECURITY_ERROR')
    expect(availability).toBe('blocked')
    expect(cause).toBe('canvas_security')

    const incident = buildVisualIncident({
      availability,
      cause,
      code: 'CANVAS_SECURITY_ERROR',
      mediaTime: 842.351,
      at: '2026-09-06T16:30:00.000Z',
    })
    expect(incident.mediaTime).toBe(842.351)
    expect(incident.at).toBe('2026-09-06T16:30:00.000Z')
    expect(incident.code).toBe('CANVAS_SECURITY_ERROR')
    expect(incident.message.length).toBeGreaterThan(0)
    // Formulation prudente : jamais d'accusation de DRM.
    expect(incident.message.toLowerCase()).not.toContain('drm')
    expect(incident.message).toContain('bloquée ou inaccessible')
    // Une image bloquée n'est pas analysable.
    expect(isAnalyzable(availability)).toBe(false)
  })

  it('4. une image suspecte n’arrête pas les captures suivantes', () => {
    const gate = newSessionGate()
    // Une frame suspecte, puis des captures exploitables : aucun arrêt.
    expect(registerCaptureOutcome(gate, 'suspect').abort).toBe(false)
    expect(registerCaptureOutcome(gate, 'ok').abort).toBe(false)
    expect(registerCaptureOutcome(gate, 'suspect').abort).toBe(false)
    expect(registerCaptureOutcome(gate, 'ok').abort).toBe(false)
    expect(gate.consecutiveBlocked).toBe(0)
  })

  it('5. une frame sombre isolée ne condamne pas toute la session', () => {
    // Frame presque noire => suspecte...
    expect(isSuspectFrame({ meanLuma: 2, variance: 0.4 })).toBe(true)
    // ...mais une seule observation suspecte n'aborte jamais la session.
    const gate = newSessionGate()
    const res = registerCaptureOutcome(gate, 'suspect')
    expect(res.abort).toBe(false)
    expect(gate.consecutiveBlocked).toBe(0)
    // Une frame normale n'est pas jugée suspecte.
    expect(isSuspectFrame({ meanLuma: 120, variance: 900 })).toBe(false)
  })

  it('5b. seuls des blocages CONSÉCUTIFS finissent par suspendre la session', () => {
    const gate = newSessionGate()
    expect(registerCaptureOutcome(gate, 'blocked').abort).toBe(false) // 1
    expect(registerCaptureOutcome(gate, 'blocked').abort).toBe(false) // 2
    expect(registerCaptureOutcome(gate, 'blocked').abort).toBe(true) // 3 => suspension
  })

  it('6. le chemin Gemini existant fonctionne toujours avec une image valide', async () => {
    const h = createHarness(
      (_id, attempts) => validJob(attempts),
      () => okOutcome(),
    )
    h.queue.enqueue(7)
    await h.queue.whenIdle()
    expect(h.describeCalls.get(7)).toBe(1)
    const last = h.records.get(7)!.saves.at(-1)!
    expect(last.analysisState).toBe('succeeded')
    expect(last.description).toBe('Une scène visible.')
  })
})
