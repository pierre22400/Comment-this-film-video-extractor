import { describe, it, expect, vi } from 'vitest'
import {
  PlannedCaptureRunner,
  type RunnerVideo,
  type PlannedCaptureEvent,
  type PlannedItemState,
} from '../src/content/plannedCaptureRunner'
import type { CaptureResult } from '../src/content/frameCapture'
import { CaptureError } from '../src/lib/errors'

/**
 * Faux HTMLVideoElement pilotable pour tester le runner sans DOM réel (cohérent
 * avec les autres tests : modules purs + duck-typing). Par défaut, régler
 * `currentTime` déclenche immédiatement l'événement `seeked` (seek instantané).
 */
function makeVideo(opts: { duration?: number; autoSeek?: boolean } = {}) {
  const listeners = new Map<string, Set<() => void>>()
  const fire = (type: string) => {
    for (const cb of listeners.get(type) ?? []) cb()
  }
  let _t = 0
  const autoSeek = opts.autoSeek ?? true
  const video: RunnerVideo & { fire: (t: string) => void; setTime: (n: number) => void } = {
    duration: opts.duration ?? 1000,
    paused: false,
    readyState: 4,
    get currentTime() {
      return _t
    },
    set currentTime(n: number) {
      _t = n
      // Seek instantané : l'événement seeked survient au prochain microtask.
      if (autoSeek) queueMicrotask(() => fire('seeked'))
    },
    addEventListener(type, cb) {
      if (!listeners.has(type)) listeners.set(type, new Set())
      listeners.get(type)!.add(cb)
    },
    removeEventListener(type, cb) {
      listeners.get(type)?.delete(cb)
    },
    fire,
    setTime(n: number) {
      _t = n
    },
  }
  return video
}

/** Sleep injecté qui résout au prochain macrotask (déterministe et rapide). */
const fastSleep = () => new Promise<void>((r) => setTimeout(r, 0))

function okCapture(): CaptureResult {
  return { dataUrl: 'data:image/webp;base64,AAA', stats: { meanLuma: 120, variance: 40 } }
}
function suspectCapture(): CaptureResult {
  return { dataUrl: 'data:image/webp;base64,BBB', stats: { meanLuma: 1, variance: 0 } }
}
function blockedCapture(): never {
  throw new CaptureError('VIDEO_CAPTURE_BLOCKED')
}

describe('PlannedCaptureRunner — mode seek', () => {
  it('parcourt le plan, capture chaque timecode et suit la progression', async () => {
    const captures: PlannedCaptureEvent[] = []
    const items: PlannedItemState[] = []
    const runner = new PlannedCaptureRunner({
      onItem: (s) => items.push(s),
      onCapture: (e) => captures.push(e),
      onDone: () => {},
      captureFn: vi.fn(okCapture),
      sleep: fastSleep,
    })
    const video = makeVideo()
    const summary = await runner.run(video, [10, 20, 30], 'seek', 0)

    expect(summary.total).toBe(3)
    expect(summary.captured).toBe(3)
    expect(captures).toHaveLength(3)
    expect(captures.map((c) => c.requestedTime)).toEqual([10, 20, 30])
    // Le timecode capturé est bien video.currentTime (positionné par le seek).
    expect(captures.map((c) => c.actualTime)).toEqual([10, 20, 30])
    expect(items.some((i) => i.status === 'captured')).toBe(true)
  })

  it('une image suspecte est conservée mais marquée suspected_invalid (jamais Gemini)', async () => {
    const captures: PlannedCaptureEvent[] = []
    const runner = new PlannedCaptureRunner({
      onItem: () => {},
      onCapture: (e) => captures.push(e),
      onDone: () => {},
      captureFn: vi.fn(suspectCapture),
      sleep: fastSleep,
    })
    const summary = await runner.run(makeVideo(), [10], 'seek', 0)
    expect(summary.captured).toBe(1)
    expect(captures[0].availability).toBe('suspected_invalid')
    expect(captures[0].dataUrl).toBeTruthy()
  })

  it('une capture bloquée de façon répétée => item unavailable, sans image', async () => {
    const captures: PlannedCaptureEvent[] = []
    const finalStates = new Map<number, PlannedItemState>()
    const runner = new PlannedCaptureRunner(
      {
        onItem: (s) => finalStates.set(s.index, s),
        onCapture: (e) => captures.push(e),
        onDone: () => {},
        captureFn: vi.fn(blockedCapture),
        sleep: fastSleep,
      },
      { maxAttemptsPerItem: 2 },
    )
    const summary = await runner.run(makeVideo(), [10], 'seek', 0)
    expect(summary.unavailable).toBe(1)
    expect(captures).toHaveLength(0) // aucune image stockée
    expect(finalStates.get(0)?.status).toBe('unavailable')
    expect(finalStates.get(0)?.availability).toBe('blocked')
  })

  it('ignore proprement un timecode au-delà de la durée connue (skipped)', async () => {
    const finalStates = new Map<number, PlannedItemState>()
    const runner = new PlannedCaptureRunner({
      onItem: (s) => finalStates.set(s.index, s),
      onCapture: () => {},
      onDone: () => {},
      captureFn: vi.fn(okCapture),
      sleep: fastSleep,
    })
    const summary = await runner.run(makeVideo({ duration: 100 }), [50, 500], 'seek', 0)
    expect(summary.captured).toBe(1)
    expect(summary.skipped).toBe(1)
    expect(finalStates.get(1)?.status).toBe('skipped')
  })

  it('un seek qui n’aboutit jamais (pas d’événement seeked) => unavailable, borné (jamais infini)', async () => {
    // autoSeek=false : régler currentTime ne déclenche jamais `seeked`, et la
    // valeur ne bouge pas non plus -> le fallback borné conclut à l'échec.
    const video = makeVideo({ autoSeek: false })
    // Empêche `set currentTime` de bouger la valeur observée.
    Object.defineProperty(video, 'currentTime', {
      get: () => 0,
      set: () => {},
      configurable: true,
    })
    const finalStates = new Map<number, PlannedItemState>()
    const runner = new PlannedCaptureRunner({
      onItem: (s) => finalStates.set(s.index, s),
      onCapture: () => {},
      onDone: () => {},
      captureFn: vi.fn(okCapture),
      sleep: fastSleep,
    })
    const summary = await runner.run(video, [50], 'seek', 0)
    expect(summary.captured).toBe(0)
    expect(summary.unavailable).toBe(1)
    expect(finalStates.get(0)?.status).toBe('unavailable')
  })

  it('annulation en cours : les items restants ne sont jamais tentés', async () => {
    let runner: PlannedCaptureRunner
    const captureFn = vi.fn(() => {
      // Annule juste après la première capture : les suivants doivent s'arrêter.
      runner.cancel()
      return okCapture()
    })
    const finalStates = new Map<number, PlannedItemState>()
    runner = new PlannedCaptureRunner({
      onItem: (s) => finalStates.set(s.index, s),
      onCapture: () => {},
      onDone: () => {},
      captureFn,
      sleep: fastSleep,
    })
    const summary = await runner.run(makeVideo(), [10, 20, 30], 'seek', 0)
    expect(summary.cancelled).toBe(true)
    // Le premier item est capturé, mais le second est annulé et le capture n'est
    // jamais rappelé pour les items suivants.
    expect(summary.captured).toBe(1)
    expect(captureFn).toHaveBeenCalledTimes(1)
    expect(finalStates.get(1)?.status).toBe('cancelled')
  })

  it('appelle onDone exactement une fois avec le résumé final', async () => {
    const onDone = vi.fn()
    const runner = new PlannedCaptureRunner({
      onItem: () => {},
      onCapture: () => {},
      onDone,
      captureFn: vi.fn(okCapture),
      sleep: fastSleep,
    })
    await runner.run(makeVideo(), [10, 20], 'seek', 0)
    expect(onDone).toHaveBeenCalledTimes(1)
    expect(onDone.mock.calls[0][0].captured).toBe(2)
  })
})

describe('PlannedCaptureRunner — mode playback', () => {
  it('attend que la lecture naturelle atteigne le timecode, puis capture', async () => {
    const captures: PlannedCaptureEvent[] = []
    const video = makeVideo()
    video.setTime(0)
    const runner = new PlannedCaptureRunner({
      onItem: () => {},
      onCapture: (e) => captures.push(e),
      onDone: () => {},
      captureFn: vi.fn(okCapture),
      sleep: fastSleep,
    })

    const p = runner.run(video, [5], 'playback', 0)
    // Simule la progression de la lecture jusqu'au timecode.
    video.setTime(5)
    video.fire('timeupdate')
    const summary = await p

    expect(summary.captured).toBe(1)
    expect(captures[0].requestedTime).toBe(5)
  })

  it('capture immédiatement si le timecode est déjà atteint (pause dans la fenêtre)', async () => {
    const video = makeVideo()
    video.setTime(30)
    video.paused = true
    const captures: PlannedCaptureEvent[] = []
    const runner = new PlannedCaptureRunner({
      onItem: () => {},
      onCapture: (e) => captures.push(e),
      onDone: () => {},
      captureFn: vi.fn(okCapture),
      sleep: fastSleep,
    })
    const summary = await runner.run(video, [10], 'playback', 0)
    expect(summary.captured).toBe(1)
    expect(captures[0].actualTime).toBe(30)
  })
})
