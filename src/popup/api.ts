// Le content script est bundlé en IIFE et injecté à la demande dans l'onglet
// actif (permission activeTab + scripting), plutôt que déclaré sur <all_urls>.
import contentScriptPath from '../content/index?script&iife'
import type { ContentRequest, ContentResponse } from '../lib/messages'
import type { BackgroundRequest, BackgroundResponse, AnalysisStatus } from '../lib/messages'

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

/** Active/désactive l'analyse Gemini automatique des nouveaux snapshots. */
export async function setAnalysisEnabled(enabled: boolean): Promise<AnalysisStatus | null> {
  const r = await sendToBackground({ type: 'SET_ANALYSIS_ENABLED', enabled })
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
