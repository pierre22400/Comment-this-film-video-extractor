// Libellés FR du scanner visuel planifié (Cycle 3) : statuts d'items du plan,
// plateformes, résumé d'exécution. Module léger de présentation.

import type { PlannedItemStatus } from '../content/plannedCaptureRunner'
import type { GalleryRunState } from '../lib/gallery'
import { PLATFORM_LABELS } from '../lib/gallery'

export { PLATFORM_LABELS }

export type ItemChipKind = 'idle' | 'live' | 'ok' | 'na' | 'error'

export interface ItemStatusView {
  text: string
  kind: ItemChipKind
}

/** Libellé + style d'un statut d'item planifié. */
export function plannedItemView(status: PlannedItemStatus): ItemStatusView {
  switch (status) {
    case 'pending':
      return { text: 'En attente', kind: 'idle' }
    case 'seeking':
      return { text: 'Positionnement…', kind: 'live' }
    case 'capturing':
      return { text: 'Capture…', kind: 'live' }
    case 'captured':
      return { text: 'Capturé', kind: 'ok' }
    case 'skipped':
      return { text: 'Ignoré', kind: 'na' }
    case 'unavailable':
      return { text: 'Image indisponible', kind: 'na' }
    case 'failed':
      return { text: 'Échec', kind: 'error' }
    case 'cancelled':
      return { text: 'Annulé', kind: 'na' }
    default:
      return { text: status, kind: 'idle' }
  }
}

/** Libellé FR de l'état d'une galerie. */
export function galleryStateLabel(state: GalleryRunState): string {
  switch (state) {
    case 'running':
      return 'En cours'
    case 'completed':
      return 'Terminée'
    case 'cancelled':
      return 'Annulée'
    default:
      return state
  }
}
