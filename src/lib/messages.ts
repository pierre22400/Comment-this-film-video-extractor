import type { VideoInfo, CaptureState, SnapshotMeta } from './types'
import type { CaptureErrorCode } from './errors'

// --- Popup -> Content script (chrome.tabs.sendMessage) ---
export type ContentRequest =
  | { type: 'DETECT' }
  | { type: 'START'; intervalMs: number }
  | { type: 'STOP' }
  | { type: 'GET_STATE' }

export type ContentResponse =
  | { ok: true; kind: 'DETECT'; videoInfo: VideoInfo | null }
  | { ok: true; kind: 'STATE'; state: CaptureState }
  | { ok: false; code: CaptureErrorCode; message: string }

// --- Content script / Popup -> Service worker (chrome.runtime.sendMessage) ---
export type BackgroundRequest =
  | { type: 'SAVE_SNAPSHOT'; dataUrl: string; meta: SnapshotMeta }
  | { type: 'CLEAR' }
  // Cycle 2 : pilotage de l'analyse Gemini (popup -> service worker).
  | { type: 'SET_ANALYSIS_ENABLED'; enabled: boolean }
  | { type: 'GET_ANALYSIS_STATUS' }
  | { type: 'ENQUEUE_UNANALYZED' }
  | { type: 'RETRY_SNAPSHOT'; id: number }

/** Instantané de l'état de la file d'analyse, exposé au popup. */
export interface AnalysisStatus {
  enabled: boolean
  queued: number
  analyzing: number
}

export type BackgroundResponse =
  | { ok: true; id?: number }
  | { ok: true; status: AnalysisStatus }
  | { ok: true; enqueued: number }
  | { ok: false; message: string }
