// Scanner visuel planifié (Cycle 3) — RUNNER de capture.
//
// À la différence de la capture périodique (minuteur mural) et de la sonde
// visuelle (réactive au timecode), le runner parcourt SÉQUENTIELLEMENT une liste
// de timecodes issue d'un plan résolu. Deux stratégies :
//   - « seek »     (défaut) : on règle `video.currentTime`, on attend l'événement
//                   `seeked` puis une frame réellement présentée si disponible,
//                   puis un court délai de stabilisation, puis on capture.
//   - « playback » : on laisse la lecture naturelle atteindre chaque timecode
//                   (aucune vitesse de lecture non exposée n'est jamais forcée).
//
// SÉCURITÉ : ce module ne contourne AUCUNE protection (DRM/EME/CORS/HDCP) et
// n'extrait aucun flux. Il déplace seulement le curseur de lecture et capture ce
// que le navigateur veut bien fournir. Une image indisponible/noire est un
// résultat valable, diagnostiqué proprement (statut `unavailable`).
//
// Le timecode OBSERVÉ est toujours `video.currentTime`, jamais une horloge murale.
// Toutes les attentes et retries sont STRICTEMENT bornés (aucune boucle infinie).

import { captureFrame, type CaptureResult } from './frameCapture'
import { CaptureError } from '../lib/errors'
import {
  type VisualAvailability,
  type VisualUnavailableCause,
  classifyCaptureError,
  isSuspectFrame,
} from '../lib/visual'
import type { PlannerMode } from '../lib/planner'
import type { GalleryItemState, GalleryItemStatus } from '../lib/gallery'

/** Statut persistant d'un item du plan (par timecode). */
export type PlannedItemStatus = GalleryItemStatus

/** État observable d'un item durant l'exécution. */
export interface PlannedItemState extends GalleryItemState {}

/** Résultat d'une capture réussie remontée à l'appelant (pour stockage). */
export interface PlannedCaptureEvent {
  index: number
  requestedTime: number
  actualTime: number
  dataUrl: string
  availability: VisualAvailability
  cause?: VisualUnavailableCause
}

/** Élément vidéo minimal requis par le runner (facilite le mock en test). */
export interface RunnerVideo {
  currentTime: number
  duration: number
  paused: boolean
  ended?: boolean
  readyState: number
  addEventListener(type: string, cb: () => void): void
  removeEventListener(type: string, cb: () => void): void
  requestVideoFrameCallback?: (cb: () => void) => number
}

export interface PlannedRunnerCallbacks {
  /** Notifie chaque changement d'état d'un item (progression). */
  onItem(state: PlannedItemState): void
  /** Une image a été capturée (exploitable OU suspecte) : à stocker. */
  onCapture(event: PlannedCaptureEvent): void
  /** Le plan est terminé (tous les items résolus) ou annulé. */
  onDone(summary: PlannedRunSummary): void
  /** Capture injectable (défaut : `captureFrame`). */
  captureFn?: (video: HTMLVideoElement) => CaptureResult | Promise<CaptureResult>
  /** Pause asynchrone injectable (défaut : setTimeout). */
  sleep?: (ms: number) => Promise<void>
}

export interface PlannedRunSummary {
  total: number
  captured: number
  unavailable: number
  skipped: number
  failed: number
  cancelled: boolean
}

export interface PlannedRunOptions {
  /** Délai d'attente maximal (ms) de l'événement `seeked` avant de renoncer. */
  seekTimeoutMs?: number
  /** Attente maximale (ms) d'une frame présentée après `seeked`. */
  frameTimeoutMs?: number
  /** Nombre maximal de tentatives de capture par item (bornage strict). */
  maxAttemptsPerItem?: number
  /** En mode « playback », attente maximale (ms) que la lecture atteigne le timecode. */
  playbackTimeoutMs?: number
}

const DEFAULTS: Required<PlannedRunOptions> = {
  seekTimeoutMs: 4000,
  frameTimeoutMs: 1500,
  maxAttemptsPerItem: 2,
  playbackTimeoutMs: 30_000,
}

/** Tolérance de passage naturel : au-delà, un timecode déjà dépassé est ignoré. */
const PLAYBACK_TOLERANCE_SECONDS = 0.75

function defaultSleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/**
 * Exécute un plan de captures. Une seule exécution active à la fois par
 * instance ; `cancel()` interrompt proprement (l'item courant devient
 * `cancelled`, les suivants ne sont jamais tentés).
 */
export class PlannedCaptureRunner {
  private cancelled = false
  private running = false
  private readonly cancelWaiters = new Set<() => void>()

  private readonly captureFn: (video: HTMLVideoElement) => CaptureResult | Promise<CaptureResult>
  private readonly sleep: (ms: number) => Promise<void>
  private readonly opts: Required<PlannedRunOptions>

  constructor(
    private readonly callbacks: PlannedRunnerCallbacks,
    options: PlannedRunOptions = {},
  ) {
    this.captureFn = callbacks.captureFn ?? captureFrame
    this.sleep = callbacks.sleep ?? defaultSleep
    this.opts = { ...DEFAULTS, ...options }
  }

  get isRunning(): boolean {
    return this.running
  }

  /** Demande l'annulation coopérative de l'exécution en cours. */
  cancel(): void {
    this.cancelled = true
    for (const waiter of this.cancelWaiters) waiter()
    this.cancelWaiters.clear()
  }

  /**
   * Exécute le plan (`timecodes` triés/dédupliqués) sur `video`. Renvoie un
   * résumé. Ne lève jamais : toute erreur d'un item devient un statut d'item.
   */
  async run(
    video: RunnerVideo,
    timecodes: number[],
    mode: PlannerMode,
    settleMs: number,
  ): Promise<PlannedRunSummary> {
    if (this.running) {
      return { total: 0, captured: 0, unavailable: 0, skipped: 0, failed: 0, cancelled: false }
    }
    this.running = true
    this.cancelled = false

    const summary: PlannedRunSummary = {
      total: timecodes.length,
      captured: 0,
      unavailable: 0,
      skipped: 0,
      failed: 0,
      cancelled: false,
    }

    try {
      for (let index = 0; index < timecodes.length; index += 1) {
        const requestedTime = timecodes[index]

        if (this.cancelled) {
          this.emit(index, requestedTime, 'cancelled')
          summary.cancelled = true
          break
        }

        // Hors durée connue : ignoré proprement (jamais une erreur).
        if (Number.isFinite(video.duration) && video.duration > 0 && requestedTime > video.duration + 0.5) {
          this.emit(index, requestedTime, 'skipped')
          summary.skipped += 1
          continue
        }

        const result = await this.processItem(video, index, requestedTime, mode, settleMs)
        if (result === 'captured') summary.captured += 1
        else if (result === 'unavailable') summary.unavailable += 1
        else if (result === 'skipped') summary.skipped += 1
        else if (result === 'failed') summary.failed += 1
        else if (result === 'cancelled') {
          summary.cancelled = true
          break
        }
      }
    } finally {
      this.running = false
      this.callbacks.onDone(summary)
    }
    return summary
  }

  private emit(
    index: number,
    requestedTime: number,
    status: PlannedItemStatus,
    extra?: Partial<PlannedItemState>,
  ): void {
    this.callbacks.onItem({ index, requestedTime, status, ...extra })
  }

  private async processItem(
    video: RunnerVideo,
    index: number,
    requestedTime: number,
    mode: PlannerMode,
    settleMs: number,
  ): Promise<PlannedItemStatus> {
    // 1) Positionnement au timecode demandé.
    if (mode === 'seek') {
      this.emit(index, requestedTime, 'seeking')
      const ok = await this.seekTo(video, requestedTime)
      if (this.cancelled) {
        this.emit(index, requestedTime, 'cancelled')
        return 'cancelled'
      }
      if (!ok) {
        // L'événement `seeked` n'est jamais arrivé dans le délai imparti :
        // capture indisponible pour cet item (jamais une boucle d'attente).
        this.emit(index, requestedTime, 'unavailable', {
          availability: 'temporary_error',
          cause: 'temporary_capture_error',
        })
        return 'unavailable'
      }
    } else {
      this.emit(index, requestedTime, 'seeking')
      const reached = await this.awaitPlayback(video, requestedTime)
      if (this.cancelled) {
        this.emit(index, requestedTime, 'cancelled')
        return 'cancelled'
      }
      if (!reached) {
        this.emit(index, requestedTime, 'skipped')
        return 'skipped'
      }
    }

    // 2) Attendre une frame réellement présentée (si l'API existe), puis stabiliser.
    await this.awaitPresentedFrame(video)
    if (settleMs > 0) await this.sleep(settleMs)
    if (this.cancelled) {
      this.emit(index, requestedTime, 'cancelled')
      return 'cancelled'
    }

    // 3) Capture, avec retries strictement bornés.
    this.emit(index, requestedTime, 'capturing')
    let lastCause: VisualUnavailableCause | null = null
    for (let attempt = 0; attempt < this.opts.maxAttemptsPerItem; attempt += 1) {
      if (this.cancelled) {
        this.emit(index, requestedTime, 'cancelled')
        return 'cancelled'
      }
      let result: CaptureResult
      try {
        result = await this.captureFn(video as unknown as HTMLVideoElement)
      } catch (err) {
        const code = err instanceof CaptureError ? err.code : 'CAPTURE_ERROR'
        const { cause } = classifyCaptureError(code)
        lastCause = cause
        if (attempt + 1 < this.opts.maxAttemptsPerItem) {
          await this.sleep(Math.min(250, settleMs || 250))
          continue
        }
        break
      }

      const { dataUrl, stats } = result
      const actualTime = video.currentTime

      if (stats && isSuspectFrame(stats)) {
        // Image conservée (timecode gardé) mais jamais envoyée à Gemini.
        this.callbacks.onCapture({
          index,
          requestedTime,
          actualTime,
          dataUrl,
          availability: 'suspected_invalid',
          cause: 'suspected_blank_frame',
        })
        this.emit(index, requestedTime, 'captured', {
          actualTime,
          availability: 'suspected_invalid',
          cause: 'suspected_blank_frame',
        })
        return 'captured'
      }

      // Image exploitable.
      this.callbacks.onCapture({
        index,
        requestedTime,
        actualTime,
        dataUrl,
        availability: 'available',
      })
      this.emit(index, requestedTime, 'captured', { actualTime, availability: 'available' })
      return 'captured'
    }

    // Toutes les tentatives ont échoué à obtenir une image.
    const availability: VisualAvailability = lastCause === 'canvas_security' || lastCause === 'capture_blocked'
      ? 'blocked'
      : 'temporary_error'
    this.emit(index, requestedTime, lastCause ? 'unavailable' : 'failed', {
      availability,
      cause: lastCause ?? undefined,
    })
    return lastCause ? 'unavailable' : 'failed'
  }

  /**
   * Règle `video.currentTime` et attend l'événement `seeked`, borné par
   * `seekTimeoutMs`. Renvoie false si le seek n'aboutit pas dans le délai.
   */
  private seekTo(video: RunnerVideo, time: number): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      let settled = false
      const done = (ok: boolean) => {
        if (settled) return
        settled = true
        video.removeEventListener('seeked', onSeeked)
        resolve(ok)
      }
      const onSeeked = () => done(true)
      video.addEventListener('seeked', onSeeked)
      try {
        video.currentTime = time
      } catch {
        done(false)
        return
      }
      // Si le player est déjà exactement sur le timecode, `seeked` peut ne pas
      // se déclencher : on vérifie après un court délai.
      void this.sleep(this.opts.seekTimeoutMs).then(() => {
        if (Math.abs(video.currentTime - time) <= 0.35) done(true)
        else done(false)
      })
    })
  }

  /**
   * Mode « playback » : attend que la lecture naturelle atteigne le timecode,
   * borné par `playbackTimeoutMs`. Ne force jamais la vitesse de lecture.
   */
  private awaitPlayback(video: RunnerVideo, time: number): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      if (video.currentTime > time + PLAYBACK_TOLERANCE_SECONDS) {
        resolve(false)
        return
      }
      if (video.currentTime >= time - PLAYBACK_TOLERANCE_SECONDS) {
        resolve(true)
        return
      }
      let settled = false
      let watchdogGeneration = 0
      const done = (ok: boolean) => {
        if (settled) return
        settled = true
        watchdogGeneration += 1
        video.removeEventListener('timeupdate', onTick)
        video.removeEventListener('seeked', onTick)
        video.removeEventListener('play', onPlay)
        video.removeEventListener('pause', onPause)
        video.removeEventListener('ended', onEnded)
        this.cancelWaiters.delete(onCancel)
        resolve(ok)
      }
      const onTick = () => {
        if (this.cancelled) done(false)
        else if (video.currentTime > time + PLAYBACK_TOLERANCE_SECONDS) done(false)
        else if (video.currentTime >= time - PLAYBACK_TOLERANCE_SECONDS) done(true)
        else armWatchdog()
      }
      const onCancel = () => done(false)
      const onPause = () => {
        // Une pause ne consomme jamais le budget d'attente active.
        watchdogGeneration += 1
      }
      const onPlay = () => armWatchdog()
      const onEnded = () => done(false)
      const armWatchdog = () => {
        if (video.paused || settled) return
        const generation = ++watchdogGeneration
        void this.sleep(this.opts.playbackTimeoutMs).then(() => {
          if (!settled && generation === watchdogGeneration) done(false)
        })
      }
      video.addEventListener('timeupdate', onTick)
      video.addEventListener('seeked', onTick)
      video.addEventListener('play', onPlay)
      video.addEventListener('pause', onPause)
      video.addEventListener('ended', onEnded)
      this.cancelWaiters.add(onCancel)
      armWatchdog()
    })
  }

  /**
   * Attend une frame réellement présentée via `requestVideoFrameCallback` si
   * l'API existe, borné par `frameTimeoutMs`. Sinon retourne immédiatement.
   */
  private awaitPresentedFrame(video: RunnerVideo): Promise<void> {
    const rvfc = video.requestVideoFrameCallback
    if (typeof rvfc !== 'function') return Promise.resolve()
    return new Promise<void>((resolve) => {
      let settled = false
      const done = () => {
        if (settled) return
        settled = true
        resolve()
      }
      try {
        rvfc.call(video, done)
      } catch {
        done()
        return
      }
      void this.sleep(this.opts.frameTimeoutMs).then(done)
    })
  }
}
