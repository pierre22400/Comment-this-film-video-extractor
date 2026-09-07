import type { VideoInfo, CaptureState, SnapshotMeta } from './types'
import type { CaptureErrorCode } from './errors'
import type { ProbePurpose, VisualProbeRequest } from './probe'

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

export type ContentResponse =
  | { ok: true; kind: 'DETECT'; videoInfo: VideoInfo | null }
  | { ok: true; kind: 'STATE'; state: CaptureState }
  | { ok: false; code: CaptureErrorCode; message: string }

// --- Content script / Popup -> Service worker (chrome.runtime.sendMessage) ---
export type BackgroundRequest =
  | { type: 'SAVE_SNAPSHOT'; dataUrl: string; meta: SnapshotMeta }
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

/** Instantané de l'état de la file d'analyse (diagnostic manuel), exposé au popup. */
export interface AnalysisStatus {
  queued: number
  analyzing: number
}

export type BackgroundResponse =
  | { ok: true; id?: number }
  | { ok: true; status: AnalysisStatus }
  | { ok: true; enqueued: number }
  | { ok: true; probe: VisualProbeRequest }
  | { ok: true; probes: VisualProbeRequest[] }
  | { ok: false; message: string }
