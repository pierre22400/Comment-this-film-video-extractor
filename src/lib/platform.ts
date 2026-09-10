// Reconnaissance de PLATEFORME — module PUR (aucune dépendance chrome/DOM), à
// partir de la seule URL de la page. Sert à afficher explicitement YouTube et
// Prime Video dans l'interface, tout en gardant un repli HTML5 générique.
//
// Cette détection est PUREMENT INFORMATIVE : elle ne change jamais le
// comportement de capture et ne tente jamais de contourner une protection. Une
// image indisponible sur Prime reste un résultat valable à diagnostiquer.

import type { Platform } from './gallery'

/**
 * Déduit la plateforme d'une URL. Repli `html5` pour toute URL non reconnue,
 * vide ou invalide. Ne dépend que de l'hôte (jamais du contenu du flux).
 */
export function detectPlatform(url: string | null | undefined): Platform {
  if (!url) return 'html5'
  let host: string
  try {
    host = new URL(url).hostname.toLowerCase()
  } catch {
    return 'html5'
  }
  if (host === 'youtu.be' || host.endsWith('youtube.com') || host.endsWith('youtube-nocookie.com')) {
    return 'youtube'
  }
  if (
    host.includes('primevideo.com') ||
    host.includes('amazon.') && /(\/|^)(gp\/video|dp\/)/.test(safePath(url)) ||
    host.includes('primevideo')
  ) {
    return 'prime'
  }
  // Amazon Prime Video est aussi servi depuis amazon.<tld> sur des chemins vidéo.
  if (host.includes('amazon.') && /video|gp\/video|dp\//.test(safePath(url))) {
    return 'prime'
  }
  return 'html5'
}

function safePath(url: string): string {
  try {
    return new URL(url).pathname.toLowerCase()
  } catch {
    return ''
  }
}
