// Planner JSON v1 — module PUR (aucune dépendance chrome/DOM/Node), partagé par
// le popup (validation + aperçu), le content script (exécution) et les tests.
//
// Un « plan de captures » décrit une liste de timecodes auxquels le scanner
// visuel planifié (Cycle 3) doit capturer une image. Le plan est purement
// déclaratif : il ne contourne AUCUNE protection (DRM/EME/CORS/HDCP) et
// n'extrait aucun flux vidéo. Il ne fait qu'indiquer OÙ regarder dans le temps.
//
// Deux formes d'items sont acceptées :
//  - item ponctuel :   { "at": "00:00:30" }
//  - rafale (burst) :   { "from": "00:05:00", "count": 10, "everySeconds": 5 }
//
// Les rafales sont développées de façon DÉTERMINISTE, puis l'ensemble des
// timecodes est trié et dédupliqué avec une tolérance documentée.

/** Tolérance de déduplication : deux timecodes à moins de 50 ms sont fusionnés. */
export const DEDUP_TOLERANCE_SECONDS = 0.05

/** Nombre maximal de captures autorisées dans un plan résolu. */
export const MAX_PLAN_CAPTURES = 500

/** Nombre maximal d'items bruts (bornage défensif avant expansion des rafales). */
export const MAX_PLAN_ITEMS = 500

/** Bornes du délai de stabilisation après un seek (avant capture). */
export const MIN_SETTLE_MS = 0
export const MAX_SETTLE_MS = 5000
export const DEFAULT_SETTLE_MS = 400

/** Stratégies de parcours du plan. */
export type PlannerMode = 'seek' | 'playback'
export const PLANNER_MODES: readonly PlannerMode[] = ['seek', 'playback']

/** Item ponctuel : une seule capture à l'instant `at`. */
export interface PlannerItemPoint {
  at: string | number
}

/** Item rafale : `count` captures à partir de `from`, espacées de `everySeconds`. */
export interface PlannerItemBurst {
  from: string | number
  count: number
  everySeconds: number
}

export type PlannerItem = PlannerItemPoint | PlannerItemBurst

/** Plan brut tel que collé par l'utilisateur (avant validation). */
export interface PlannerDocument {
  version: number
  name?: string
  mode?: PlannerMode
  settleMs?: number
  items: PlannerItem[]
}

/** Un plan validé et résolu, prêt à être exécuté. */
export interface ResolvedPlan {
  name: string
  mode: PlannerMode
  settleMs: number
  /** Timecodes en secondes, triés croissants et dédupliqués (tolérance documentée). */
  timecodes: number[]
}

export type PlannerResult =
  | { ok: true; plan: ResolvedPlan }
  | { ok: false; message: string }

const HHMMSS = /^(\d{1,2}):([0-5]?\d):([0-5]?\d)(?:\.(\d{1,3}))?$/

/**
 * Analyse un timecode. Accepte :
 *  - une chaîne `HH:MM:SS(.mmm)` (ex : "01:02:03.250") ;
 *  - une chaîne de secondes positives (ex : "42", "42.5") ;
 *  - un nombre de secondes positif fini.
 * Renvoie null si l'entrée est invalide (négative, non finie, mal formée).
 */
export function parseTimecode(input: string | number): number | null {
  if (typeof input === 'number') {
    return Number.isFinite(input) && input >= 0 ? input : null
  }
  if (typeof input !== 'string') return null
  const trimmed = input.trim()
  if (trimmed.length === 0) return null

  const m = HHMMSS.exec(trimmed)
  if (m) {
    const h = Number(m[1])
    const min = Number(m[2])
    const sec = Number(m[3])
    const ms = m[4] ? Number(m[4].padEnd(3, '0')) : 0
    return h * 3600 + min * 60 + sec + ms / 1000
  }

  // Repli : secondes décimales pures (jamais de notation négative/exponentielle).
  if (/^\d+(\.\d+)?$/.test(trimmed)) {
    const seconds = Number(trimmed)
    return Number.isFinite(seconds) && seconds >= 0 ? seconds : null
  }
  return null
}

function isPointItem(item: PlannerItem): item is PlannerItemPoint {
  return typeof (item as PlannerItemPoint).at !== 'undefined'
}

function isBurstItem(item: PlannerItem): item is PlannerItemBurst {
  const b = item as PlannerItemBurst
  return typeof b.from !== 'undefined' || typeof b.count !== 'undefined' || typeof b.everySeconds !== 'undefined'
}

/**
 * Développe un item en une liste de timecodes (secondes), de façon
 * DÉTERMINISTE. Renvoie une erreur lisible si l'item est mal formé.
 */
function expandItem(item: PlannerItem, index: number): { ok: true; times: number[] } | { ok: false; message: string } {
  if (item === null || typeof item !== 'object') {
    return { ok: false, message: `Item #${index + 1} : objet attendu.` }
  }

  if (isPointItem(item) && !('from' in item)) {
    const t = parseTimecode(item.at)
    if (t === null) return { ok: false, message: `Item #${index + 1} : timecode « at » invalide.` }
    return { ok: true, times: [t] }
  }

  if (isBurstItem(item)) {
    const b = item as PlannerItemBurst
    const from = parseTimecode(b.from)
    if (from === null) return { ok: false, message: `Item #${index + 1} : « from » invalide.` }
    if (typeof b.count !== 'number' || !Number.isInteger(b.count) || b.count < 1) {
      return { ok: false, message: `Item #${index + 1} : « count » doit être un entier ≥ 1.` }
    }
    if (b.count > MAX_PLAN_CAPTURES) {
      return { ok: false, message: `Item #${index + 1} : « count » dépasse ${MAX_PLAN_CAPTURES}.` }
    }
    if (typeof b.everySeconds !== 'number' || !Number.isFinite(b.everySeconds) || b.everySeconds <= 0) {
      return { ok: false, message: `Item #${index + 1} : « everySeconds » doit être un nombre > 0.` }
    }
    const times: number[] = []
    for (let i = 0; i < b.count; i += 1) {
      // Arrondi milliseconde pour éviter la dérive en virgule flottante et
      // garantir un développement STRICTEMENT reproductible.
      times.push(Math.round((from + i * b.everySeconds) * 1000) / 1000)
    }
    return { ok: true, times }
  }

  return { ok: false, message: `Item #${index + 1} : ni « at » ni rafale (« from »/« count »/« everySeconds »).` }
}

/**
 * Trie croissant puis déduplique une liste de timecodes avec la tolérance
 * documentée (`DEDUP_TOLERANCE_SECONDS`). Deux timecodes distants de moins de
 * la tolérance sont considérés identiques ; on conserve le premier rencontré.
 */
export function sortAndDedupe(times: number[], tolerance = DEDUP_TOLERANCE_SECONDS): number[] {
  const sorted = [...times].sort((a, b) => a - b)
  const out: number[] = []
  for (const t of sorted) {
    const last = out[out.length - 1]
    if (last === undefined || t - last > tolerance) out.push(t)
  }
  return out
}

/**
 * Valide et résout un document de plan (objet déjà parsé depuis JSON).
 * Bornes appliquées : version === 1, items non vide, ≤ 500 items bruts,
 * plan résolu ≤ 500 captures. Si `knownDuration` est fourni, tout timecode
 * strictement supérieur à la durée connue est REJETÉ (hors durée).
 */
export function resolvePlan(doc: unknown, knownDuration?: number | null): PlannerResult {
  if (doc === null || typeof doc !== 'object') {
    return { ok: false, message: 'Plan JSON attendu (objet).' }
  }
  const d = doc as Record<string, unknown>

  if (d.version !== 1) {
    return { ok: false, message: 'Version de plan non prise en charge (attendu : 1).' }
  }

  let mode: PlannerMode = 'seek'
  if (d.mode !== undefined) {
    if (typeof d.mode !== 'string' || !PLANNER_MODES.includes(d.mode as PlannerMode)) {
      return { ok: false, message: '« mode » doit valoir « seek » ou « playback ».' }
    }
    mode = d.mode as PlannerMode
  }

  let settleMs = DEFAULT_SETTLE_MS
  if (d.settleMs !== undefined) {
    if (
      typeof d.settleMs !== 'number' ||
      !Number.isFinite(d.settleMs) ||
      d.settleMs < MIN_SETTLE_MS ||
      d.settleMs > MAX_SETTLE_MS
    ) {
      return { ok: false, message: `« settleMs » doit être compris entre ${MIN_SETTLE_MS} et ${MAX_SETTLE_MS}.` }
    }
    settleMs = d.settleMs
  }

  const name =
    typeof d.name === 'string' && d.name.trim().length > 0 ? d.name.trim().slice(0, 120) : 'plan-sans-nom'

  if (!Array.isArray(d.items)) {
    return { ok: false, message: '« items » doit être un tableau.' }
  }
  if (d.items.length === 0) {
    return { ok: false, message: 'Le plan est vide (aucun item).' }
  }
  if (d.items.length > MAX_PLAN_ITEMS) {
    return { ok: false, message: `Trop d’items (${d.items.length} > ${MAX_PLAN_ITEMS}).` }
  }

  const all: number[] = []
  for (let i = 0; i < d.items.length; i += 1) {
    const expanded = expandItem(d.items[i] as PlannerItem, i)
    if (!expanded.ok) return { ok: false, message: expanded.message }
    all.push(...expanded.times)
    // Bornage précoce : évite d'accumuler un développement gigantesque en mémoire.
    if (all.length > MAX_PLAN_CAPTURES * 4) {
      return { ok: false, message: `Le plan développé dépasse ${MAX_PLAN_CAPTURES} captures.` }
    }
  }

  const timecodes = sortAndDedupe(all)

  if (timecodes.length === 0) {
    return { ok: false, message: 'Le plan résolu ne contient aucune capture.' }
  }
  if (timecodes.length > MAX_PLAN_CAPTURES) {
    return {
      ok: false,
      message: `Le plan résolu contient ${timecodes.length} captures (> ${MAX_PLAN_CAPTURES}).`,
    }
  }

  if (typeof knownDuration === 'number' && Number.isFinite(knownDuration) && knownDuration > 0) {
    // Tolérance d'une demi-seconde au-delà de la durée connue (imprécision des
    // métadonnées de durée selon les lecteurs). Au-delà : hors durée, rejeté.
    const overshoot = timecodes.filter((t) => t > knownDuration + 0.5)
    if (overshoot.length > 0) {
      return {
        ok: false,
        message: `Le plan contient ${overshoot.length} timecode(s) au-delà de la durée connue (${knownDuration.toFixed(1)} s).`,
      }
    }
  }

  return { ok: true, plan: { name, mode, settleMs, timecodes } }
}

/**
 * Analyse une chaîne JSON PUIS résout le plan. Sépare proprement l'erreur de
 * syntaxe JSON (message dédié) de l'erreur de validation sémantique.
 */
export function parseAndResolvePlan(jsonText: string, knownDuration?: number | null): PlannerResult {
  let parsed: unknown
  try {
    parsed = JSON.parse(jsonText)
  } catch {
    return { ok: false, message: 'JSON invalide : vérifiez la syntaxe (accolades, virgules, guillemets).' }
  }
  return resolvePlan(parsed, knownDuration)
}
