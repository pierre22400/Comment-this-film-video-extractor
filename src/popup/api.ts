// Le content script est bundlé en IIFE et injecté à la demande dans l'onglet
// actif (permission activeTab + scripting), plutôt que déclaré sur <all_urls>.
import contentScriptPath from '../content/index?script&iife'
import type { ContentRequest, ContentResponse, ProbeDefinition, PlanRunState } from '../lib/messages'
import type { BackgroundRequest, BackgroundResponse, AnalysisStatus } from '../lib/messages'
import type { VisualProbeRequest } from '../lib/probe'
import type { PlannerMode } from '../lib/planner'
import type { GalleryRun, Platform } from '../lib/gallery'

export async function getActiveTab(): Promise<chrome.tabs.Tab | null> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  return tab ?? null
}

/** Injecte le content script de capture dans l'onglet ciblé. */
export async function injectContentScript(tabId: number): Promise<void> {
  await chrome.scripting.executeScript({
    target: { tabId },
    files: [contentScriptPath],
  })
}

/** Envoie un message au content script de l'onglet et renvoie sa réponse. */
export function sendToTab(tabId: number, msg: ContentRequest): Promise<ContentResponse> {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, msg, (resp: ContentResponse) => {
      if (chrome.runtime.lastError) {
        resolve({
          ok: false,
          code: 'CAPTURE_ERROR',
          message:
            chrome.runtime.lastError.message ??
            "Impossible de communiquer avec l'onglet.",
        })
        return
      }
      resolve(resp)
    })
  })
}

/** Envoie un message au service worker (background). */
function sendToBackground(msg: BackgroundRequest): Promise<BackgroundResponse> {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(msg, (resp: BackgroundResponse) => {
      if (chrome.runtime.lastError) {
        resolve({ ok: false, message: chrome.runtime.lastError.message ?? 'Erreur' })
        return
      }
      resolve(resp)
    })
  })
}

/** Demande au service worker d'effacer tous les snapshots (et la file d'analyse). */
export async function clearSnapshots(): Promise<void> {
  await sendToBackground({ type: 'CLEAR' })
}

/** Lit l'état courant de l'analyse (bascule + tailles de file). */
export async function getAnalysisStatus(): Promise<AnalysisStatus | null> {
  const r = await sendToBackground({ type: 'GET_ANALYSIS_STATUS' })
  return r.ok && 'status' in r ? r.status : null
}

/** Met en file tous les snapshots non analysés. Renvoie le nombre mis en file. */
export async function enqueueUnanalyzed(): Promise<number> {
  const r = await sendToBackground({ type: 'ENQUEUE_UNANALYZED' })
  return r.ok && 'enqueued' in r ? r.enqueued : 0
}

/** Relance l'analyse d'un snapshot précis (après un échec). */
export async function retrySnapshot(id: number): Promise<void> {
  await sendToBackground({ type: 'RETRY_SNAPSHOT', id })
}

/**
 * Crée une sonde visuelle ciblée : persistée par le service worker, PUIS
 * enregistrée auprès du content script de l'onglet (qui seul observe le
 * timecode réel de la vidéo). Renvoie la sonde créée, ou null en cas d'échec.
 */
export async function createVisualProbe(
  tabId: number,
  probe: ProbeDefinition,
): Promise<VisualProbeRequest | null> {
  const created = await sendToBackground({ type: 'CREATE_VISUAL_PROBE', probe })
  if (!created.ok || !('probe' in created)) return null
  const registered = await sendToTab(tabId, {
    type: 'REGISTER_VISUAL_PROBE',
    id: created.probe.id,
    probe,
  })
  if (!registered.ok) {
    // La persistance a réussi mais la vidéo n'est pas disponible dans l'onglet :
    // on annule proprement plutôt que de laisser une sonde qui ne capturera jamais.
    await sendToBackground({ type: 'CANCEL_VISUAL_PROBE', id: created.probe.id })
    return null
  }
  return created.probe
}

/** Annule une sonde visuelle (persistance + retrait du content script). */
export async function cancelVisualProbe(tabId: number, id: string): Promise<void> {
  await sendToBackground({ type: 'CANCEL_VISUAL_PROBE', id })
  await sendToTab(tabId, { type: 'UNREGISTER_VISUAL_PROBE', id })
}

/** Liste toutes les sondes visuelles persistées (source de vérité unique). */
export async function listVisualProbes(): Promise<VisualProbeRequest[]> {
  const r = await sendToBackground({ type: 'LIST_VISUAL_PROBES' })
  return r.ok && 'probes' in r ? r.probes : []
}

// --- Scanner visuel planifié (Cycle 3) ---

/**
 * Lance l'exécution d'un plan : crée une NOUVELLE galerie côté service worker,
 * puis demande au content script de parcourir le plan dans l'onglet. Renvoie
 * l'id de galerie créé, ou null en cas d'échec (vidéo indisponible, etc.).
 */
export async function runPlan(
  tabId: number,
  params: {
    name: string
    fixtureName: string
    pageUrl: string
    pageTitle: string
    platform: Platform
    strategy: PlannerMode
    timecodes: number[]
    settleMs: number
    captureSurface?: 'video' | 'visible_tab'
  },
): Promise<string | null> {
  const created = await sendToBackground({
    type: 'CREATE_GALLERY_RUN',
    name: params.name,
    fixtureName: params.fixtureName,
    pageUrl: params.pageUrl,
    pageTitle: params.pageTitle,
    platform: params.platform,
    strategy: params.strategy,
    timecodes: params.timecodes,
  })
  if (!created.ok || !('galleryId' in created)) return null
  const galleryId = created.galleryId
  const started = await sendToTab(tabId, {
    type: 'RUN_PLAN',
    galleryId,
    timecodes: params.timecodes,
    mode: params.strategy,
    settleMs: params.settleMs,
    captureSurface: params.captureSurface,
  })
  if (!started.ok) {
    // La galerie a été créée mais la vidéo n'est pas disponible : on la finalise
    // comme annulée plutôt que de laisser une galerie « running » fantôme.
    await sendToBackground({
      type: 'FINALIZE_GALLERY_RUN',
      galleryId,
      cancelled: true,
      counters: {
        planned: params.timecodes.length,
        captured: 0,
        unavailable: 0,
        skipped: 0,
        failed: 0,
      },
      items: params.timecodes.map((requestedTime, index) => ({
        index,
        requestedTime,
        status: 'cancelled',
      })),
    })
    return null
  }
  return galleryId
}

/** Annule l'exécution du plan en cours dans l'onglet. */
export async function cancelPlan(tabId: number): Promise<void> {
  await sendToTab(tabId, { type: 'CANCEL_PLAN' })
}

/** Lit l'état en direct de l'exécution du plan dans l'onglet. */
export async function getPlanState(tabId: number): Promise<PlanRunState | null> {
  const r = await sendToTab(tabId, { type: 'GET_PLAN_STATE' })
  return r.ok && r.kind === 'PLAN' ? r.plan : null
}

/** Liste les galeries planifiées (de la plus récente à la plus ancienne). */
export async function listGalleryRuns(): Promise<GalleryRun[]> {
  const r = await sendToBackground({ type: 'LIST_GALLERY_RUNS' })
  return r.ok && 'runs' in r ? r.runs : []
}

/** Efface une galerie ciblée (enregistrement + snapshots). Renvoie le nb supprimé. */
export async function deleteGalleryRun(galleryId: string): Promise<number> {
  const r = await sendToBackground({ type: 'DELETE_GALLERY_RUN', galleryId })
  return r.ok && 'deleted' in r ? r.deleted : 0
}

/**
 * Active l'analyse Gemini pour une galerie précise : met en file uniquement ses
 * images valides. Renvoie le nombre d'images mises en file.
 */
export async function analyzeGallery(galleryId: string): Promise<number> {
  const r = await sendToBackground({ type: 'ANALYZE_GALLERY', galleryId })
  return r.ok && 'enqueued' in r ? r.enqueued : 0
}

/** Exporte une galerie (WebP + manifest.json) via téléchargements explicites. */
export async function exportGallery(galleryId: string): Promise<boolean> {
  const r = await sendToBackground({ type: 'EXPORT_GALLERY', galleryId })
  return r.ok
}
