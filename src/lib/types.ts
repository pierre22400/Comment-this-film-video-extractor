// Types partagés entre le content script, le service worker et le popup.

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
  /**
   * Réservé au Cycle 2 (description générée par Gemini).
   * TOUJOURS absent/vide au Cycle 1 — ne jamais le remplir ici.
   */
  description?: string
}

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
