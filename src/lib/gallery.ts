// Contrat de la GALERIE PLANIFIÉE (GalleryRun) — module PUR (aucune dépendance
// chrome/DOM/Node), partagé par le service worker, le popup et les tests.
//
// Une exécution de plan crée TOUJOURS une nouvelle galerie (`GalleryRun`) : un
// enregistrement persistant qui regroupe les snapshots capturés lors de cette
// exécution, avec ses compteurs, sa plateforme détectée, sa stratégie et son
// état. La galerie « gérée par l'extension » est IndexedDB ; l'export vers
// Téléchargements est une action explicite distincte (voir export).

import type { PlannerMode } from './planner'

/** Plateforme détectée pour l'onglet capturé (repli HTML5 générique). */
export type Platform = 'youtube' | 'prime' | 'html5'

export const PLATFORMS: readonly Platform[] = ['youtube', 'prime', 'html5']

/** Libellés FR par plateforme (UI). */
export const PLATFORM_LABELS: Record<Platform, string> = {
  youtube: 'YouTube',
  prime: 'Prime Video',
  html5: 'Vidéo HTML5',
}

/**
 * État d'une exécution de galerie :
 * - running   : capture du plan en cours.
 * - completed : toutes les captures du plan ont été traitées (résultat quelconque).
 * - cancelled : exécution interrompue explicitement par l'utilisateur.
 */
export type GalleryRunState = 'running' | 'completed' | 'cancelled'

export const GALLERY_RUN_STATES: readonly GalleryRunState[] = ['running', 'completed', 'cancelled']

/** Compteurs agrégés d'une galerie (mis à jour au fil de l'exécution). */
export interface GalleryCounters {
  /** Nombre de timecodes planifiés (taille du plan résolu). */
  planned: number
  /** Captures exploitables stockées (image `available`). */
  captured: number
  /** Images suspectes/indisponibles stockées mais non analysables. */
  unavailable: number
  /** Timecodes ignorés (hors durée, doublon tardif) sans capture. */
  skipped: number
  /** Échecs de capture définitifs (aucune image obtenue). */
  failed: number
}

export function emptyCounters(planned = 0): GalleryCounters {
  return { planned, captured: 0, unavailable: 0, skipped: 0, failed: 0 }
}

/** Un enregistrement de galerie planifiée, persisté dans IndexedDB. */
export interface GalleryRun {
  id: string
  name: string
  createdAt: string
  pageUrl: string
  pageTitle: string
  platform: Platform
  /** Nom du plan (fixture) exécuté. */
  fixtureName: string
  /** Stratégie de parcours effectivement utilisée. */
  strategy: PlannerMode
  state: GalleryRunState
  counters: GalleryCounters
  /**
   * Analyse Gemini demandée pour CETTE galerie (désactivée par défaut).
   * Renseigné uniquement quand l'utilisateur active explicitement l'analyse.
   */
  geminiRequestedAt?: string
}

/** Total des captures physiquement stockées (exploitables + non exploitables). */
export function totalStored(c: GalleryCounters): number {
  return c.captured + c.unavailable
}

/** Une galerie est terminée si son état n'est plus « running ». */
export function isGalleryFinished(run: GalleryRun): boolean {
  return run.state !== 'running'
}
