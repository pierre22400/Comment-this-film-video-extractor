// Handler PUR de l'endpoint POST /api/visual-probe : aucune dépendance à Node
// HTTP, afin d'être testable directement avec un faux client Gemini.
//
// Distinct de /api/describe (diagnostic manuel, description libre) : ce
// endpoint répond à une QUESTION ciblée avec une réponse STRUCTURÉE et validée
// (answer/observations/confidence/limitations), jamais stockée si invalide.

import {
  validateProbeRequest,
  validateProbeStructuredResponse,
  type ProbeSuccessBody,
  type ProbeErrorBody,
} from '../src/lib/probe'
import { statusToErrorCode, isRetryableStatus } from '../src/lib/analysis'
import { type GeminiClient, GeminiApiError } from './geminiClient'

export interface ProbeRelayRequest {
  method: string
  contentType?: string
  body: unknown
}

export interface ProbeRelayResult {
  status: number
  json: ProbeSuccessBody | ProbeErrorBody
}

function err(status: number, code: string, message: string, retryable: boolean): ProbeRelayResult {
  return { status, json: { error: { code, message, retryable } } }
}

/**
 * Traite une requête de sonde visuelle. Valide strictement l'entrée, appelle
 * Gemini, puis VALIDE la structure de sortie avant de la renvoyer : une
 * réponse vide, mal typée ou hors bornes devient une erreur (jamais stockée
 * comme un succès).
 */
export async function handleVisualProbe(
  req: ProbeRelayRequest,
  gemini: GeminiClient,
  now: () => number = () => Date.now(),
): Promise<ProbeRelayResult> {
  if (req.method !== 'POST') {
    return err(405, 'METHOD_NOT_ALLOWED', 'Méthode non autorisée.', false)
  }
  if (!req.contentType || !req.contentType.includes('application/json')) {
    return err(415, 'UNSUPPORTED_MEDIA_TYPE', 'Content-Type application/json requis.', false)
  }

  const valid = validateProbeRequest(req.body)
  if (!valid.ok) {
    return err(400, 'INVALID_REQUEST', valid.message, false)
  }

  const t0 = now()
  let raw: Awaited<ReturnType<GeminiClient['probe']>>
  try {
    raw = await gemini.probe({
      imageBase64: valid.value.imageBase64,
      mimeType: valid.value.mimeType,
      purpose: valid.value.purpose,
      question: valid.value.question,
    })
  } catch (e) {
    if (e instanceof GeminiApiError) {
      return err(
        e.status,
        statusToErrorCode(e.status),
        `Erreur Gemini (${e.status}).`,
        isRetryableStatus(e.status),
      )
    }
    return err(502, 'UPSTREAM_ERROR', 'Erreur de communication avec Gemini.', true)
  }

  const validated = validateProbeStructuredResponse(raw)
  if (!validated.ok) {
    return err(502, 'INVALID_MODEL_RESPONSE', validated.message, false)
  }

  const body: ProbeSuccessBody = {
    probeId: valid.value.probeId,
    snapshotId: valid.value.snapshotId,
    mediaTime: valid.value.mediaTime,
    purpose: valid.value.purpose,
    question: valid.value.question,
    answer: validated.value.answer,
    observations: validated.value.observations,
    confidence: validated.value.confidence,
    limitations: validated.value.limitations,
    model: gemini.model,
    latencyMs: Math.max(0, Math.round(now() - t0)),
  }
  return { status: 200, json: body }
}
