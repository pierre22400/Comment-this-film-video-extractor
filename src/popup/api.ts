// Le content script est bundlé en IIFE et injecté à la demande dans l'onglet
// actif (permission activeTab + scripting), plutôt que déclaré sur <all_urls>.
import contentScriptPath from '../content/index?script&iife'
import type { ContentRequest, ContentResponse } from '../lib/messages'

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

/** Demande au service worker d'effacer tous les snapshots. */
export function clearSnapshots(): Promise<void> {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: 'CLEAR' }, () => resolve())
  })
}
