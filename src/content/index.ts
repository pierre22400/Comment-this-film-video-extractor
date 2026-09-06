import { findBestVideo } from './videoDetector'
import { captureFrame, detectImageFormat, type CaptureResult } from './frameCapture'
import { CaptureScheduler } from './captureScheduler'
import type { ContentRequest, ContentResponse } from '../lib/messages'
import type { VideoInfo, CaptureState, SnapshotMeta } from '../lib/types'
import { CaptureError, ERROR_MESSAGES, isCaptureErrorCode } from '../lib/errors'
import {
  type VisualAvailability,
  type VisualUnavailableCause,
  type VisualIncident,
  buildVisualIncident,
  classifyCaptureError,
  isSuspectFrame,
  newSessionGate,
  registerCaptureOutcome,
} from '../lib/visual'

// Content script injecté programmatiquement dans l'onglet actif (permission activeTab).
// Il détecte la vidéo, planifie les captures, capture les frames et transmet
// chaque image au service worker pour stockage IndexedDB.

declare global {
  interface Window {
    __CTF_INJECTED__?: boolean
  }
}

;(() => {
  // Garde anti double-injection : l'IIFE peut être ré-exécutée à chaque
  // ouverture du popup ; on conserve alors l'état existant.
  if (window.__CTF_INJECTED__) return
  window.__CTF_INJECTED__ = true

  let scheduler: CaptureScheduler | null = null
  let currentVideo: HTMLVideoElement | null = null
  let count = 0
  let intervalMs = 10_000
  let capturing = false
  // Amendement : dernier incident visuel structuré + garde anti-boucle de blocages.
  let lastVisualIncident: VisualIncident | null = null
  const sessionGate = newSessionGate()

  function getVideoInfo(v: HTMLVideoElement | null): VideoInfo | null {
    if (!v) return null
    return {
      videoWidth: v.videoWidth,
      videoHeight: v.videoHeight,
      duration: Number.isFinite(v.duration) ? v.duration : null,
      currentTime: v.currentTime,
      paused: v.paused,
      ended: v.ended,
    }
  }

  function getState(): CaptureState {
    // On rafraîchit la référence vidéo pour refléter les changements de page.
    const v = currentVideo && currentVideo.isConnected ? currentVideo : findBestVideo()
    currentVideo = v
    return {
      running: capturing,
      intervalMs,
      count,
      paused: v ? v.paused : false,
      videoInfo: getVideoInfo(v),
      lastVisualIncident,
    }
  }

  function persist(
    dataUrl: string,
    video: HTMLVideoElement,
    visual?: { availability: VisualAvailability; cause: VisualUnavailableCause },
  ): void {
    const meta: SnapshotMeta = {
      snapshotId: count + 1,
      capturedAt: new Date().toISOString(),
      // mediaTime provient directement de video.currentTime (seek pris en compte).
      mediaTime: video.currentTime,
      pageTitle: document.title,
      pageUrl: location.href,
      videoWidth: video.videoWidth,
      videoHeight: video.videoHeight,
      imageFormat: detectImageFormat(dataUrl),
      visualAvailability: visual?.availability,
      visualCause: visual?.cause,
    }
    chrome.runtime.sendMessage({ type: 'SAVE_SNAPSHOT', dataUrl, meta })
    count += 1
  }

  function runCapture(video: HTMLVideoElement): void {
    let result: CaptureResult
    try {
      result = captureFrame(video)
    } catch (err) {
      // Amendement : produire un ÉTAT STRUCTURÉ (pas seulement un log). Une seule
      // observation ne stoppe jamais la session ; seule une série de blocages
      // consécutifs suspend (évite une boucle d'échecs).
      const code = err instanceof CaptureError ? err.code : 'CAPTURE_ERROR'
      const { availability, cause } = classifyCaptureError(code)
      lastVisualIncident = buildVisualIncident({
        availability,
        cause,
        code,
        mediaTime: video.currentTime,
      })
      console.warn('[v0] Capture indisponible:', code, ERROR_MESSAGES[code])
      const { abort } = registerCaptureOutcome(
        sessionGate,
        availability === 'blocked' ? 'blocked' : 'temporary',
      )
      if (abort) stopCapture()
      return
    }

    const { dataUrl, stats } = result

    // Amendement : image presque noire / uniforme => suspecte. On la conserve
    // (timecode gardé) mais on ne l'enverra jamais à Gemini, et la session
    // continue normalement (une frame sombre isolée ne condamne pas la session).
    if (stats && isSuspectFrame(stats)) {
      lastVisualIncident = buildVisualIncident({
        availability: 'suspected_invalid',
        cause: 'suspected_blank_frame',
        mediaTime: video.currentTime,
      })
      registerCaptureOutcome(sessionGate, 'suspect')
      persist(dataUrl, video, {
        availability: 'suspected_invalid',
        cause: 'suspected_blank_frame',
      })
      return
    }

    // Capture exploitable : on efface l'incident et on réinitialise la garde.
    lastVisualIncident = null
    registerCaptureOutcome(sessionGate, 'ok')
    persist(dataUrl, video)
  }

  function onTick(): void {
    const v = currentVideo && currentVideo.isConnected ? currentVideo : findBestVideo()
    currentVideo = v
    if (!v) return
    // Pause / fin de vidéo : on ne capture pas (suspension), on reprendra au tick suivant.
    if (v.paused || v.ended) return

    // requestVideoFrameCallback : capturer une frame réellement présentée.
    const rvfc = (
      v as HTMLVideoElement & {
        requestVideoFrameCallback?: (cb: () => void) => number
      }
    ).requestVideoFrameCallback
    if (typeof rvfc === 'function') {
      rvfc.call(v, () => runCapture(v))
    } else {
      // Repli si l'API n'est pas disponible.
      runCapture(v)
    }
  }

  function startCapture(ms: number): void {
    intervalMs = ms
    currentVideo = findBestVideo()
    if (!currentVideo) throw new CaptureError('VIDEO_NOT_FOUND')
    count = 0
    capturing = true
    scheduler = new CaptureScheduler(intervalMs, onTick)
    scheduler.start()
  }

  function stopCapture(): void {
    capturing = false
    scheduler?.stop()
    scheduler = null
  }

  chrome.runtime.onMessage.addListener(
    (msg: ContentRequest, _sender, sendResponse: (r: ContentResponse) => void) => {
      try {
        switch (msg.type) {
          case 'DETECT': {
            currentVideo = findBestVideo()
            sendResponse(
              currentVideo
                ? { ok: true, kind: 'DETECT', videoInfo: getVideoInfo(currentVideo) }
                : {
                    ok: false,
                    code: 'VIDEO_NOT_FOUND',
                    message: ERROR_MESSAGES.VIDEO_NOT_FOUND,
                  },
            )
            break
          }
          case 'START': {
            startCapture(msg.intervalMs)
            sendResponse({ ok: true, kind: 'STATE', state: getState() })
            break
          }
          case 'STOP': {
            stopCapture()
            sendResponse({ ok: true, kind: 'STATE', state: getState() })
            break
          }
          case 'GET_STATE': {
            sendResponse({ ok: true, kind: 'STATE', state: getState() })
            break
          }
          default: {
            sendResponse({ ok: false, code: 'CAPTURE_ERROR', message: 'Message inconnu' })
          }
        }
      } catch (err) {
        const code =
          err instanceof CaptureError
            ? err.code
            : err instanceof Error && isCaptureErrorCode(err.message)
              ? err.message
              : 'CAPTURE_ERROR'
        sendResponse({
          ok: false,
          code,
          message: err instanceof Error ? err.message : String(err),
        })
      }
      // Réponse synchrone ; true garde le canal ouvert par sécurité.
      return true
    },
  )
})()
