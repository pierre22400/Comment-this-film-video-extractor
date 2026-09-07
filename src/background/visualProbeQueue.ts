// File d'analyse des SONDES VISUELLES ciblées — logique PURE, sans dépendance
// chrome/DOM, testable directement. Reprend le design éprouvé de
// `analysisQueue.ts` (concurrence 1, retries bornés sur erreurs transitoires
// uniquement, backoff avec jitter, une erreur n'affecte jamais les autres
// sondes, epoch pour ignorer les réponses tardives sur une sonde disparue).
//
// Séparée volontairement de la file de description (Cycle 2) : deux contrats
// réseau distincts (/api/describe vs /api/visual-probe), deux cycles de vie
// (snapshot vs sonde), et cela évite tout risque de régression sur la file
// déjà testée et validée.

import type { VisualProbeRequest, ProbePurpose } from '../lib/probe'

export interface ProbeOutcome {
  ok: boolean
  answer?: string
  observations?: string[]
  confidence?: number
  limitations?: string[]
  code?: string
  message?: string
  retryable?: boolean
}

/** Charge utile préparée par la couche d'accès aux données lors de la réclamation. */
export interface ClaimedProbeJob {
  snapshotId: number
  mediaTime: number
  mimeType: string
  imageBase64: string
  purpose: ProbePurpose
  question: string
  /**
   * Si défini, l'image N'EST PAS exploitable : la sonde devient 'unavailable'
   * sans aucun appel réseau ni retry (jamais envoyée à Gemini).
   */
  unavailable?: { cause: string; message: string }
}

export interface ProbeQueueDeps {
  /** Réclame atomiquement la sonde (captured → analyzing) ; null si absente/déjà prise. */
  claim(id: string): Promise<ClaimedProbeJob | null>
  /** Appelle le relais /api/visual-probe. */
  probe(req: {
    probeId: string
    snapshotId: number
    mediaTime: number
    mimeType: string
    imageBase64: string
    purpose: ProbePurpose
    question: string
  }): Promise<ProbeOutcome>
  /** Persiste un patch partiel de la sonde. */
  save(id: string, patch: Partial<VisualProbeRequest>): Promise<void>
  sleep(ms: number): Promise<void>
  now(): number
  epoch(): number
  onChange?(): void
  random?(): number
}

export interface ProbeQueueOptions {
  maxAttempts?: number
  baseBackoffMs?: number
  maxBackoffMs?: number
}

export class VisualProbeQueue {
  private readonly pending = new Set<string>()
  private readonly active = new Set<string>()
  private draining = false

  private readonly maxAttempts: number
  private readonly baseBackoffMs: number
  private readonly maxBackoffMs: number

  constructor(
    private readonly deps: ProbeQueueDeps,
    options: ProbeQueueOptions = {},
  ) {
    this.maxAttempts = options.maxAttempts ?? 3
    this.baseBackoffMs = options.baseBackoffMs ?? 500
    this.maxBackoffMs = options.maxBackoffMs ?? 8000
  }

  get size(): number {
    return this.pending.size
  }

  get activeCount(): number {
    return this.active.size
  }

  enqueue(id: string): void {
    if (this.active.has(id)) return
    this.pending.add(id)
    void this.drain()
  }

  clear(): void {
    this.pending.clear()
  }

  async whenIdle(): Promise<void> {
    while (this.draining) {
      await new Promise((r) => setTimeout(r, 0))
    }
  }

  private backoffDelay(attempt: number): number {
    const rand = this.deps.random ?? Math.random
    const exp = this.baseBackoffMs * Math.pow(2, attempt - 1)
    const capped = Math.min(this.maxBackoffMs, exp)
    return Math.round(capped + rand() * this.baseBackoffMs)
  }

  private async drain(): Promise<void> {
    if (this.draining) return
    this.draining = true
    try {
      while (this.pending.size > 0) {
        const id = this.pending.values().next().value as string
        this.pending.delete(id)
        this.active.add(id)
        try {
          await this.process(id)
        } catch {
          // Ne jamais laisser une exception interrompre le drainage des suivantes.
        } finally {
          this.active.delete(id)
          this.deps.onChange?.()
        }
      }
    } finally {
      this.draining = false
    }
  }

  private async process(id: string): Promise<void> {
    const claimed = await this.deps.claim(id)
    if (!claimed) return // absente ou déjà prise en charge : anti double-analyse.

    // Une image non exploitable n'est JAMAIS envoyée à Gemini.
    if (claimed.unavailable) {
      await this.deps.save(id, {
        status: 'unavailable',
        failureReason: claimed.unavailable.message,
        visualCause: claimed.unavailable.cause,
      })
      return
    }

    const epoch0 = this.deps.epoch()
    let attempt = 0

    // eslint-disable-next-line no-constant-condition
    while (true) {
      attempt += 1

      const outcome = await this.deps.probe({
        probeId: id,
        snapshotId: claimed.snapshotId,
        mediaTime: claimed.mediaTime,
        mimeType: claimed.mimeType,
        imageBase64: claimed.imageBase64,
        purpose: claimed.purpose,
        question: claimed.question,
      })

      // La sonde a disparu (effacement) pendant l'appel : on jette le résultat.
      if (this.deps.epoch() !== epoch0) return

      if (outcome.ok) {
        await this.deps.save(id, {
          status: 'succeeded',
          answer: outcome.answer,
          observations: outcome.observations,
          confidence: outcome.confidence,
          limitations: outcome.limitations,
        })
        return
      }

      const canRetry = Boolean(outcome.retryable) && attempt < this.maxAttempts
      if (!canRetry) {
        await this.deps.save(id, {
          status: 'failed',
          failureReason: outcome.message,
        })
        return
      }

      await this.deps.sleep(this.backoffDelay(attempt))
      if (this.deps.epoch() !== epoch0) return
    }
  }
}
