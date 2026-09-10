import { describe, it, expect, vi } from 'vitest'
import { VisualProbeScheduler, type ProbeCaptureOutcome } from '../src/content/visualProbeScheduler'
import type { CaptureResult } from '../src/content/frameCapture'
import { CaptureError } from '../src/lib/errors'

/**
 * Fausse vidéo minimale (duck-typing) : évite toute dépendance à un vrai DOM
 * (jsdom non configuré dans ce projet — cohérent avec les autres tests qui
 * ne testent que des modules PURS). Seule la surface utilisée par
 * VisualProbeScheduler est implémentée : addEventListener/removeEventListener
 * + currentTime.
 */
function fakeVideo() {
  const listeners = new Map<string, Set<() => void>>()
  return {
    currentTime: 0,
    addEventListener(type: string, cb: () => void) {
      if (!listeners.has(type)) listeners.set(type, new Set())
      listeners.get(type)!.add(cb)
    },
    removeEventListener(type: string, cb: () => void) {
      listeners.get(type)?.delete(cb)
    },
    fire(type: string) {
      for (const cb of listeners.get(type) ?? []) cb()
    },
  }
}

type FakeVideo = ReturnType<typeof fakeVideo>

function asVideo(v: FakeVideo): HTMLVideoElement {
  return v as unknown as HTMLVideoElement
}

function okCapture(): CaptureResult {
  return { dataUrl: 'data:image/webp;base64,AAA', stats: { meanLuma: 120, variance: 40 } }
}

function suspectCapture(): CaptureResult {
  return { dataUrl: 'data:image/webp;base64,BBB', stats: { meanLuma: 1, variance: 0 } }
}

function blockedCapture(): never {
  throw new CaptureError('VIDEO_CAPTURE_BLOCKED')
}

describe('VisualProbeScheduler', () => {
  it('1. inactive avant la fenêtre : aucune capture, aucun statut émis', () => {
    const onStatusUpdate = vi.fn()
    const onOutcome = vi.fn()
    const captureFn = vi.fn(okCapture)
    const scheduler = new VisualProbeScheduler({ onStatusUpdate, onOutcome, captureFn })
    const video = fakeVideo()
    scheduler.attach(asVideo(video))
    scheduler.register({ id: 'p1', startTime: 10, endTime: 15, preferredTime: null, maxCaptures: 1 })

    video.currentTime = 2
    video.fire('timeupdate')

    expect(captureFn).not.toHaveBeenCalled()
    expect(onStatusUpdate).not.toHaveBeenCalled()
    expect(onOutcome).not.toHaveBeenCalled()
  })

  it('2. déclenche la capture dans la fenêtre et notifie waiting puis capturing', () => {
    const onStatusUpdate = vi.fn()
    const onOutcome = vi.fn()
    const captureFn = vi.fn(okCapture)
    const scheduler = new VisualProbeScheduler({ onStatusUpdate, onOutcome, captureFn })
    const video = fakeVideo()
    scheduler.attach(asVideo(video))
    scheduler.register({ id: 'p1', startTime: 10, endTime: 15, preferredTime: null, maxCaptures: 1 })

    video.currentTime = 12
    video.fire('timeupdate')

    expect(onStatusUpdate).toHaveBeenCalledWith('p1', 'waiting')
    expect(onStatusUpdate).toHaveBeenCalledWith('p1', 'capturing')
    expect(captureFn).toHaveBeenCalledTimes(1)
    const outcome = onOutcome.mock.calls[0][1] as ProbeCaptureOutcome
    expect(outcome.kind).toBe('captured')
    expect((outcome as { availability: string }).availability).toBe('available')
  })

  it('3. ne capture JAMAIS deux fois la même sonde (idempotence stricte)', () => {
    const onOutcome = vi.fn()
    const captureFn = vi.fn(okCapture)
    const scheduler = new VisualProbeScheduler({ onStatusUpdate: vi.fn(), onOutcome, captureFn })
    const video = fakeVideo()
    scheduler.attach(asVideo(video))
    scheduler.register({ id: 'p1', startTime: 10, endTime: 15, preferredTime: null, maxCaptures: 1 })

    video.currentTime = 12
    video.fire('timeupdate')
    // Nouveaux ticks dans la même fenêtre, voire un seek arrière dans la fenêtre :
    video.currentTime = 13
    video.fire('timeupdate')
    video.currentTime = 11
    video.fire('seeked')

    expect(captureFn).toHaveBeenCalledTimes(1)
    expect(onOutcome).toHaveBeenCalledTimes(1)
  })

  it('4. un seek en avant DANS la fenêtre déclenche la capture', () => {
    const onOutcome = vi.fn()
    const captureFn = vi.fn(okCapture)
    const scheduler = new VisualProbeScheduler({ onStatusUpdate: vi.fn(), onOutcome, captureFn })
    const video = fakeVideo()
    scheduler.attach(asVideo(video))
    scheduler.register({ id: 'p1', startTime: 20, endTime: 25, preferredTime: null, maxCaptures: 1 })

    video.currentTime = 22
    video.fire('seeked') // seek direct dans la fenêtre, sans timeupdate préalable

    expect(captureFn).toHaveBeenCalledTimes(1)
    expect(onOutcome).toHaveBeenCalledTimes(1)
  })

  it('5. fenêtre dépassée SANS jamais avoir pu capturer => missed, jamais retentée', () => {
    const onOutcome = vi.fn()
    const captureFn = vi.fn(okCapture)
    const scheduler = new VisualProbeScheduler({ onStatusUpdate: vi.fn(), onOutcome, captureFn })
    const video = fakeVideo()
    scheduler.attach(asVideo(video))
    scheduler.register({ id: 'p1', startTime: 10, endTime: 15, preferredTime: null, maxCaptures: 1 })

    // Un seek direct saute PAR-DESSUS toute la fenêtre.
    video.currentTime = 20
    video.fire('seeked')

    expect(captureFn).not.toHaveBeenCalled()
    expect(onOutcome).toHaveBeenCalledTimes(1)
    expect(onOutcome.mock.calls[0][1].kind).toBe('missed')

    // Un retour en arrière DANS l'ancienne fenêtre ne relance rien (résolue).
    video.currentTime = 12
    video.fire('seeked')
    expect(captureFn).not.toHaveBeenCalled()
    expect(onOutcome).toHaveBeenCalledTimes(1)
  })

  it('6. capture bloquée de façon répétée jusqu’à épuisement du budget => unavailable, jamais retentée après', () => {
    const onOutcome = vi.fn()
    const captureFn = vi.fn(blockedCapture)
    const scheduler = new VisualProbeScheduler({ onStatusUpdate: vi.fn(), onOutcome, captureFn })
    const video = fakeVideo()
    scheduler.attach(asVideo(video))
    scheduler.register({ id: 'p1', startTime: 10, endTime: 15, preferredTime: null, maxCaptures: 2 })

    video.currentTime = 11
    video.fire('timeupdate') // tentative 1 : échec
    video.currentTime = 12
    video.fire('timeupdate') // tentative 2 : échec => budget épuisé => finalisation

    expect(captureFn).toHaveBeenCalledTimes(2)
    expect(onOutcome).toHaveBeenCalledTimes(1)
    const outcome = onOutcome.mock.calls[0][1] as ProbeCaptureOutcome
    expect(outcome.kind).toBe('unavailable')

    // Un tick supplémentaire dans la fenêtre ne retente rien (résolue).
    video.currentTime = 13
    video.fire('timeupdate')
    expect(captureFn).toHaveBeenCalledTimes(2)
    expect(onOutcome).toHaveBeenCalledTimes(1)
  })

  it('7. une image suspecte est conservée (snapshot créé) mais jamais envoyée à Gemini', () => {
    const onOutcome = vi.fn()
    const captureFn = vi.fn(suspectCapture)
    const scheduler = new VisualProbeScheduler({ onStatusUpdate: vi.fn(), onOutcome, captureFn })
    const video = fakeVideo()
    scheduler.attach(asVideo(video))
    scheduler.register({ id: 'p1', startTime: 10, endTime: 15, preferredTime: null, maxCaptures: 1 })

    video.currentTime = 12
    video.fire('timeupdate')

    const outcome = onOutcome.mock.calls[0][1] as ProbeCaptureOutcome
    expect(outcome.kind).toBe('captured')
    expect((outcome as { availability: string }).availability).toBe('suspected_invalid')
    expect((outcome as { dataUrl: string }).dataUrl).toBeTruthy()
  })

  it('8. pause dans la fenêtre : capture quand même (pas besoin d’un timeupdate)', () => {
    const onOutcome = vi.fn()
    const captureFn = vi.fn(okCapture)
    const scheduler = new VisualProbeScheduler({ onStatusUpdate: vi.fn(), onOutcome, captureFn })
    const video = fakeVideo()
    scheduler.attach(asVideo(video))
    scheduler.register({ id: 'p1', startTime: 10, endTime: 15, preferredTime: null, maxCaptures: 1 })

    video.currentTime = 12
    video.fire('pause') // l'utilisateur met en pause exactement dans la fenêtre

    expect(captureFn).toHaveBeenCalledTimes(1)
    expect(onOutcome).toHaveBeenCalledTimes(1)
  })

  it('9. annulation explicite (unregister) : la sonde ne capture jamais, même dans sa fenêtre', () => {
    const onOutcome = vi.fn()
    const captureFn = vi.fn(okCapture)
    const scheduler = new VisualProbeScheduler({ onStatusUpdate: vi.fn(), onOutcome, captureFn })
    const video = fakeVideo()
    scheduler.attach(asVideo(video))
    scheduler.register({ id: 'p1', startTime: 10, endTime: 15, preferredTime: null, maxCaptures: 1 })
    scheduler.unregister('p1')

    video.currentTime = 12
    video.fire('timeupdate')

    expect(captureFn).not.toHaveBeenCalled()
    expect(onOutcome).not.toHaveBeenCalled()
  })

  it('10. une erreur sur une sonde n’affecte pas les autres sondes actives', () => {
    const onOutcome = vi.fn()
    const captureFn = vi
      .fn()
      .mockImplementationOnce(blockedCapture)
      .mockImplementationOnce(okCapture)
    const scheduler = new VisualProbeScheduler({ onStatusUpdate: vi.fn(), onOutcome, captureFn })
    const video = fakeVideo()
    scheduler.attach(asVideo(video))
    scheduler.register({ id: 'blocked', startTime: 10, endTime: 15, preferredTime: null, maxCaptures: 1 })
    scheduler.register({ id: 'ok', startTime: 10, endTime: 15, preferredTime: null, maxCaptures: 1 })

    video.currentTime = 12
    video.fire('timeupdate')

    expect(onOutcome).toHaveBeenCalledTimes(2)
    const byId = new Map(onOutcome.mock.calls.map((c) => [c[0], c[1] as ProbeCaptureOutcome]))
    expect(byId.get('blocked')?.kind).toBe('unavailable')
    expect(byId.get('ok')?.kind).toBe('captured')
  })
})
