import { addSnapshot, clearAll } from '../lib/snapshotStore'
import type { BackgroundRequest, BackgroundResponse } from '../lib/messages'
import type { Snapshot } from '../lib/types'

// Service worker MV3 : reçoit les images du content script (data URL), les
// convertit en Blob et les stocke dans IndexedDB (origine de l'extension).
// Aucune connexion réseau externe.

async function dataUrlToBlob(dataUrl: string): Promise<Blob> {
  const res = await fetch(dataUrl)
  return res.blob()
}

chrome.runtime.onMessage.addListener(
  (msg: BackgroundRequest, _sender, sendResponse: (r: BackgroundResponse) => void) => {
    void (async () => {
      try {
        switch (msg.type) {
          case 'SAVE_SNAPSHOT': {
            const blob = await dataUrlToBlob(msg.dataUrl)
            const snapshot: Omit<Snapshot, 'id'> = {
              capturedAt: msg.meta.capturedAt,
              mediaTime: msg.meta.mediaTime,
              pageTitle: msg.meta.pageTitle,
              pageUrl: msg.meta.pageUrl,
              videoWidth: msg.meta.videoWidth,
              videoHeight: msg.meta.videoHeight,
              mimeType: msg.meta.imageFormat,
              image: blob,
            }
            const id = await addSnapshot(snapshot)
            sendResponse({ ok: true, id })
            break
          }
          case 'CLEAR': {
            await clearAll()
            sendResponse({ ok: true })
            break
          }
          default: {
            sendResponse({ ok: false, message: 'Message inconnu' })
          }
        }
      } catch (err) {
        sendResponse({
          ok: false,
          message: err instanceof Error ? err.message : String(err),
        })
      }
    })()
    // Indispensable pour une réponse asynchrone.
    return true
  },
)
