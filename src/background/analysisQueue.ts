// File d'attente d'analyse Gemini — logique PURE, sans dépendance chrome/DOM,
// afin d'être testable directement. Toutes les E/S (réclamation en base, appel
// réseau, persistance, horloge) sont injectées via `QueueDeps`.
//
// Garanties :
// - concurrence 1 (un seul appel Gemini actif à la fois) ;
// - au plus `maxAttempts` tentatives (1 initiale + retries) ;
// - retry uniquement pour les échecs marqués `retryable` ;
// - backoff exponentiel court avec jitter ;
// - une erreur sur un snapshot ne bloque pas les suivants ;
// - une réponse arrivant après un changement d'epoch (effacement) est ignorée.

import type { AnalysisPatch } from '../lib/types'

export interface DescribeOutcome {
  ok: boolean
  description?: string
  model?: string
  latencyMs?: number
  code?: string
  message?: string
  retryable?: boolean
}

/** Charge utile préparée par la couche d'accès aux données lors de la réclamation. */
export interface ClaimedJob {
  mediaTime: number
  mimeType: string
  imageBase64: string
  /** Nombre de tentatives DÉJÀ effectuées avant celle-ci. */
  attempts: number
}

export interface QueueDeps {
  /** Réclame atomiquement le snapshot (queued→analyzing) ; null si absent/déjà pris. */
  claim(id: number): Promise<ClaimedJob | null>
  /** Appelle le relais serveur pour décrire l'image. */
  describe(req: {
    snapshotId: number
    mediaTime: number
    mimeType: string
    imageBase64: string
  }): Promise<DescribeOutcome>
  /** Persiste UNIQUEMENT les champs d'analyse du snapshot. */
  save(id: number, patch: AnalysisPatch): Promise<void>
  /** Pause asynchrone (injectable pour tests déterministes). */
  sleep(ms: number): Promise<void>
  /** Horloge (ms). */
  now(): number
  /**
   * Génération courante. Incrémentée à chaque effacement : si elle change pendant
   * qu'un travail est en vol, son résultat est jeté (le snapshot n'existe plus).
   */
  epoch(): number
  /** Notifié après chaque changement d'état (facultatif). */
  onChange?(): void
  /** Source d'aléa pour le jitter (injectable ; défaut Math.random). */
  random?(): number
}

export interface QueueOptions {
  maxAttempts?: number
  baseBackoffMs?: number
  maxBackoffMs?: number
}

export class AnalysisQueue {
  private readonly pending = new Set<number>()
  private readonly active = new Set<number>()
  private draining = false

  private readonly maxAttempts: number
  private readonly baseBackoffMs: number
  private readonly maxBackoffMs: number

  constructor(
    private readonly deps: QueueDeps,
    options: QueueOptions = {},
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

  enqueue(id: number): void {
    if (this.active.has(id)) return
    this.pending.add(id)
    void this.drain()
  }

  enqueueMany(ids: number[]): void {
    for (const id of ids) {
      if (!this.active.has(id)) this.pending.add(id)
    }
    void this.drain()
  }

  /** Vide la file en attente (les travaux déjà en vol sont neutralisés via l'epoch). */
  clear(): void {
    this.pending.clear()
  }

  /** Attend la fin du drainage courant (utile aux tests). */
  async whenIdle(): Promise<void> {
    // On cède au macrotask queue (setTimeout réel) plutôt qu'au microtask queue,
    // afin de ne pas affamer les timers en vol pendant l'attente.
    while (this.draining) {
      await new Promise((r) => setTimeout(r, 0))
    }
  }

  private backoffDelay(attempt: number): number {
    const rand = this.deps.random ?? Math.random
    const exp = this.baseBackoffMs * Math.pow(2, attempt - 1)
    const capped = Math.min(this.maxBackoffMs, exp)
    // Jitter additif borné à une base pour éviter les rafales synchronisées.
    return Math.round(capped + rand() * this.baseBackoffMs)
  }

  private async drain(): Promise<void> {
    if (this.draining) return
    this.draining = true
    try {
      while (this.pending.size > 0) {
        const id = this.pending.values().next().value as number
        this.pending.delete(id)
        this.active.add(id)
        try {
          await this.process(id)
        } catch {
          // Ne jamais laisser une exception interrompre le drainage des suivants.
        } finally {
          this.active.delete(id)
          this.deps.onChange?.()
        }
      }
    } finally {
      this.draining = false
    }
  }

  private async process(id: number): Promise<void> {
    const claimed = await this.deps.claim(id)
    if (!claimed) return // absent ou déjà pris en charge : anti double-analyse.

    const epoch0 = this.deps.epoch()
    let attempt = claimed.attempts

    // Boucle tentative + retries.
    // eslint-disable-next-line no-constant-condition
    while (true) {
      attempt += 1

      const outcome = await this.deps.describe({
        snapshotId: id,
        mediaTime: claimed.mediaTime,
        mimeType: claimed.mimeType,
        imageBase64: claimed.imageBase64,
      })

      // Effacement survenu pendant l'appel : on jette le résultat.
      if (this.deps.epoch() !== epoch0) return

      if (outcome.ok) {
        await this.deps.save(id, {
          analysisState: 'succeeded',
          description: outcome.description,
          analysisModel: outcome.model,
          analysisLatencyMs: outcome.latencyMs,
          analysisAttempts: attempt,
          analysisErrorCode: undefined,
          analysisErrorMessage: undefined,
        })
        return
      }

      const canRetry = Boolean(outcome.retryable) && attempt < this.maxAttempts
      if (!canRetry) {
        await this.deps.save(id, {
          analysisState: 'failed',
          analysisAttempts: attempt,
          analysisErrorCode: outcome.code,
          analysisErrorMessage: outcome.message,
        })
        return
      }

      // Backoff avant retry ; on reste en 'analyzing'.
      await this.deps.sleep(this.backoffDelay(attempt))
      if (this.deps.epoch() !== epoch0) return
    }
  }
}
