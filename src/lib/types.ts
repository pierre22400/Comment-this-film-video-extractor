// Types partagés entre le content script, le service worker et le popup.

import type { AnalysisState } from './analysis'

/**
 * Un snapshot capturé et stocké dans IndexedDB.
 * Le champ `image` contient les pixels réels (Blob WebP).
 */
export interface Snapshot {
  id: number
  capturedAt: string // ISO 8601, ex: "2026-09-06T16:30:15.432Z"
  mediaTime: number // video.currentTime en secondes (précision conservée)
  pageTitle: string
  pageUrl: string
  videoWidth: number
  videoHeight: number
  mimeType: string // ex: "image/webp"
  image: Blob

  // --- Cycle 2 : description automatique (Gemini) ---
  // Tous ces champs sont optionnels : les snapshots du Cycle 1 restent valides.

  /** Description visuelle courte produite par Gemini (contenu visible uniquement). */
  description?: string
  /** État du cycle d'analyse. Absent = 'not_requested'. */
  analysisState?: AnalysisState
  /** Nombre de tentatives d'analyse effectuées. */
  analysisAttempts?: number
  /** Date ISO de la dernière mise à jour d'analyse. */
  analysisUpdatedAt?: string
  /** Code d'erreur d'analyse éventuel (dernier échec). */
  analysisErrorCode?: string
  /** Message d'erreur d'analyse lisible éventuel. */
  analysisErrorMessage?: string
  /** Modèle Gemini ayant produit la description. */
  analysisModel?: string
  /** Durée de l'appel Gemini en millisecondes, si disponible. */
  analysisLatencyMs?: number
}

/** Champs d'analyse modifiables (patch partiel appliqué à un snapshot). */
export type AnalysisPatch = Partial<
  Pick<
    Snapshot,
    | 'description'
    | 'analysisState'
    | 'analysisAttempts'
    | 'analysisUpdatedAt'
    | 'analysisErrorCode'
    | 'analysisErrorMessage'
    | 'analysisModel'
    | 'analysisLatencyMs'
  >
>

/**
 * Métadonnées d'un snapshot transmises du content script vers le service worker
 * (l'image voyage séparément sous forme de data URL).
 */
export interface SnapshotMeta {
  snapshotId: number
  capturedAt: string
  mediaTime: number
  pageTitle: string
  pageUrl: string
  videoWidth: number
  videoHeight: number
  imageFormat: string
}

/** Informations sur la vidéo détectée, affichées dans le popup. */
export interface VideoInfo {
  videoWidth: number
  videoHeight: number
  duration: number | null
  currentTime: number
  paused: boolean
  ended: boolean
}

/** État courant de la capture, renvoyé par le content script. */
export interface CaptureState {
  running: boolean
  intervalMs: number
  count: number
  paused: boolean
  videoInfo: VideoInfo | null
}
