import type { Snapshot } from '../lib/types'
import { analysisErrorMessage } from '../lib/analysis'

export type ChipKind = 'idle' | 'queued' | 'analyzing' | 'ok' | 'error'

export interface StateView {
  text: string
  kind: ChipKind
}

/** Libellé et style de l'état d'analyse d'un snapshot. */
export function analysisStateView(s: Snapshot): StateView {
  switch (s.analysisState ?? 'not_requested') {
    case 'queued':
      return { text: 'En attente', kind: 'queued' }
    case 'analyzing':
      return { text: 'Analyse…', kind: 'analyzing' }
    case 'succeeded':
      return { text: 'Décrit', kind: 'ok' }
    case 'failed':
      return { text: 'Erreur', kind: 'error' }
    default:
      return { text: 'Non analysé', kind: 'idle' }
  }
}

/** Message d'erreur lisible d'un snapshot en échec (ou chaîne vide). */
export function analysisErrorText(s: Snapshot): string {
  if ((s.analysisState ?? 'not_requested') !== 'failed') return ''
  if (s.analysisErrorMessage) return s.analysisErrorMessage
  return s.analysisErrorCode ? analysisErrorMessage(s.analysisErrorCode) : 'Échec de l’analyse.'
}
