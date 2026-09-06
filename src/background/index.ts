import {
  addSnapshot,
  clearAll,
  claimForAnalysis,
  updateAnalysisFields,
  markQueued,
  getUnanalyzedIds,
  getResumableIds,
} from '../lib/snapshotStore'
import type { BackgroundRequest, BackgroundResponse, AnalysisStatus } from '../lib/messages'
import type { Snapshot } from '../lib/types'
import { AnalysisQueue, type DescribeOutcome } from './analysisQueue'
import type { DescribeSuccessBody, DescribeErrorBody } from '../lib/analysis'
import { isAnalyzable, visualCauseMessage, type VisualUnavailableCause } from '../lib/visual'

// Service worker MV3 : reçoit les images du content script (data URL), les
// convertit en Blob et les stocke dans IndexedDB. Au Cycle 2, il pilote aussi la
// file d'analyse Gemini via un relais LOCAL (la clé Gemini n'est jamais ici).

// Relais local ciblé par host_permissions. La clé reste côté serveur.
const RELAY_URL = 'http://127.0.0.1:8787/api/describe'
const REQUEST_TIMEOUT_MS = 20_000
const ANALYSIS_ENABLED_KEY = 'analysisEnabled'

// Bascule d'analyse (désactivée par défaut pour éviter tout appel involontaire).
let analysisEnabled = false

// Génération : incrémentée à chaque effacement pour neutraliser les réponses
// tardives (une réponse en vol ne peut pas ressusciter un snapshot effacé).
let epoch = 0

async function dataUrlToBlob(dataUrl: string): Promise<Blob> {
  const res = await fetch(dataUrl)
  return res.blob()
}

/** Encode un Blob en base64 (sans préfixe data:) dans le service worker. */
async function blobToBase64(blob: Blob): Promise<string> {
  const buffer = await blob.arrayBuffer()
  const bytes = new Uint8Array(buffer)
  let binary = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  return btoa(binary)
}

/** Appel réseau au relais local, avec timeout, converti en DescribeOutcome. */
async function describeViaRelay(req: {
  snapshotId: number
  mediaTime: number
  mimeType: string
  imageBase64: string
}): Promise<DescribeOutcome> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  try {
    const res = await fetch(RELAY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req),
      signal: controller.signal,
    })
    const json = (await res.json().catch(() => null)) as
      | DescribeSuccessBody
      | DescribeErrorBody
      | null

    if (res.ok && json && 'description' in json && typeof json.description === 'string') {
      return {
        ok: true,
        description: json.description,
        model: json.model,
        latencyMs: json.latencyMs,
      }
    }
    if (json && 'error' in json) {
      return {
        ok: false,
        code: json.error.code,
        message: json.error.message,
        retryable: Boolean(json.error.retryable),
      }
    }
    // Réponse inattendue : traitée comme transitoire.
    return { ok: false, code: 'UPSTREAM_ERROR', message: `HTTP ${res.status}`, retryable: true }
  } catch (e) {
    // Timeout (abort) ou erreur réseau (relais absent) : transitoire.
    const aborted = e instanceof DOMException && e.name === 'AbortError'
    return {
      ok: false,
      code: aborted ? 'TIMEOUT' : 'NETWORK',
      message: aborted ? 'Délai dépassé.' : 'Relais local injoignable.',
      retryable: true,
    }
  } finally {
    clearTimeout(timer)
  }
}

// File d'analyse : dépendances branchées sur IndexedDB et le relais.
const queue = new AnalysisQueue({
  async claim(id) {
    const snap = await claimForAnalysis(id)
    if (!snap) return null
    const attempts = snap.analysisAttempts ?? 0
    // Amendement : une image non exploitable n'est jamais envoyée à Gemini.
    const availability = snap.visualAvailability ?? 'available'
    if (!isAnalyzable(availability) || snap.image.size === 0) {
      const cause: VisualUnavailableCause =
        snap.visualCause ?? (snap.image.size === 0 ? 'image_empty' : 'unsupported')
      return {
        mediaTime: snap.mediaTime,
        mimeType: snap.mimeType,
        imageBase64: '',
        attempts,
        unanalyzable: {
          availability: availability === 'available' ? 'unavailable' : availability,
          cause,
          message: visualCauseMessage(cause),
        },
      }
    }
    const imageBase64 = await blobToBase64(snap.image)
    return {
      mediaTime: snap.mediaTime,
      mimeType: snap.mimeType,
      imageBase64,
      attempts,
    }
  },
  describe: describeViaRelay,
  async save(id, patch) {
    await updateAnalysisFields(id, patch)
  },
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  now: () => Date.now(),
  epoch: () => epoch,
})

async function loadAnalysisEnabled(): Promise<void> {
  const stored = await chrome.storage.local.get(ANALYSIS_ENABLED_KEY)
  analysisEnabled = Boolean(stored[ANALYSIS_ENABLED_KEY])
}

// Réagit aux changements de la bascule effectués depuis le popup.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && ANALYSIS_ENABLED_KEY in changes) {
    analysisEnabled = Boolean(changes[ANALYSIS_ENABLED_KEY].newValue)
  }
})

function currentStatus(): AnalysisStatus {
  return { enabled: analysisEnabled, queued: queue.size, analyzing: queue.activeCount }
}

/** Met en file puis lance l'analyse d'un ensemble d'ids. */
async function enqueueIds(ids: number[]): Promise<number> {
  let n = 0
  for (const id of ids) {
    if (await markQueued(id)) n += 1
  }
  queue.enqueueMany(ids)
  return n
}

// Récupération au réveil du service worker : reprendre les travaux 'queued'
// (et les 'analyzing' interrompus, remis en file par getResumableIds).
void (async () => {
  await loadAnalysisEnabled()
  const resumable = await getResumableIds()
  if (resumable.length > 0) queue.enqueueMany(resumable)
})()

chrome.runtime.onMessage.addListener(
  (msg: BackgroundRequest, _sender, sendResponse: (r: BackgroundResponse) => void) => {
    void (async () => {
      try {
        switch (msg.type) {
          case 'SAVE_SNAPSHOT': {
            const blob = await dataUrlToBlob(msg.dataUrl)
            // Amendement : une image marquée non exploitable à la capture (ex :
            // frame suspecte) est stockée avec sa cause mais jamais envoyée à
            // Gemini — état 'not_applicable', et non 'not_requested'.
            const availability = msg.meta.visualAvailability ?? 'available'
            const analyzable = isAnalyzable(availability)
            const snapshot: Omit<Snapshot, 'id'> = {
              capturedAt: msg.meta.capturedAt,
              mediaTime: msg.meta.mediaTime,
              pageTitle: msg.meta.pageTitle,
              pageUrl: msg.meta.pageUrl,
              videoWidth: msg.meta.videoWidth,
              videoHeight: msg.meta.videoHeight,
              mimeType: msg.meta.imageFormat,
              image: blob,
              analysisState: analyzable ? 'not_requested' : 'not_applicable',
              visualAvailability: msg.meta.visualAvailability,
              visualCause: msg.meta.visualCause,
              analysisErrorMessage: analyzable
                ? undefined
                : visualCauseMessage(msg.meta.visualCause ?? 'unsupported'),
            }
            const id = await addSnapshot(snapshot)
            // Analyse automatique uniquement si activée ET si l'image est exploitable.
            if (analysisEnabled && analyzable) {
              await markQueued(id)
              queue.enqueue(id)
            }
            sendResponse({ ok: true, id })
            break
          }
          case 'CLEAR': {
            // Invalide les réponses en vol, vide la file, puis efface la base.
            epoch += 1
            queue.clear()
            await clearAll()
            sendResponse({ ok: true })
            break
          }
          case 'SET_ANALYSIS_ENABLED': {
            analysisEnabled = msg.enabled
            await chrome.storage.local.set({ [ANALYSIS_ENABLED_KEY]: msg.enabled })
            sendResponse({ ok: true, status: currentStatus() })
            break
          }
          case 'GET_ANALYSIS_STATUS': {
            sendResponse({ ok: true, status: currentStatus() })
            break
          }
          case 'ENQUEUE_UNANALYZED': {
            const ids = await getUnanalyzedIds()
            const enqueued = await enqueueIds(ids)
            sendResponse({ ok: true, enqueued })
            break
          }
          case 'RETRY_SNAPSHOT': {
            await markQueued(msg.id)
            queue.enqueue(msg.id)
            sendResponse({ ok: true, status: currentStatus() })
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
