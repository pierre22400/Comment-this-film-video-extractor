// Export d'une galerie planifiée (Cycle 3) — construction PURE du manifest et
// des noms de fichiers. L'écriture réelle passe par l'API Chrome `downloads`
// (permission minimale), côté service worker : les fichiers atterrissent sous
// Téléchargements/Comment-this-film/<gallery-id>/.
//
// RAPPEL EXPLICITE : une extension ne peut pas créer ni administrer
// silencieusement un dossier arbitraire hors de Téléchargements. La galerie
// « gérée » par l'extension reste IndexedDB ; l'export est un téléchargement
// explicite déclenché par l'utilisateur.

import type { GalleryRun } from './gallery'
import type { Snapshot } from './types'

/** Dossier racine des exports, sous le répertoire Téléchargements de l'utilisateur. */
export const EXPORT_ROOT = 'Comment-this-film'

/** Extension de fichier déduite d'un type MIME image (défaut : webp). */
export function extensionForMime(mime: string): string {
  switch (mime) {
    case 'image/webp':
      return 'webp'
    case 'image/png':
      return 'png'
    case 'image/jpeg':
      return 'jpg'
    default:
      return 'webp'
  }
}

/** Nom de fichier déterministe et trié d'une image (index à 4 chiffres). */
export function imageFilename(index: number, mime: string): string {
  return `snapshot-${String(index + 1).padStart(4, '0')}.${extensionForMime(mime)}`
}

/** Une entrée du manifest, décrivant un snapshot exporté (sans les pixels). */
export interface ManifestEntry {
  file: string
  snapshotId: number
  requestedTime: number | null
  mediaTime: number
  mimeType: string
  videoWidth: number
  videoHeight: number
  visualAvailability: string
  analysisState: string
  description: string | null
}

/** Manifest complet d'une galerie exportée. */
export interface GalleryManifest {
  schema: 'comment-this-film/gallery-export/1'
  galleryId: string
  name: string
  createdAt: string
  exportedAt: string
  pageUrl: string
  pageTitle: string
  platform: string
  fixtureName: string
  strategy: string
  state: string
  counters: GalleryRun['counters']
  geminiRequested: boolean
  images: ManifestEntry[]
}

/**
 * Construit le manifest d'une galerie à partir de son enregistrement et de ses
 * snapshots (ordonnés). Les noms de fichiers correspondent à ceux produits par
 * `imageFilename`. N'inclut JAMAIS le titre/URL de la page dans les données
 * envoyées à Gemini (l'export local est distinct et reste sur la machine).
 */
export function buildGalleryManifest(
  run: GalleryRun,
  snapshots: Snapshot[],
  exportedAt = new Date().toISOString(),
): GalleryManifest {
  const ordered = [...snapshots].sort((a, b) => a.id - b.id)
  return {
    schema: 'comment-this-film/gallery-export/1',
    galleryId: run.id,
    name: run.name,
    createdAt: run.createdAt,
    exportedAt,
    pageUrl: run.pageUrl,
    pageTitle: run.pageTitle,
    platform: run.platform,
    fixtureName: run.fixtureName,
    strategy: run.strategy,
    state: run.state,
    counters: run.counters,
    geminiRequested: Boolean(run.geminiRequestedAt),
    images: ordered.map((s, i) => ({
      file: imageFilename(i, s.mimeType),
      snapshotId: s.id,
      requestedTime: s.requestedTime ?? null,
      mediaTime: s.mediaTime,
      mimeType: s.mimeType,
      videoWidth: s.videoWidth,
      videoHeight: s.videoHeight,
      visualAvailability: s.visualAvailability ?? 'available',
      analysisState: s.analysisState ?? 'not_requested',
      description: s.description ?? null,
    })),
  }
}

/** Chemin relatif complet (sous Téléchargements) d'un fichier de galerie. */
export function exportPath(galleryId: string, filename: string): string {
  // Chrome downloads utilise des slash avant, jamais de backslash Windows.
  return `${EXPORT_ROOT}/${galleryId}/${filename}`
}

/** Encode un objet JSON en data URL `application/json` (base64). */
export function jsonToDataUrl(obj: unknown, btoaFn: (s: string) => string): string {
  const json = JSON.stringify(obj, null, 2)
  // Encodage UTF-8 sûr avant base64 (les accents FR du manifest sont préservés).
  const utf8 = encodeURIComponent(json).replace(/%([0-9A-F]{2})/g, (_, h) =>
    String.fromCharCode(parseInt(h, 16)),
  )
  return `data:application/json;base64,${btoaFn(utf8)}`
}
