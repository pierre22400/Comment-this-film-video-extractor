// Contrat de DISPONIBILITÉ VISUELLE (amendement Cycle 2) — module PUR, sans
// dépendance chrome/DOM/Node, afin d'être partagé (capture, file, UI, tests).
//
// But de l'amendement : le snapshot devient une source FACULTATIVE. Lorsqu'une
// image est indisponible (raison technique ou d'autorisation), la session doit
// continuer proprement, sans jamais envoyer d'image invalide à Gemini et sans
// présenter cela comme un échec de Gemini.
//
// Ce module NE construit PAS le moteur « sans image » : il fournit seulement le
// vocabulaire structuré et les règles de décision que les cycles suivants
// pourront réutiliser.

/** Disponibilité visuelle d'un instant vidéo. */
export type VisualAvailability =
  | 'available' // image exploitable
  | 'unavailable' // pas d'image exploitable (cause générique)
  | 'blocked' // capture refusée par le navigateur / restriction d'origine
  | 'suspected_invalid' // image probablement vide/uniforme (à ignorer pour l'analyse)
  | 'temporary_error' // incident transitoire de capture

/** Cause structurée lorsqu'une image est absente ou inexploitable. */
export type VisualUnavailableCause =
  | 'canvas_security'
  | 'capture_blocked'
  | 'permission_denied'
  | 'image_empty'
  | 'image_undecodable'
  | 'suspected_blank_frame'
  | 'temporary_capture_error'
  | 'unsupported'

/**
 * Incident visuel structuré : ce que l'état de capture doit pouvoir exposer.
 * Remplace les erreurs restées « uniquement dans les logs » au Cycle 1.
 */
export interface VisualIncident {
  /** Disponibilité visuelle constatée. */
  availability: VisualAvailability
  /** Cause structurée. */
  cause: VisualUnavailableCause
  /** Message lisible (prudent). */
  message: string
  /** Timecode vidéo concerné (secondes). */
  mediaTime: number
  /** Date ISO de l'incident. */
  at: string
  /** Dernier code technique rencontré (ex : code d'erreur de capture). */
  code?: string
}

/**
 * Observation légère liée à un timecode, avec snapshot FACULTATIF.
 * Contrat de préparation pour les cycles suivants (aucune capacité ajoutée ici :
 * pas de caption enrichi, pas d'identification, pas de recherche).
 */
export interface TimecodeObservation {
  mediaTime: number
  snapshotId: number | null
  visualAvailability: VisualAvailability
  visualDescription: string | null
}

/**
 * Messages FR prudents par cause. On NE FORMULE JAMAIS une accusation de DRM
 * lorsque le navigateur ne le confirme pas : « capture bloquée ou inaccessible ».
 */
export const VISUAL_CAUSE_MESSAGES: Record<VisualUnavailableCause, string> = {
  canvas_security: 'Capture bloquée ou inaccessible (restriction de sécurité ou d’origine).',
  capture_blocked: 'Capture bloquée ou inaccessible.',
  permission_denied: 'Accès à l’image refusé.',
  image_empty: 'Image vide.',
  image_undecodable: 'Image indécodable.',
  suspected_blank_frame: 'Image probablement vide ou uniforme (ignorée pour l’analyse).',
  temporary_capture_error: 'Erreur temporaire de capture.',
  unsupported: 'Capture non prise en charge dans ce contexte.',
}

export function visualCauseMessage(cause: VisualUnavailableCause): string {
  return VISUAL_CAUSE_MESSAGES[cause]
}

/**
 * Seule une image `available` peut être envoyée à Gemini. Toute autre valeur
 * signifie « ne pas analyser » (état d'analyse `not_applicable`).
 */
export function isAnalyzable(availability: VisualAvailability): boolean {
  return availability === 'available'
}

/**
 * Traduit un code d'erreur de capture (voir errors.ts) en disponibilité + cause
 * structurées. Ne conclut jamais à une DRM : les blocages restent « bloqués ou
 * inaccessibles ».
 */
export function classifyCaptureError(code: string): {
  availability: VisualAvailability
  cause: VisualUnavailableCause
} {
  switch (code) {
    case 'CANVAS_SECURITY_ERROR':
      return { availability: 'blocked', cause: 'canvas_security' }
    case 'VIDEO_CAPTURE_BLOCKED':
      return { availability: 'blocked', cause: 'capture_blocked' }
    case 'VIDEO_NOT_READY':
      return { availability: 'temporary_error', cause: 'temporary_capture_error' }
    default:
      return { availability: 'temporary_error', cause: 'temporary_capture_error' }
  }
}

/** Construit un incident visuel structuré et daté. */
export function buildVisualIncident(params: {
  availability: VisualAvailability
  cause: VisualUnavailableCause
  mediaTime: number
  code?: string
  at?: string
  message?: string
}): VisualIncident {
  return {
    availability: params.availability,
    cause: params.cause,
    message: params.message ?? visualCauseMessage(params.cause),
    mediaTime: params.mediaTime,
    at: params.at ?? new Date().toISOString(),
    code: params.code,
  }
}

// --- Détection d'image suspecte (presque noire / uniforme) ---

/** Statistiques de luminance d'une frame (luma 0..255). */
export interface FrameStats {
  meanLuma: number
  variance: number
}

export interface SuspectFrameOptions {
  /** Sous ce niveau de luminance moyenne, la frame est jugée « presque noire ». */
  blackLumaThreshold?: number
  /** Sous cette variance, la frame est jugée « uniforme » (unie). */
  uniformVarianceThreshold?: number
}

/**
 * Une frame presque noire OU uniforme est suspecte. C'est une simple heuristique
 * par image : elle NE conclut jamais, à elle seule, que toute la vidéo est
 * bloquée (voir la garde de session ci-dessous).
 */
export function isSuspectFrame(stats: FrameStats, opts: SuspectFrameOptions = {}): boolean {
  const black = opts.blackLumaThreshold ?? 6
  const uniform = opts.uniformVarianceThreshold ?? 1
  return stats.meanLuma <= black || stats.variance <= uniform
}

// --- Garde de session ---
//
// Une SEULE observation suspecte ou un SEUL blocage ne doit jamais arrêter
// définitivement la session. Seule une série de blocages consécutifs (le
// navigateur refuse durablement la capture) justifie de suspendre, afin d'éviter
// une boucle d'échecs. Toute capture exploitable ou suspecte réinitialise la série.

export const MAX_CONSECUTIVE_BLOCKED = 3

export type CaptureOutcomeKind = 'ok' | 'suspect' | 'blocked' | 'temporary'

export interface SessionGate {
  consecutiveBlocked: number
}

export function newSessionGate(): SessionGate {
  return { consecutiveBlocked: 0 }
}

/**
 * Enregistre le résultat d'une capture et indique s'il faut suspendre la session.
 * Seuls les blocages consécutifs comptent ; `ok`, `suspect` et `temporary`
 * réinitialisent la série (une frame sombre isolée ne condamne donc jamais tout).
 */
export function registerCaptureOutcome(
  gate: SessionGate,
  kind: CaptureOutcomeKind,
  max: number = MAX_CONSECUTIVE_BLOCKED,
): { abort: boolean } {
  if (kind === 'blocked') gate.consecutiveBlocked += 1
  else gate.consecutiveBlocked = 0
  return { abort: gate.consecutiveBlocked >= max }
}
