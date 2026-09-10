// Types et logique d'analyse Gemini PARTAGÉS entre l'extension, le relais serveur
// et les tests. Ce module est volontairement pur (aucune API chrome/DOM/Node) afin
// de pouvoir être importé partout et testé sans environnement particulier.

/** État explicite du cycle d'analyse d'un snapshot. */
export type AnalysisState =
  | 'not_requested'
  | 'queued'
  | 'analyzing'
  | 'succeeded'
  | 'failed'
  // Amendement : image absente/vide/indécodable/bloquée/suspecte. Jamais envoyée
  // à Gemini, jamais retentée. Ce n'est PAS un échec de Gemini.
  | 'not_applicable'

/** Corps de requête minimal envoyé au relais serveur puis à Gemini. */
export interface DescribeRequestBody {
  snapshotId: number
  mediaTime: number
  mimeType: string
  imageBase64: string
}

/** Réponse de succès du relais. */
export interface DescribeSuccessBody {
  snapshotId: number
  description: string
  model: string
  latencyMs: number
}

/** Réponse d'erreur normalisée du relais. */
export interface DescribeErrorBody {
  error: {
    code: string
    message: string
    retryable: boolean
  }
}

// Formats d'image acceptés par le relais (capture WebP au Cycle 1 ; PNG/JPEG tolérés).
export const ALLOWED_MIME_TYPES = ['image/webp', 'image/png', 'image/jpeg'] as const

// Taille maximale de l'image encodée en base64 (~8 Mo de base64 ≈ 6 Mo binaire).
export const MAX_IMAGE_BASE64_LENGTH = 8 * 1024 * 1024

// Taille maximale raisonnable du corps JSON de la requête.
export const MAX_REQUEST_BODY_LENGTH = 12 * 1024 * 1024

/**
 * Un statut HTTP est-il transitoire (donc susceptible d'être retenté) ?
 * Seuls 408, 429 et 5xx le sont. 400/401/403 ne le sont jamais.
 */
export function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || (status >= 500 && status <= 599)
}

/** Associe un code lisible à un statut HTTP d'erreur. */
export function statusToErrorCode(status: number): string {
  switch (status) {
    case 400:
      return 'INVALID_REQUEST'
    case 401:
      return 'UNAUTHORIZED'
    case 403:
      return 'FORBIDDEN'
    case 408:
      return 'TIMEOUT'
    case 429:
      return 'RATE_LIMITED'
    default:
      return status >= 500 ? 'UPSTREAM_ERROR' : 'ERROR'
  }
}

/** Messages FR par code d'erreur d'analyse (repli générique sinon). */
export const ANALYSIS_ERROR_MESSAGES: Record<string, string> = {
  INVALID_REQUEST: 'Requête invalide.',
  UNAUTHORIZED: "Clé d'API invalide ou manquante côté serveur.",
  FORBIDDEN: 'Accès refusé par l\u2019API.',
  TIMEOUT: 'Délai dépassé.',
  RATE_LIMITED: 'Limite temporaire de l\u2019API atteinte.',
  UPSTREAM_ERROR: 'Erreur temporaire du service Gemini.',
  NETWORK: 'Relais local injoignable (le serveur est-il démarré ?).',
  INVALID_MODEL_RESPONSE: 'Réponse du modèle vide ou mal formée.',
  SERVER_NOT_CONFIGURED: 'Clé Gemini absente côté serveur.',
  ERROR: 'Erreur inconnue.',
}

export function analysisErrorMessage(code: string): string {
  return ANALYSIS_ERROR_MESSAGES[code] ?? ANALYSIS_ERROR_MESSAGES.ERROR
}

export type ValidationResult =
  | { ok: true; value: DescribeRequestBody }
  | { ok: false; code: string; message: string }

/**
 * Valide STRICTEMENT le corps d'une requête /api/describe.
 * Utilisé côté serveur avant tout appel à Gemini.
 */
export function validateDescribeRequest(body: unknown): ValidationResult {
  if (typeof body !== 'object' || body === null) {
    return { ok: false, code: 'INVALID_REQUEST', message: 'Corps JSON attendu.' }
  }
  const b = body as Record<string, unknown>

  if (typeof b.snapshotId !== 'number' || !Number.isInteger(b.snapshotId) || b.snapshotId < 0) {
    return { ok: false, code: 'INVALID_REQUEST', message: 'snapshotId invalide.' }
  }
  if (typeof b.mediaTime !== 'number' || !Number.isFinite(b.mediaTime) || b.mediaTime < 0) {
    return { ok: false, code: 'INVALID_REQUEST', message: 'mediaTime invalide.' }
  }
  if (typeof b.mimeType !== 'string' || !ALLOWED_MIME_TYPES.includes(b.mimeType as (typeof ALLOWED_MIME_TYPES)[number])) {
    return { ok: false, code: 'INVALID_REQUEST', message: 'Type MIME non autorisé.' }
  }
  if (typeof b.imageBase64 !== 'string' || b.imageBase64.length === 0) {
    return { ok: false, code: 'INVALID_REQUEST', message: 'Image manquante.' }
  }
  if (b.imageBase64.length > MAX_IMAGE_BASE64_LENGTH) {
    return { ok: false, code: 'INVALID_REQUEST', message: 'Image trop volumineuse.' }
  }

  return {
    ok: true,
    value: {
      snapshotId: b.snapshotId,
      mediaTime: b.mediaTime,
      mimeType: b.mimeType,
      imageBase64: b.imageBase64,
    },
  }
}

/**
 * Normalise et valide une description produite par le modèle.
 * Renvoie la description nettoyée, ou null si elle est vide/mal formée.
 * Ne fait jamais confiance à une chaîne vide, trop courte ou non textuelle.
 */
export function normalizeDescription(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const text = raw.replace(/\s+/g, ' ').trim()
  if (text.length < 3) return null
  // Borne haute défensive : une description reste une ou deux phrases courtes.
  return text.length > 600 ? text.slice(0, 600).trim() : text
}
