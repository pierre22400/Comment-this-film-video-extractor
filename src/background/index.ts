import {
  addSnapshot,
  clearAll,
  claimForAnalysis,
  updateAnalysisFields,
  markQueued,
  getUnanalyzedIds,
  getResumableIds,
  createProbe,
  updateProbe,
  cancelProbe,
  listProbes,
  claimProbeForAnalysis,
  getSnapshot,
  getResumableProbeIds,
} from '../lib/snapshotStore'
import type { BackgroundRequest, BackgroundResponse, AnalysisStatus } from '../lib/messages'
import type { Snapshot } from '../lib/types'
import { AnalysisQueue, type DescribeOutcome } from './analysisQueue'
import { VisualProbeQueue, type ProbeOutcome, type ClaimedProbeJob } from './visualProbeQueue'
import type { DescribeSuccessBody, DescribeErrorBody } from '../lib/analysis'
import { isAnalyzable, visualCauseMessage, type VisualUnavailableCause } from '../lib/visual'
import { validateProbeDefinition, type ProbeSuccessBody, type ProbeErrorBody } from '../lib/probe'

// Service worker MV3 : reçoit les images du content script (data URL), les
// convertit en Blob et les stocke dans IndexedDB. Il pilote deux files
// d'analyse Gemini DISTINCTES via un relais LOCAL (la clé Gemini n'est jamais
// ici) :
//  - la file de DIAGNOSTIC MANUEL (/api/describe) — actions explicites
//    uniquement, jamais déclenchée par une capture périodique ;
//  - la file des SONDES VISUELLES ciblées (/api/visual-probe) — déclenchée
//    uniquement par une capture RÉUSSIE dans la fenêtre d'une sonde créée
//    explicitement par l'utilisateur.
// Aucune capture périodique classique n'envoie jamais d'image à Gemini.

const RELAY_DESCRIBE_URL = 'http://127.0.0.1:8787/api/describe'
const RELAY_PROBE_URL = 'http://127.0.0.1:8787/api/visual-probe'
const REQUEST_TIMEOUT_MS = 20_000

// Génération : incrémentée à chaque effacement pour neutraliser les réponses
// tardives (une réponse en vol ne peut pas ressusciter un snapshot/une sonde effacés).
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

async function fetchJson<TSuccess, TError>(
  url: string,
  body: unknown,
): Promise<{ res: Response; json: TSuccess | TError | null }> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    })
    const json = (await res.json().catch(() => null)) as TSuccess | TError | null
    return { res, json }
  } finally {
    clearTimeout(timer)
  }
}

function networkOutcome(e: unknown): { code: string; message: string } {
  const aborted = e instanceof DOMException && e.name === 'AbortError'
  return {
    code: aborted ? 'TIMEOUT' : 'NETWORK',
    message: aborted ? 'Délai dépassé.' : 'Relais local injoignable.',
  }
}

/** Appel réseau au relais local /api/describe, converti en DescribeOutcome. */
async function describeViaRelay(req: {
  snapshotId: number
  mediaTime: number
  mimeType: string
  imageBase64: string
}): Promise<DescribeOutcome> {
  try {
    const { res, json } = await fetchJson<DescribeSuccessBody, DescribeErrorBody>(
      RELAY_DESCRIBE_URL,
      req,
    )
    if (res.ok && json && 'description' in json && typeof json.description === 'string') {
      return { ok: true, description: json.description, model: json.model, latencyMs: json.latencyMs }
    }
    if (json && 'error' in json) {
      return {
        ok: false,
        code: json.error.code,
        message: json.error.message,
        retryable: Boolean(json.error.retryable),
      }
    }
    return { ok: false, code: 'UPSTREAM_ERROR', message: `HTTP ${res.status}`, retryable: true }
  } catch (e) {
    const { code, message } = networkOutcome(e)
    return { ok: false, code, message, retryable: true }
  }
}

/** Appel réseau au relais local /api/visual-probe, converti en ProbeOutcome. */
async function probeViaRelay(req: {
  probeId: string
  snapshotId: number
  mediaTime: number
  mimeType: string
  imageBase64: string
  purpose: string
  question: string
}): Promise<ProbeOutcome> {
  try {
    const { res, json } = await fetchJson<ProbeSuccessBody, ProbeErrorBody>(RELAY_PROBE_URL, req)
    if (res.ok && json && 'answer' in json) {
      return {
        ok: true,
        answer: json.answer,
        observations: json.observations,
        confidence: json.confidence,
        limitations: json.limitations,
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
    return { ok: false, code: 'UPSTREAM_ERROR', message: `HTTP ${res.status}`, retryable: true }
  } catch (e) {
    const { code, message } = networkOutcome(e)
    return { ok: false, code, message, retryable: true }
  }
}

// File de diagnostic manuel (describe) : dépendances branchées sur IndexedDB
// et le relais. Déclenchée UNIQUEMENT par une action explicite du popup.
const analysisQueue = new AnalysisQueue({
  async claim(id) {
    const snap = await claimForAnalysis(id)
    if (!snap) return null
    const attempts = snap.analysisAttempts ?? 0
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
    return { mediaTime: snap.mediaTime, mimeType: snap.mimeType, imageBase64, attempts }
  },
  describe: describeViaRelay,
  async save(id, patch) {
    await updateAnalysisFields(id, patch)
  },
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  now: () => Date.now(),
  epoch: () => epoch,
})

// File des sondes visuelles ciblées : déclenchée UNIQUEMENT par une capture
// réussie dans la fenêtre d'une sonde créée explicitement par l'utilisateur.
const probeQueue = new VisualProbeQueue({
  async claim(id) {
    const claimedProbe = await claimProbeForAnalysis(id)
    if (!claimedProbe || claimedProbe.snapshotId === undefined) return null
    const snap = await getSnapshot(claimedProbe.snapshotId)
    if (!snap) return null

    const availability = snap.visualAvailability ?? 'available'
    if (!isAnalyzable(availability) || snap.image.size === 0) {
      const cause: VisualUnavailableCause =
        snap.visualCause ?? (snap.image.size === 0 ? 'image_empty' : 'unsupported')
      const claimed: ClaimedProbeJob = {
        snapshotId: snap.id,
        mediaTime: snap.mediaTime,
        mimeType: snap.mimeType,
        imageBase64: '',
        purpose: claimedProbe.purpose,
        question: claimedProbe.question,
        unavailable: { cause, message: visualCauseMessage(cause) },
      }
      return claimed
    }

    const imageBase64 = await blobToBase64(snap.image)
    return {
      snapshotId: snap.id,
      mediaTime: snap.mediaTime,
      mimeType: snap.mimeType,
      imageBase64,
      purpose: claimedProbe.purpose,
      question: claimedProbe.question,
    }
  },
  probe: probeViaRelay,
  async save(id, patch) {
    await updateProbe(id, patch)
  },
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  now: () => Date.now(),
  epoch: () => epoch,
})

function currentStatus(): AnalysisStatus {
  return { queued: analysisQueue.size, analyzing: analysisQueue.activeCount }
}

/** Met en file puis lance l'analyse d'un ensemble d'ids (diagnostic manuel). */
async function enqueueIds(ids: number[]): Promise<number> {
  let n = 0
  for (const id of ids) {
    if (await markQueued(id)) n += 1
  }
  analysisQueue.enqueueMany(ids)
  return n
}

// Récupération au réveil du service worker : reprendre les travaux de
// diagnostic manuel restés 'queued'/'analyzing', ET les sondes visuelles
// restées 'captured'/'analyzing' — jamais de nouvelle capture automatique.
void (async () => {
  const resumable = await getResumableIds()
  if (resumable.length > 0) analysisQueue.enqueueMany(resumable)
  const resumableProbes = await getResumableProbeIds()
  for (const id of resumableProbes) probeQueue.enqueue(id)
})()

chrome.runtime.onMessage.addListener(
  (msg: BackgroundRequest, _sender, sendResponse: (r: BackgroundResponse) => void) => {
    void (async () => {
      try {
        switch (msg.type) {
          case 'SAVE_SNAPSHOT': {
            const blob = await dataUrlToBlob(msg.dataUrl)
            // Une image marquée non exploitable à la capture (ex : frame
            // suspecte) est stockée avec sa cause mais jamais envoyée à
            // Gemini — état 'not_applicable', et non 'not_requested'. AUCUNE
            // capture périodique classique n'est jamais mise en file d'analyse
            // automatiquement (diagnostic manuel = action explicite seulement).
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
              captureOrigin: msg.meta.captureOrigin ?? 'periodic',
              probeId: msg.meta.probeId,
              analysisErrorMessage: analyzable
                ? undefined
                : visualCauseMessage(msg.meta.visualCause ?? 'unsupported'),
            }
            const id = await addSnapshot(snapshot)
            sendResponse({ ok: true, id })
            break
          }
          case 'CLEAR': {
            // Invalide les réponses en vol, vide les deux files, puis efface la base.
            epoch += 1
            analysisQueue.clear()
            probeQueue.clear()
            await clearAll()
            sendResponse({ ok: true })
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
            analysisQueue.enqueue(msg.id)
            sendResponse({ ok: true, status: currentStatus() })
            break
          }
          case 'CREATE_VISUAL_PROBE': {
            const valid = validateProbeDefinition(msg.probe)
            if (!valid.ok) {
              sendResponse({ ok: false, message: valid.message })
              break
            }
            const id = crypto.randomUUID()
            const probe = {
              id,
              startTime: valid.value.startTime,
              endTime: valid.value.endTime,
              preferredTime: valid.value.preferredTime,
              purpose: valid.value.purpose,
              question: valid.value.question,
              maxCaptures: valid.value.maxCaptures,
              status: 'scheduled' as const,
              createdAt: new Date().toISOString(),
            }
            await createProbe(probe)
            sendResponse({ ok: true, probe })
            break
          }
          case 'CANCEL_VISUAL_PROBE': {
            await cancelProbe(msg.id)
            sendResponse({ ok: true })
            break
          }
          case 'LIST_VISUAL_PROBES': {
            const probes = await listProbes()
            sendResponse({ ok: true, probes })
            break
          }
          case 'PROBE_STATUS_UPDATE': {
            // Transition de phase de capture (scheduled/waiting/capturing) —
            // purement informative, jamais un déclenchement d'analyse.
            await updateProbe(msg.id, { status: msg.status })
            sendResponse({ ok: true })
            break
          }
          case 'PROBE_CAPTURED': {
            const blob = await dataUrlToBlob(msg.dataUrl)
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
              captureOrigin: 'visual_probe',
              probeId: msg.id,
            }
            const snapshotId = await addSnapshot(snapshot)
            if (analyzable) {
              await updateProbe(msg.id, {
                status: 'captured',
                snapshotId,
                actualCaptureTime: msg.actualCaptureTime,
                captureAttempts: msg.captureAttempts,
              })
              probeQueue.enqueue(msg.id)
            } else {
              const cause = msg.meta.visualCause ?? 'unsupported'
              await updateProbe(msg.id, {
                status: 'unavailable',
                snapshotId,
                actualCaptureTime: msg.actualCaptureTime,
                captureAttempts: msg.captureAttempts,
                failureReason: visualCauseMessage(cause),
                visualCause: cause,
              })
            }
            sendResponse({ ok: true, id: snapshotId })
            break
          }
          case 'PROBE_UNAVAILABLE': {
            // Aucune image n'a jamais pu être obtenue (capture bloquée/erreur
            // répétée) : aucun snapshot créé, jamais envoyé à Gemini.
            await updateProbe(msg.id, {
              status: 'unavailable',
              captureAttempts: msg.captureAttempts,
              failureReason: visualCauseMessage(msg.cause as VisualUnavailableCause),
              visualCause: msg.cause,
            })
            sendResponse({ ok: true })
            break
          }
          case 'PROBE_MISSED': {
            await updateProbe(msg.id, {
              status: 'missed',
              captureAttempts: msg.captureAttempts,
              failureReason: 'Fenêtre de capture dépassée sans image exploitable.',
            })
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
