// Sonde visuelle ciblée : planification côté content script.
//
// Contrairement à la capture périodique (minuteur mural, `CaptureScheduler`),
// une sonde visuelle est pilotée par le TIMECODE RÉEL de la vidéo
// (`timeupdate`/`seeked`/`pause`), jamais par une horloge indépendante. Cela
// lui permet de gérer nativement :
//  - la pause/reprise (aucun `timeupdate` en pause ; on capture quand même une
//    fois au moment de la pause, la frame reste valide) ;
//  - le seek en avant (peut sauter directement au-delà de la fenêtre : détecté
//    au prochain événement, jamais de boucle d'attente) ;
//  - le seek en arrière dans une fenêtre déjà résolue (ignorée : idempotence
//    stricte, une sonde résolue ne capture jamais deux fois).

import { captureFrame, type CaptureResult } from './frameCapture'
import { CaptureError } from '../lib/errors'
import {
  type VisualAvailability,
  type VisualUnavailableCause,
  classifyCaptureError,
  isSuspectFrame,
} from '../lib/visual'

export interface ScheduledProbe {
  id: string
  startTime: number
  endTime: number
  preferredTime: number | null
  maxCaptures: number
}

export type ProbeCaptureOutcome =
  // Une image A ÉTÉ obtenue (exploitable ou suspecte) : un snapshot est créé
  // dans tous les cas, jamais envoyé à Gemini si availability !== 'available'.
  | {
      kind: 'captured'
      dataUrl: string
      availability: VisualAvailability
      cause?: VisualUnavailableCause
      mediaTime: number
      captureAttempts: number
    }
  // AUCUNE image n'a jamais pu être obtenue (capture bloquée/erreur répétée) :
  // aucun snapshot créé, jamais envoyé à Gemini.
  | {
      kind: 'unavailable'
      cause: VisualUnavailableCause
      mediaTime: number
      captureAttempts: number
    }
  // La fenêtre est passée sans qu'une seule tentative n'ait eu lieu.
  | { kind: 'missed'; captureAttempts: number }

export interface VisualProbeSchedulerCallbacks {
  onStatusUpdate(id: string, status: 'waiting' | 'capturing'): void
  onOutcome(id: string, outcome: ProbeCaptureOutcome): void
  /**
   * Fonction de capture injectable (par défaut `captureFrame` du module
   * frameCapture). Permet de tester le SCHEDULING (fenêtres, idempotence,
   * seek, pause) sans dépendre d'un vrai HTMLVideoElement/Canvas.
   */
  captureFn?: (video: HTMLVideoElement) => CaptureResult
}

interface InternalEntry extends ScheduledProbe {
  attempts: number
  lastCause: VisualUnavailableCause | null
}

/**
 * Gère le cycle de vie de la phase de CAPTURE de toutes les sondes actives
 * pour une vidéo donnée. La phase d'ANALYSE (Gemini) est gérée séparément par
 * le service worker après réception d'un `onOutcome({ kind: 'captured' })`.
 */
export class VisualProbeScheduler {
  private readonly entries = new Map<string, InternalEntry>()
  private readonly resolved = new Set<string>()
  private video: HTMLVideoElement | null = null
  private readonly handleTick = () => this.tick()
  private attached = false

  private readonly captureFn: (video: HTMLVideoElement) => CaptureResult

  constructor(private readonly callbacks: VisualProbeSchedulerCallbacks) {
    this.captureFn = callbacks.captureFn ?? captureFrame
  }

  attach(video: HTMLVideoElement): void {
    if (this.video === video && this.attached) return
    this.detach()
    this.video = video
    video.addEventListener('timeupdate', this.handleTick)
    video.addEventListener('seeked', this.handleTick)
    video.addEventListener('pause', this.handleTick)
    video.addEventListener('play', this.handleTick)
    this.attached = true
  }

  detach(): void {
    if (this.video && this.attached) {
      this.video.removeEventListener('timeupdate', this.handleTick)
      this.video.removeEventListener('seeked', this.handleTick)
      this.video.removeEventListener('pause', this.handleTick)
      this.video.removeEventListener('play', this.handleTick)
    }
    this.attached = false
  }

  register(probe: ScheduledProbe): void {
    if (this.resolved.has(probe.id) || this.entries.has(probe.id)) return
    this.entries.set(probe.id, { ...probe, attempts: 0, lastCause: null })
    this.tick()
  }

  /** Retire une sonde active (annulation explicite) sans jamais la finaliser. */
  unregister(id: string): void {
    this.entries.delete(id)
    this.resolved.add(id)
  }

  get activeCount(): number {
    return this.entries.size
  }

  tick(): void {
    const video = this.video
    if (!video) return
    const currentTime = video.currentTime

    for (const entry of Array.from(this.entries.values())) {
      if (this.resolved.has(entry.id)) {
        this.entries.delete(entry.id)
        continue
      }

      const inWindow = currentTime >= entry.startTime && currentTime <= entry.endTime
      const pastWindow = currentTime > entry.endTime

      if (inWindow) {
        this.attemptCapture(video, entry)
        continue
      }

      if (pastWindow) {
        this.finalizeMissedOrUnavailable(entry)
      }
      // Avant la fenêtre : rien à faire, on attend le prochain événement.
    }
  }

  private attemptCapture(video: HTMLVideoElement, entry: InternalEntry): void {
    this.callbacks.onStatusUpdate(entry.id, 'waiting')
    this.callbacks.onStatusUpdate(entry.id, 'capturing')

    let result: CaptureResult
    try {
      result = this.captureFn(video)
    } catch (err) {
      const code = err instanceof CaptureError ? err.code : 'CAPTURE_ERROR'
      const { cause } = classifyCaptureError(code)
      entry.attempts += 1
      entry.lastCause = cause
      this.maybeFinalizeAfterAttempt(entry)
      return
    }

    const { dataUrl, stats } = result
    entry.attempts += 1

    // Une image presque noire/uniforme est suspecte : on la conserve (timecode
    // gardé, snapshot créé) mais elle ne sera JAMAIS envoyée à Gemini. Si le
    // budget de tentatives permet encore d'essayer d'obtenir une meilleure
    // image, on retente ; sinon on finalise avec celle-ci.
    if (stats && isSuspectFrame(stats)) {
      entry.lastCause = 'suspected_blank_frame'
      if (entry.attempts < entry.maxCaptures) return // retentera au prochain tick.
      this.resolved.add(entry.id)
      this.entries.delete(entry.id)
      this.callbacks.onOutcome(entry.id, {
        kind: 'captured',
        dataUrl,
        availability: 'suspected_invalid',
        cause: 'suspected_blank_frame',
        mediaTime: video.currentTime,
        captureAttempts: entry.attempts,
      })
      return
    }

    // Capture exploitable : on finalise IMMÉDIATEMENT (idempotence stricte —
    // jamais une deuxième capture pour la même sonde).
    this.resolved.add(entry.id)
    this.entries.delete(entry.id)
    this.callbacks.onOutcome(entry.id, {
      kind: 'captured',
      dataUrl,
      availability: 'available',
      mediaTime: video.currentTime,
      captureAttempts: entry.attempts,
    })
  }

  /** Après une tentative infructueuse : retente au prochain tick si le budget le permet. */
  private maybeFinalizeAfterAttempt(entry: InternalEntry): void {
    if (entry.attempts >= entry.maxCaptures) {
      this.resolved.add(entry.id)
      this.entries.delete(entry.id)
      this.callbacks.onOutcome(entry.id, {
        kind: 'unavailable',
        cause: entry.lastCause ?? 'unsupported',
        mediaTime: this.video?.currentTime ?? entry.startTime,
        captureAttempts: entry.attempts,
      })
    }
    // Sinon : budget non épuisé, on retentera au prochain `timeupdate` tant
    // que la fenêtre n'est pas dépassée (voir `tick`).
  }

  private finalizeMissedOrUnavailable(entry: InternalEntry): void {
    this.resolved.add(entry.id)
    this.entries.delete(entry.id)
    if (entry.attempts === 0) {
      // Jamais eu la moindre chance de capturer (ex : vidéo pas prête pendant
      // toute la fenêtre) : la sonde est simplement MANQUÉE, jamais retentée.
      this.callbacks.onOutcome(entry.id, { kind: 'missed', captureAttempts: 0 })
      return
    }
    // Au moins une tentative a eu lieu mais aucune image exploitable n'a été
    // obtenue avant la fin de la fenêtre : indisponible, jamais envoyée à Gemini.
    this.callbacks.onOutcome(entry.id, {
      kind: 'unavailable',
      cause: entry.lastCause ?? 'unsupported',
      mediaTime: this.video?.currentTime ?? entry.endTime,
      captureAttempts: entry.attempts,
    })
  }
}

// Réexporté pour l'appelant (content/index.ts) qui construit les métadonnées.
export type { VisualAvailability }
