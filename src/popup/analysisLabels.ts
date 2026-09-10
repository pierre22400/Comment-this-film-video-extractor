import type { Snapshot } from '../lib/types'
import { analysisErrorMessage } from '../lib/analysis'
import { visualCauseMessage } from '../lib/visual'

// 'na' (not applicable) est NEUTRE, distinct de 'error' : une image indisponible
// n'est jamais présentée comme un échec de Gemini.
export type ChipKind = 'idle' | 'queued' | 'analyzing' | 'ok' | 'error' | 'na'

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
    case 'not_applicable':
      return { text: 'Image indisponible', kind: 'na' }
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

/**
 * Message d'une image non exploitable (état 'not_applicable'). Distinct d'une
 * erreur Gemini : la session continue sans analyse visuelle. Ajoute la cause
 * technique lorsqu'elle est connue.
 */
export function notApplicableText(s: Snapshot): string {
  if ((s.analysisState ?? 'not_requested') !== 'not_applicable') return ''
  const base = 'Image indisponible — la session continue sans analyse visuelle.'
  return s.visualCause ? `${base} (${visualCauseMessage(s.visualCause)})` : base
}
