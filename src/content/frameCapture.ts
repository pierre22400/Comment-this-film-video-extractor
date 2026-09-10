import { CaptureError } from '../lib/errors'
import type { FrameStats } from '../lib/visual'

// Capture d'une frame : HTMLVideoElement -> Canvas -> drawImage -> WebP.

const MAX_W = 1280
const MAX_H = 720
const QUALITY = 0.8

/** Résultat d'une capture : image encodée + statistiques de luminance (si lisibles). */
export interface CaptureResult {
  dataUrl: string
  stats: FrameStats | null
}

/**
 * Statistiques de luminance échantillonnées depuis le canvas déjà dessiné.
 * Renvoie null si les pixels ne sont pas lisibles (canvas protégé) — dans ce cas
 * la protection se manifeste de toute façon aussi via toDataURL.
 */
export function computeFrameStats(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
): FrameStats | null {
  if (width <= 0 || height <= 0) return null
  try {
    const { data } = ctx.getImageData(0, 0, width, height)
    let sum = 0
    let sumSq = 0
    let n = 0
    // Échantillonnage 1 pixel sur 16 : suffisant pour luminance moyenne + variance.
    const step = 4 * 16
    for (let i = 0; i + 2 < data.length; i += step) {
      const luma = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]
      sum += luma
      sumSq += luma * luma
      n += 1
    }
    if (n === 0) return null
    const mean = sum / n
    const variance = Math.max(0, sumSq / n - mean * mean)
    return { meanLuma: mean, variance }
  } catch {
    return null
  }
}

/** Calcule la taille cible en bornant à 1280x720 tout en conservant le ratio. */
export function computeTargetSize(
  w: number,
  h: number,
): { width: number; height: number } {
  if (w <= 0 || h <= 0) return { width: w, height: h }
  // ratio <= 1 : on ne fait jamais d'agrandissement (vidéo plus petite = natif).
  const ratio = Math.min(1, MAX_W / w, MAX_H / h)
  return { width: Math.round(w * ratio), height: Math.round(h * ratio) }
}

// Canvas invisible réutilisé pour toutes les captures.
let canvas: HTMLCanvasElement | null = null
function getCanvas(): HTMLCanvasElement {
  if (!canvas) {
    canvas = document.createElement('canvas')
    canvas.style.display = 'none'
  }
  return canvas
}

/**
 * Dessine la frame courante de la vidéo dans un canvas et renvoie une data URL
 * WebP accompagnée des statistiques de luminance (pour la détection d'image
 * suspecte). Lève une CaptureError avec un code explicite en cas de problème.
 */
export function captureFrame(video: HTMLVideoElement): CaptureResult {
  // HAVE_CURRENT_DATA (2) minimum pour disposer de la frame courante.
  if (video.readyState < 2) throw new CaptureError('VIDEO_NOT_READY')

  const vw = video.videoWidth
  const vh = video.videoHeight
  if (vw === 0 || vh === 0) throw new CaptureError('VIDEO_NOT_READY')

  const { width, height } = computeTargetSize(vw, vh)
  const cv = getCanvas()
  cv.width = width
  cv.height = height
  const ctx = cv.getContext('2d')
  if (!ctx) throw new CaptureError('CAPTURE_ERROR', 'Contexte 2D indisponible')

  try {
    ctx.drawImage(video, 0, 0, width, height)
  } catch {
    // Le navigateur refuse de fournir les pixels (protection du contenu).
    throw new CaptureError('VIDEO_CAPTURE_BLOCKED')
  }

  // Statistiques calculées avant l'encodage (canvas non protégé si drawImage a réussi).
  const stats = computeFrameStats(ctx, width, height)

  let dataUrl: string
  try {
    dataUrl = cv.toDataURL('image/webp', QUALITY)
  } catch {
    // Canvas "taint" par un contenu cross-origin / DRM.
    throw new CaptureError('CANVAS_SECURITY_ERROR')
  }

  if (!dataUrl || dataUrl === 'data:,') throw new CaptureError('CAPTURE_ERROR')
  return { dataUrl, stats }
}

/**
 * Recadre une image de l'onglet visible sur le rectangle CSS du lecteur.
 * Cette fonction traite uniquement les pixels que Chrome a déjà accepté de
 * livrer via `captureVisibleTab`; elle ne lit jamais le flux vidéo protégé.
 */
export async function cropVisibleTabCapture(
  fullTabDataUrl: string,
  rect: DOMRect,
): Promise<CaptureResult> {
  if (rect.width <= 1 || rect.height <= 1) throw new CaptureError('CAPTURE_ERROR', 'Lecteur sans zone visible.')
  const image = new Image()
  image.src = fullTabDataUrl
  try {
    await image.decode()
  } catch {
    throw new CaptureError('CAPTURE_ERROR', 'Capture de l’onglet illisible.')
  }
  const scaleX = image.naturalWidth / window.innerWidth
  const scaleY = image.naturalHeight / window.innerHeight
  const sourceX = Math.max(0, Math.round(rect.left * scaleX))
  const sourceY = Math.max(0, Math.round(rect.top * scaleY))
  const sourceW = Math.min(image.naturalWidth - sourceX, Math.round(rect.width * scaleX))
  const sourceH = Math.min(image.naturalHeight - sourceY, Math.round(rect.height * scaleY))
  if (sourceW <= 1 || sourceH <= 1) throw new CaptureError('CAPTURE_ERROR', 'Lecteur hors de la zone visible.')
  const { width, height } = computeTargetSize(sourceW, sourceH)
  const cv = getCanvas()
  cv.width = width
  cv.height = height
  const ctx = cv.getContext('2d')
  if (!ctx) throw new CaptureError('CAPTURE_ERROR', 'Contexte 2D indisponible')
  ctx.drawImage(image, sourceX, sourceY, sourceW, sourceH, 0, 0, width, height)
  return { dataUrl: cv.toDataURL('image/webp', QUALITY), stats: computeFrameStats(ctx, width, height) }
}

/** Extrait le type MIME réel de la data URL (WebP, ou PNG en repli navigateur). */
export function detectImageFormat(dataUrl: string): string {
  const match = /^data:([^;]+)/.exec(dataUrl)
  return match ? match[1] : 'image/webp'
}
