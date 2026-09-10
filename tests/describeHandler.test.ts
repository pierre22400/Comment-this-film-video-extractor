import { describe, it, expect } from 'vitest'
import { handleDescribe, type RelayRequest } from '../server/describeHandler'
import { type GeminiClient, GeminiApiError } from '../server/geminiClient'
import type { DescribeSuccessBody, DescribeErrorBody } from '../src/lib/analysis'

function fakeGemini(impl: (input: { snapshotId: number }) => Promise<string> | string): GeminiClient {
  return {
    model: 'fake-model',
    describe: async (input) => impl({ snapshotId: input.snapshotId }),
    // Non utilisé par ces tests (endpoint /api/describe uniquement) ; stub minimal.
    probe: async () => ({ answer: 'stub', observations: [], confidence: 0, limitations: [] }),
  }
}

const validBody = {
  snapshotId: 27,
  mediaTime: 842.351,
  mimeType: 'image/webp',
  imageBase64: 'AAAABBBBCCCC',
}

function post(body: unknown): RelayRequest {
  return { method: 'POST', contentType: 'application/json', body }
}

const asSuccess = (j: DescribeSuccessBody | DescribeErrorBody) => j as DescribeSuccessBody
const asError = (j: DescribeSuccessBody | DescribeErrorBody) => j as DescribeErrorBody

describe('handleDescribe', () => {
  it('réussit et renvoie une description structurée', async () => {
    const gemini = fakeGemini(() => 'Un homme se tient dans un salon, devant une table de billard.')
    const res = await handleDescribe(post(validBody), gemini)
    expect(res.status).toBe(200)
    const body = asSuccess(res.json)
    expect(body.snapshotId).toBe(27)
    expect(body.description).toContain('salon')
    expect(body.model).toBe('fake-model')
    expect(typeof body.latencyMs).toBe('number')
  })

  it('mesure la latence via l’horloge injectée', async () => {
    const gemini = fakeGemini(() => 'Une voiture rouge sur une route.')
    let t = 1000
    const now = () => (t += 250) // t0=1250, t1=1500 -> 250ms
    const res = await handleDescribe(post(validBody), gemini, now)
    expect(asSuccess(res.json).latencyMs).toBe(250)
  })

  it('refuse une méthode non-POST (405)', async () => {
    const gemini = fakeGemini(() => 'x')
    const res = await handleDescribe({ method: 'GET', contentType: 'application/json', body: validBody }, gemini)
    expect(res.status).toBe(405)
    expect(asError(res.json).error.retryable).toBe(false)
  })

  it('refuse un Content-Type non JSON (415)', async () => {
    const gemini = fakeGemini(() => 'x')
    const res = await handleDescribe({ method: 'POST', contentType: 'text/plain', body: validBody }, gemini)
    expect(res.status).toBe(415)
  })

  it('rejette une image manquante (400)', async () => {
    const gemini = fakeGemini(() => 'x')
    const res = await handleDescribe(post({ ...validBody, imageBase64: '' }), gemini)
    expect(res.status).toBe(400)
    expect(asError(res.json).error.code).toBe('INVALID_REQUEST')
  })

  it('rejette un type MIME non autorisé (400)', async () => {
    const gemini = fakeGemini(() => 'x')
    const res = await handleDescribe(post({ ...validBody, mimeType: 'image/gif' }), gemini)
    expect(res.status).toBe(400)
  })

  it('rejette un mediaTime négatif ou non fini (400)', async () => {
    const gemini = fakeGemini(() => 'x')
    const res1 = await handleDescribe(post({ ...validBody, mediaTime: -1 }), gemini)
    const res2 = await handleDescribe(post({ ...validBody, mediaTime: Number.POSITIVE_INFINITY }), gemini)
    expect(res1.status).toBe(400)
    expect(res2.status).toBe(400)
  })

  it('6. valide la réponse Gemini avant stockage (réponse vide => erreur, pas de description)', async () => {
    const gemini = fakeGemini(() => '   ') // vide après normalisation
    const res = await handleDescribe(post(validBody), gemini)
    expect(res.status).toBe(502)
    expect(asError(res.json).error.code).toBe('INVALID_MODEL_RESPONSE')
    expect(asError(res.json).error.retryable).toBe(false)
    expect('description' in res.json).toBe(false)
  })

  it('propage une erreur transitoire de Gemini (429 -> retryable)', async () => {
    const gemini = fakeGemini(() => {
      throw new GeminiApiError(429, 'rate limited')
    })
    const res = await handleDescribe(post(validBody), gemini)
    expect(res.status).toBe(429)
    expect(asError(res.json).error.code).toBe('RATE_LIMITED')
    expect(asError(res.json).error.retryable).toBe(true)
  })

  it('ne rend pas retryable une erreur permanente de Gemini (400)', async () => {
    const gemini = fakeGemini(() => {
      throw new GeminiApiError(400, 'bad request')
    })
    const res = await handleDescribe(post(validBody), gemini)
    expect(res.status).toBe(400)
    expect(asError(res.json).error.retryable).toBe(false)
  })
})
