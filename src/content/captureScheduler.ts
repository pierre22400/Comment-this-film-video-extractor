// Planification des captures à intervalle régulier.
// Le scheduler déclenche un "tick" ; c'est l'appelant qui décide de capturer
// ou non (il ignore le tick quand la vidéo est en pause), ce qui suspend
// naturellement la capture pendant les pauses et la reprend à la lecture.

export type Tick = () => void

export class CaptureScheduler {
  private timer: ReturnType<typeof setInterval> | null = null
  private readonly intervalMs: number
  private readonly onTick: Tick

  constructor(intervalMs: number, onTick: Tick) {
    this.intervalMs = intervalMs
    this.onTick = onTick
  }

  start(): void {
    this.stop()
    this.timer = setInterval(() => this.onTick(), this.intervalMs)
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  get running(): boolean {
    return this.timer !== null
  }
}
