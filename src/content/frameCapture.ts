import { CaptureError } from '../lib/errors'

// Capture d'une frame : HTMLVideoElement -> Canvas -> drawImage -> WebP.

const MAX_W = 1280
const MAX_H = 720
const QUALITY = 0.8

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
 * Dessine la frame courante de la vidéo dans un canvas et renvoie une data URL WebP.
 * Lève une CaptureError avec un code explicite en cas de problème.
 */
export function captureFrame(video: HTMLVideoElement): string {
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

  let dataUrl: string
  try {
    dataUrl = cv.toDataURL('image/webp', QUALITY)
  } catch {
    // Canvas "taint" par un contenu cross-origin / DRM.
    throw new CaptureError('CANVAS_SECURITY_ERROR')
  }

  if (!dataUrl || dataUrl === 'data:,') throw new CaptureError('CAPTURE_ERROR')
  return dataUrl
}

/** Extrait le type MIME réel de la data URL (WebP, ou PNG en repli navigateur). */
export function detectImageFormat(dataUrl: string): string {
  const match = /^data:([^;]+)/.exec(dataUrl)
  return match ? match[1] : 'image/webp'
}
