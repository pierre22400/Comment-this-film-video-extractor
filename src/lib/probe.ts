// Contrat de la SONDE VISUELLE ciblée et programmable — module PUR (aucune
// dépendance chrome/DOM/Node), partagé par le content script, le service
// worker, le relais serveur et les tests.
//
// Une sonde visuelle est une DEMANDE explicite de l'utilisateur : « regarde
// entre t1 et t2, dans le but X, et réponds à cette question précise ». Ce
// n'est JAMAIS un déclenchement automatique lié à la capture périodique.

/** Intention déclarée d'une sonde : cadre ce que Gemini est autorisé à chercher. */
export type ProbePurpose =
  | 'actor'
  | 'vehicle'
  | 'location'
  | 'prop'
  | 'costume'
  | 'visual_confirmation'
  | 'open_observation'

export const PROBE_PURPOSES: readonly ProbePurpose[] = [
  'actor',
  'vehicle',
  'location',
  'prop',
  'costume',
  'visual_confirmation',
  'open_observation',
]

/**
 * Statut explicite du cycle de vie complet d'une sonde :
 * - scheduled  : créée, en attente que la vidéo atteigne la fenêtre.
 * - waiting    : la fenêtre [startTime, endTime] est atteinte, capture en préparation.
 * - capturing  : tentative de capture en cours.
 * - captured   : une image exploitable a été capturée (avant analyse).
 * - analyzing  : image envoyée au relais /api/visual-probe.
 * - succeeded  : réponse structurée reçue et validée.
 * - missed     : fenêtre dépassée sans capture exploitable (jamais retentée).
 * - unavailable: capture(s) tentée(s) mais image jamais exploitable (jamais envoyée à Gemini).
 * - failed     : erreur du relais/Gemini après capture réussie.
 * - cancelled  : annulée explicitement par l'utilisateur.
 */
export type ProbeStatus =
  | 'scheduled'
  | 'waiting'
  | 'capturing'
  | 'captured'
  | 'analyzing'
  | 'succeeded'
  | 'missed'
  | 'unavailable'
  | 'failed'
  | 'cancelled'

export const TERMINAL_PROBE_STATUSES: readonly ProbeStatus[] = [
  'succeeded',
  'missed',
  'unavailable',
  'failed',
  'cancelled',
]

export function isTerminalProbeStatus(status: ProbeStatus): boolean {
  return TERMINAL_PROBE_STATUSES.includes(status)
}

/** Origine d'un snapshot : périodique (Cycle 1), sonde visuelle, ou manuel (diagnostic). */
export type CaptureOrigin = 'periodic' | 'visual_probe' | 'manual' | 'planned'

export const MIN_PROBE_WINDOW_SECONDS = 0.5
export const MAX_PROBE_WINDOW_SECONDS = 120
export const MIN_PROBE_QUESTION_LENGTH = 3
export const MAX_PROBE_QUESTION_LENGTH = 300
export const DEFAULT_MAX_CAPTURES = 1
export const MAX_MAX_CAPTURES = 3

/** Une sonde visuelle, telle que persistée par le service worker. */
export interface VisualProbeRequest {
  id: string
  startTime: number
  endTime: number
  preferredTime: number | null
  purpose: ProbePurpose
  question: string
  maxCaptures: number
  status: ProbeStatus
  createdAt: string
  updatedAt?: string

  // Résultat de la phase de capture.
  snapshotId?: number
  actualCaptureTime?: number
  captureAttempts?: number

  // Résultat de la phase d'analyse (réponse structurée Gemini).
  answer?: string
  observations?: string[]
  confidence?: number
  limitations?: string[]

  // Diagnostic en cas d'échec/indisponibilité (jamais une accusation de DRM).
  failureReason?: string
  visualCause?: string
}

export type ValidationResult<T> = { ok: true; value: T } | { ok: false; message: string }

/** Valide les paramètres de CRÉATION d'une sonde (avant persistance). */
export function validateProbeDefinition(input: {
  startTime: unknown
  endTime: unknown
  preferredTime?: unknown
  purpose: unknown
  question: unknown
  maxCaptures?: unknown
}): ValidationResult<{
  startTime: number
  endTime: number
  preferredTime: number | null
  purpose: ProbePurpose
  question: string
  maxCaptures: number
}> {
  const { startTime, endTime, preferredTime, purpose, question, maxCaptures } = input

  if (typeof startTime !== 'number' || !Number.isFinite(startTime) || startTime < 0) {
    return { ok: false, message: 'startTime invalide.' }
  }
  if (typeof endTime !== 'number' || !Number.isFinite(endTime) || endTime <= startTime) {
    return { ok: false, message: 'endTime doit être supérieur à startTime.' }
  }
  const windowLength = endTime - startTime
  if (windowLength < MIN_PROBE_WINDOW_SECONDS || windowLength > MAX_PROBE_WINDOW_SECONDS) {
    return {
      ok: false,
      message: `La fenêtre doit durer entre ${MIN_PROBE_WINDOW_SECONDS}s et ${MAX_PROBE_WINDOW_SECONDS}s.`,
    }
  }
  let pref: number | null = null
  if (preferredTime !== undefined && preferredTime !== null) {
    if (typeof preferredTime !== 'number' || !Number.isFinite(preferredTime)) {
      return { ok: false, message: 'preferredTime invalide.' }
    }
    if (preferredTime < startTime || preferredTime > endTime) {
      return { ok: false, message: 'preferredTime doit être dans la fenêtre.' }
    }
    pref = preferredTime
  }
  if (typeof purpose !== 'string' || !PROBE_PURPOSES.includes(purpose as ProbePurpose)) {
    return { ok: false, message: 'purpose invalide.' }
  }
  if (typeof question !== 'string') {
    return { ok: false, message: 'question invalide.' }
  }
  const q = question.replace(/\s+/g, ' ').trim()
  if (q.length < MIN_PROBE_QUESTION_LENGTH || q.length > MAX_PROBE_QUESTION_LENGTH) {
    return {
      ok: false,
      message: `question doit contenir entre ${MIN_PROBE_QUESTION_LENGTH} et ${MAX_PROBE_QUESTION_LENGTH} caractères.`,
    }
  }
  let mc = DEFAULT_MAX_CAPTURES
  if (maxCaptures !== undefined) {
    if (
      typeof maxCaptures !== 'number' ||
      !Number.isInteger(maxCaptures) ||
      maxCaptures < 1 ||
      maxCaptures > MAX_MAX_CAPTURES
    ) {
      return { ok: false, message: `maxCaptures doit être un entier entre 1 et ${MAX_MAX_CAPTURES}.` }
    }
    mc = maxCaptures
  }

  return {
    ok: true,
    value: { startTime, endTime, preferredTime: pref, purpose: purpose as ProbePurpose, question: q, maxCaptures: mc },
  }
}

// --- Contrat réseau du relais /api/visual-probe ---

/** Corps de requête envoyé au relais puis à Gemini. */
export interface ProbeRequestBody {
  probeId: string
  snapshotId: number
  mediaTime: number
  mimeType: string
  imageBase64: string
  purpose: ProbePurpose
  question: string
}

/** Réponse structurée de succès du relais (contrat STRICT, validé avant stockage). */
export interface ProbeSuccessBody {
  probeId: string
  snapshotId: number
  mediaTime: number
  purpose: ProbePurpose
  question: string
  answer: string
  observations: string[]
  confidence: number
  limitations: string[]
  model: string
  latencyMs: number
}

export interface ProbeErrorBody {
  error: {
    code: string
    message: string
    retryable: boolean
  }
}

export const MAX_PROBE_ANSWER_LENGTH = 800

/**
 * Valide STRICTEMENT le corps d'une requête /api/visual-probe, côté serveur,
 * avant tout appel à Gemini.
 */
export function validateProbeRequest(body: unknown): ValidationResult<ProbeRequestBody> {
  if (typeof body !== 'object' || body === null) {
    return { ok: false, message: 'Corps JSON attendu.' }
  }
  const b = body as Record<string, unknown>

  if (typeof b.probeId !== 'string' || b.probeId.length === 0) {
    return { ok: false, message: 'probeId invalide.' }
  }
  if (typeof b.snapshotId !== 'number' || !Number.isInteger(b.snapshotId) || b.snapshotId < 0) {
    return { ok: false, message: 'snapshotId invalide.' }
  }
  if (typeof b.mediaTime !== 'number' || !Number.isFinite(b.mediaTime) || b.mediaTime < 0) {
    return { ok: false, message: 'mediaTime invalide.' }
  }
  if (typeof b.mimeType !== 'string' || b.mimeType.length === 0) {
    return { ok: false, message: 'mimeType invalide.' }
  }
  if (typeof b.imageBase64 !== 'string' || b.imageBase64.length === 0) {
    return { ok: false, message: 'Image manquante.' }
  }
  if (typeof b.purpose !== 'string' || !PROBE_PURPOSES.includes(b.purpose as ProbePurpose)) {
    return { ok: false, message: 'purpose invalide.' }
  }
  if (typeof b.question !== 'string' || b.question.trim().length < MIN_PROBE_QUESTION_LENGTH) {
    return { ok: false, message: 'question invalide.' }
  }

  return {
    ok: true,
    value: {
      probeId: b.probeId,
      snapshotId: b.snapshotId,
      mediaTime: b.mediaTime,
      mimeType: b.mimeType,
      imageBase64: b.imageBase64,
      purpose: b.purpose as ProbePurpose,
      question: b.question.trim(),
    },
  }
}

/**
 * Valide la réponse STRUCTURÉE renvoyée par Gemini, avant tout stockage.
 * Une réponse vide, mal typée ou hors bornes est REJETÉE (jamais stockée comme
 * un succès) : `answer` non vide, `confidence` dans [0,1], `observations` et
 * `limitations` sont des tableaux de chaînes (éventuellement vides).
 */
export function validateProbeStructuredResponse(raw: unknown): ValidationResult<{
  answer: string
  observations: string[]
  confidence: number
  limitations: string[]
}> {
  if (typeof raw !== 'object' || raw === null) {
    return { ok: false, message: 'Réponse du modèle vide ou mal formée.' }
  }
  const r = raw as Record<string, unknown>

  if (typeof r.answer !== 'string') {
    return { ok: false, message: 'answer manquant ou invalide.' }
  }
  const answer = r.answer.replace(/\s+/g, ' ').trim()
  if (answer.length < 1) {
    return { ok: false, message: 'answer vide.' }
  }

  const isStringArray = (v: unknown): v is string[] =>
    Array.isArray(v) && v.every((x) => typeof x === 'string')

  const observations = isStringArray(r.observations) ? r.observations : []
  const limitations = isStringArray(r.limitations) ? r.limitations : []

  if (typeof r.confidence !== 'number' || !Number.isFinite(r.confidence)) {
    return { ok: false, message: 'confidence manquant ou invalide.' }
  }
  const confidence = Math.min(1, Math.max(0, r.confidence))

  return {
    ok: true,
    value: {
      answer: answer.length > MAX_PROBE_ANSWER_LENGTH ? answer.slice(0, MAX_PROBE_ANSWER_LENGTH).trim() : answer,
      observations,
      confidence,
      limitations,
    },
  }
}

/** Libellés FR par intention (utilisés par l'UI). */
export const PROBE_PURPOSE_LABELS: Record<ProbePurpose, string> = {
  actor: 'Acteur / personnage',
  vehicle: 'Véhicule',
  location: 'Lieu',
  prop: 'Accessoire',
  costume: 'Costume',
  visual_confirmation: 'Confirmation visuelle',
  open_observation: 'Observation libre',
}
