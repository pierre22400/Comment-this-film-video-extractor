import type { VideoInfo, CaptureState, SnapshotMeta } from './types'
import type { CaptureErrorCode } from './errors'
import type { ProbePurpose, VisualProbeRequest } from './probe'
import type { PlannerMode } from './planner'
import type { GalleryRun, Platform } from './gallery'
import type { GalleryCounters, GalleryItemState } from './gallery'
import type { PlannedItemState, PlannedRunSummary } from '../content/plannedCaptureRunner'

/** Définition d'une sonde visuelle, telle que soumise par le popup. */
export interface ProbeDefinition {
  startTime: number
  endTime: number
  preferredTime: number | null
  purpose: ProbePurpose
  question: string
  maxCaptures: number
}

// --- Popup -> Content script (chrome.tabs.sendMessage) ---
export type ContentRequest =
  | { type: 'DETECT' }
  | { type: 'START'; intervalMs: number }
  | { type: 'STOP' }
  | { type: 'GET_STATE' }
  // Sonde visuelle ciblée : le content script observe seul le timecode réel de
  // la vidéo (timeupdate/seeked), jamais un minuteur mural indépendant.
  | { type: 'REGISTER_VISUAL_PROBE'; id: string; probe: ProbeDefinition }
  | { type: 'UNREGISTER_VISUAL_PROBE'; id: string }
  // Scanner visuel planifié (Cycle 3) : exécution d'un plan résolu dans l'onglet.
  // Le content script positionne le curseur (seek/lecture) et capture ; il ne
  // contourne jamais de protection ni n'extrait de flux.
  | {
      type: 'RUN_PLAN'
      galleryId: string
      timecodes: number[]
      mode: PlannerMode
      settleMs: number
      /** Essai explicite : capture de l'affichage de l'onglet, puis recadrage du lecteur. */
      captureSurface?: 'video' | 'visible_tab'
    }
  | { type: 'CANCEL_PLAN' }
  | { type: 'GET_PLAN_STATE' }

export type ContentResponse =
  | { ok: true; kind: 'DETECT'; videoInfo: VideoInfo | null }
  | { ok: true; kind: 'STATE'; state: CaptureState }
  | { ok: true; kind: 'PLAN'; plan: PlanRunState }
  | { ok: false; code: CaptureErrorCode; message: string }

/** État en direct de l'exécution d'un plan, exposé au popup. */
export interface PlanRunState {
  running: boolean
  galleryId: string | null
  total: number
  done: number
  items: PlannedItemState[]
  summary: PlannedRunSummary | null
}

// --- Content script / Popup -> Service worker (chrome.runtime.sendMessage) ---
export type BackgroundRequest =
  | { type: 'SAVE_SNAPSHOT'; dataUrl: string; meta: SnapshotMeta }
  // Demande provenant UNIQUEMENT du content script de l'onglet actif pendant
  // l'essai explicite Prime. `captureVisibleTab` n'accède pas au flux DRM.
  | { type: 'CAPTURE_VISIBLE_TAB' }
  | { type: 'CLEAR' }
  // Diagnostic manuel : actions explicites uniquement, jamais liées à la
  // capture périodique automatique.
  | { type: 'GET_ANALYSIS_STATUS' }
  | { type: 'ENQUEUE_UNANALYZED' }
  | { type: 'RETRY_SNAPSHOT'; id: number }
  // Sonde visuelle ciblée : cycle de vie complet piloté par le service worker
  // (source de vérité persistée), le content script ne fait qu'observer le
  // timecode et remonter les événements de capture.
  | { type: 'CREATE_VISUAL_PROBE'; probe: ProbeDefinition }
  | { type: 'CANCEL_VISUAL_PROBE'; id: string }
  | { type: 'LIST_VISUAL_PROBES' }
  | { type: 'PROBE_STATUS_UPDATE'; id: string; status: 'waiting' | 'capturing' }
  | {
      type: 'PROBE_CAPTURED'
      id: string
      dataUrl: string
      meta: SnapshotMeta
      actualCaptureTime: number
      captureAttempts: number
    }
  // Aucune image n'a jamais pu être obtenue (capture bloquée/erreur répétée) :
  // aucun snapshot créé, jamais envoyé à Gemini.
  | { type: 'PROBE_UNAVAILABLE'; id: string; cause: string; mediaTime: number; captureAttempts: number }
  | { type: 'PROBE_MISSED'; id: string; captureAttempts: number }
  // Scanner visuel planifié (Cycle 3) : cycle de vie des galeries.
  | {
      type: 'CREATE_GALLERY_RUN'
      name: string
      fixtureName: string
      pageUrl: string
      pageTitle: string
      platform: Platform
      strategy: PlannerMode
      timecodes: number[]
    }
  | { type: 'GALLERY_SNAPSHOT'; galleryId: string; dataUrl: string; meta: SnapshotMeta }
  | { type: 'GALLERY_ITEM_STATUS'; galleryId: string; item: GalleryItemState }
  | {
      type: 'FINALIZE_GALLERY_RUN'
      galleryId: string
      cancelled: boolean
      counters: GalleryCounters
      items: GalleryItemState[]
    }
  | { type: 'LIST_GALLERY_RUNS' }
  | { type: 'DELETE_GALLERY_RUN'; galleryId: string }
  // Analyse Gemini ACTIVÉE SÉPARÉMENT pour une galerie précise (jamais pour les
  // captures périodiques ordinaires). Seules les images valides sont mises en file.
  | { type: 'ANALYZE_GALLERY'; galleryId: string }
  // Exporte localement les WebP + le manifest de la galerie.
  | { type: 'EXPORT_GALLERY'; galleryId: string }

/** Instantané de l'état de la file d'analyse (diagnostic manuel), exposé au popup. */
export interface AnalysisStatus {
  queued: number
  analyzing: number
}

export type BackgroundResponse =
  | { ok: true; id?: number }
  | { ok: true; dataUrl: string }
  | { ok: true; status: AnalysisStatus }
  | { ok: true; enqueued: number }
  | { ok: true; probe: VisualProbeRequest }
  | { ok: true; probes: VisualProbeRequest[] }
  | { ok: true; galleryId: string }
  | { ok: true; run: GalleryRun }
  | { ok: true; runs: GalleryRun[] }
  | { ok: true; deleted: number }
  | { ok: false; message: string }
