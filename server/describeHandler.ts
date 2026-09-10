// Handler PUR de l'endpoint POST /api/describe : aucune dépendance à Node HTTP,
// afin d'être testable directement avec un faux client Gemini.

import {
  validateDescribeRequest,
  normalizeDescription,
  statusToErrorCode,
  isRetryableStatus,
  type DescribeSuccessBody,
  type DescribeErrorBody,
} from '../src/lib/analysis'
import { type GeminiClient, GeminiApiError } from './geminiClient'

export interface RelayRequest {
  method: string
  contentType?: string
  body: unknown
}

export interface RelayResult {
  status: number
  json: DescribeSuccessBody | DescribeErrorBody
}

function err(status: number, code: string, message: string, retryable: boolean): RelayResult {
  return { status, json: { error: { code, message, retryable } } }
}

/**
 * Traite une requête de description. Valide strictement l'entrée, appelle Gemini,
 * puis VALIDE la réponse du modèle avant de la renvoyer : une réponse vide ou mal
 * formée devient une erreur (jamais une description stockée).
 */
export async function handleDescribe(
  req: RelayRequest,
  gemini: GeminiClient,
  now: () => number = () => Date.now(),
): Promise<RelayResult> {
  if (req.method !== 'POST') {
    return err(405, 'METHOD_NOT_ALLOWED', 'Méthode non autorisée.', false)
  }
  if (!req.contentType || !req.contentType.includes('application/json')) {
    return err(415, 'UNSUPPORTED_MEDIA_TYPE', 'Content-Type application/json requis.', false)
  }

  const valid = validateDescribeRequest(req.body)
  if (!valid.ok) {
    return err(400, valid.code, valid.message, false)
  }

  const t0 = now()
  let raw: string
  try {
    raw = await gemini.describe({
      imageBase64: valid.value.imageBase64,
      mimeType: valid.value.mimeType,
      snapshotId: valid.value.snapshotId,
      mediaTime: valid.value.mediaTime,
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
    // Erreur réseau / inattendue : transitoire par défaut.
    return err(502, 'UPSTREAM_ERROR', 'Erreur de communication avec Gemini.', true)
  }

  const description = normalizeDescription(raw)
  if (description === null) {
    return err(502, 'INVALID_MODEL_RESPONSE', 'Réponse du modèle vide ou mal formée.', false)
  }

  const body: DescribeSuccessBody = {
    snapshotId: valid.value.snapshotId,
    description,
    model: gemini.model,
    latencyMs: Math.max(0, Math.round(now() - t0)),
  }
  return { status: 200, json: body }
}
