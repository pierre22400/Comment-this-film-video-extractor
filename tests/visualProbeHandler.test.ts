import { describe, it, expect } from 'vitest'
import { handleVisualProbe, type ProbeRelayRequest } from '../server/visualProbeHandler'
import { type GeminiClient, GeminiApiError, type GeminiProbeRawOutput } from '../server/geminiClient'
import type { ProbeSuccessBody, ProbeErrorBody } from '../src/lib/probe'

function fakeGemini(impl: () => Promise<GeminiProbeRawOutput> | GeminiProbeRawOutput): GeminiClient {
  return {
    model: 'fake-model',
    describe: async () => 'stub',
    probe: async () => impl(),
  }
}

const validBody = {
  probeId: 'p1',
  snapshotId: 27,
  mediaTime: 842.351,
  mimeType: 'image/webp',
  imageBase64: 'AAAABBBBCCCC',
  purpose: 'vehicle',
  question: 'Quelle est la couleur de la voiture visible à l’écran ?',
}

function post(body: unknown): ProbeRelayRequest {
  return { method: 'POST', contentType: 'application/json', body }
}

const asSuccess = (j: ProbeSuccessBody | ProbeErrorBody) => j as ProbeSuccessBody
const asError = (j: ProbeSuccessBody | ProbeErrorBody) => j as ProbeErrorBody

describe('handleVisualProbe', () => {
  it('1. réussit et renvoie une réponse structurée validée', async () => {
    const gemini = fakeGemini(() => ({
      answer: 'La voiture est rouge.',
      observations: ['plaque non lisible'],
      confidence: 0.75,
      limitations: [],
    }))
    const res = await handleVisualProbe(post(validBody), gemini)
    expect(res.status).toBe(200)
    const body = asSuccess(res.json)
    expect(body.probeId).toBe('p1')
    expect(body.snapshotId).toBe(27)
    expect(body.answer).toContain('rouge')
    expect(body.confidence).toBe(0.75)
    expect(body.model).toBe('fake-model')
  })

  it('2. l’image et la question sont bien celles transmises au client Gemini', async () => {
    let received: { imageBase64: string; question: string; purpose: string } | null = null
    const gemini: GeminiClient = {
      model: 'fake-model',
      describe: async () => 'stub',
      probe: async (input) => {
        received = { imageBase64: input.imageBase64, question: input.question, purpose: input.purpose }
        return { answer: 'x', confidence: 0.5 }
      },
    }
    await handleVisualProbe(post(validBody), gemini)
    expect(received?.imageBase64).toBe(validBody.imageBase64)
    expect(received?.question).toBe(validBody.question)
    expect(received?.purpose).toBe(validBody.purpose)
  })

  it('3. une image indisponible/vide est rejetée avant tout appel à Gemini (400)', async () => {
    let called = false
    const gemini = fakeGemini(() => {
      called = true
      return { answer: 'x', confidence: 0.5 }
    })
    const res = await handleVisualProbe(post({ ...validBody, imageBase64: '' }), gemini)
    expect(res.status).toBe(400)
    expect(called).toBe(false)
  })

  it('4. rejette un purpose invalide (400)', async () => {
    const gemini = fakeGemini(() => ({ answer: 'x', confidence: 0.5 }))
    const res = await handleVisualProbe(post({ ...validBody, purpose: 'spaceship' }), gemini)
    expect(res.status).toBe(400)
  })

  it('5. une réponse structurée invalide (answer vide) devient une erreur, jamais stockée comme succès', async () => {
    const gemini = fakeGemini(() => ({ answer: '   ', confidence: 0.5 }))
    const res = await handleVisualProbe(post(validBody), gemini)
    expect(res.status).toBe(502)
    expect(asError(res.json).error.code).toBe('INVALID_MODEL_RESPONSE')
    expect('answer' in res.json).toBe(false)
  })

  it('6. une réponse sans confidence numérique devient une erreur', async () => {
    const gemini = fakeGemini(() => ({ answer: 'x' }) as GeminiProbeRawOutput)
    const res = await handleVisualProbe(post(validBody), gemini)
    expect(res.status).toBe(502)
  })

  it('7. propage une erreur transitoire de Gemini (429 -> retryable)', async () => {
    const gemini: GeminiClient = {
      model: 'fake-model',
      describe: async () => 'stub',
      probe: async () => {
        throw new GeminiApiError(429, 'rate limited')
      },
    }
    const res = await handleVisualProbe(post(validBody), gemini)
    expect(res.status).toBe(429)
    expect(asError(res.json).error.retryable).toBe(true)
  })

  it('8. refuse une méthode non-POST (405)', async () => {
    const gemini = fakeGemini(() => ({ answer: 'x', confidence: 0.5 }))
    const res = await handleVisualProbe({ method: 'GET', contentType: 'application/json', body: validBody }, gemini)
    expect(res.status).toBe(405)
  })
})
