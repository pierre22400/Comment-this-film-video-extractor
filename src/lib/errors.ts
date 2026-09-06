// Codes d'erreur explicites et messages humains (français) — Cycle 1.

export type CaptureErrorCode =
  | 'VIDEO_NOT_FOUND'
  | 'VIDEO_CAPTURE_BLOCKED'
  | 'CANVAS_SECURITY_ERROR'
  | 'VIDEO_NOT_READY'
  | 'CAPTURE_ERROR'

export const ERROR_MESSAGES: Record<CaptureErrorCode, string> = {
  VIDEO_NOT_FOUND: 'Aucune vidéo HTML5 détectée dans cet onglet.',
  VIDEO_CAPTURE_BLOCKED:
    'La capture directe de cette vidéo est bloquée par le navigateur ou par la protection du contenu.',
  CANVAS_SECURITY_ERROR:
    "La capture est bloquée par une restriction de sécurité ou d'origine (contenu protégé).",
  VIDEO_NOT_READY: "La vidéo n'a pas encore chargé suffisamment de données.",
  CAPTURE_ERROR: 'Erreur de capture inconnue.',
}

export class CaptureError extends Error {
  code: CaptureErrorCode
  constructor(code: CaptureErrorCode, message?: string) {
    super(message ?? ERROR_MESSAGES[code])
    this.code = code
    this.name = 'CaptureError'
  }
}

export function isCaptureErrorCode(value: string): value is CaptureErrorCode {
  return value in ERROR_MESSAGES
}
