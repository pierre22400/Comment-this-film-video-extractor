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

export type BackgroundResponse =
  | { ok: true; id?: number }
  | { ok: false; message: string }
