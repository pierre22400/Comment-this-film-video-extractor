import type { ProbeStatus, VisualProbeRequest } from '../lib/probe'
import { PROBE_PURPOSE_LABELS } from '../lib/probe'

export { PROBE_PURPOSE_LABELS }

export type ProbeChipKind = 'idle' | 'live' | 'ok' | 'error' | 'na' | 'cancelled'

export interface ProbeStateView {
  text: string
  kind: ProbeChipKind
}

/** Libellé FR et style d'un statut de sonde visuelle. */
export function probeStatusView(status: ProbeStatus): ProbeStateView {
  switch (status) {
    case 'scheduled':
      return { text: 'Programmée', kind: 'idle' }
    case 'waiting':
      return { text: 'Fenêtre atteinte…', kind: 'live' }
    case 'capturing':
      return { text: 'Capture…', kind: 'live' }
    case 'captured':
      return { text: 'Capturée — analyse à venir', kind: 'live' }
    case 'analyzing':
      return { text: 'Analyse…', kind: 'live' }
    case 'succeeded':
      return { text: 'Répondue', kind: 'ok' }
    case 'missed':
      return { text: 'Fenêtre manquée', kind: 'na' }
    case 'unavailable':
      return { text: 'Image indisponible', kind: 'na' }
    case 'failed':
      return { text: 'Échec', kind: 'error' }
    case 'cancelled':
      return { text: 'Annulée', kind: 'cancelled' }
    default:
      return { text: status, kind: 'idle' }
  }
}

/** Résumé lisible du résultat/diagnostic d'une sonde (ou chaîne vide). */
export function probeResultText(p: VisualProbeRequest): string {
  if (p.status === 'succeeded' && p.answer) return p.answer
  if (p.failureReason) return p.failureReason
  return ''
}

/** Compte les sondes par grande catégorie, pour l'en-tête du panneau. */
export function summarizeProbes(probes: VisualProbeRequest[]): {
  scheduled: number
  live: number
  done: number
  missedOrFailed: number
} {
  let scheduled = 0
  let live = 0
  let done = 0
  let missedOrFailed = 0
  for (const p of probes) {
    if (p.status === 'scheduled') scheduled += 1
    else if (['waiting', 'capturing', 'captured', 'analyzing'].includes(p.status)) live += 1
    else if (p.status === 'succeeded') done += 1
    else if (['missed', 'unavailable', 'failed'].includes(p.status)) missedOrFailed += 1
  }
  return { scheduled, live, done, missedOrFailed }
}
