// Le content script est bundlé en IIFE et injecté à la demande dans l'onglet
// actif (permission activeTab + scripting), plutôt que déclaré sur <all_urls>.
import contentScriptPath from '../content/index?script&iife'
import type { ContentRequest, ContentResponse, ProbeDefinition } from '../lib/messages'
import type { BackgroundRequest, BackgroundResponse, AnalysisStatus } from '../lib/messages'
import type { VisualProbeRequest } from '../lib/probe'

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
