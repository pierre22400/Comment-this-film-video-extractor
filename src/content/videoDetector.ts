// Détection de l'élément vidéo pertinent dans la page.

function area(v: HTMLVideoElement): number {
  const rect = v.getBoundingClientRect()
  return rect.width * rect.height
}

function isVisible(el: HTMLElement): boolean {
  const rect = el.getBoundingClientRect()
  if (rect.width === 0 || rect.height === 0) return false
  const style = getComputedStyle(el)
  if (style.visibility === 'hidden' || style.display === 'none') return false
  if (parseFloat(style.opacity) === 0) return false
  return true
}

/**
 * Sélectionne la meilleure vidéo :
 * 1) une vidéo actuellement en lecture (la plus grande si plusieurs) ;
 * 2) sinon la vidéo visible ayant la plus grande surface affichée.
 * Renvoie null si aucune vidéo n'est présente.
 */
export function findBestVideo(): HTMLVideoElement | null {
  const videos = Array.from(document.querySelectorAll('video')) as HTMLVideoElement[]
  if (videos.length === 0) return null

  const playing = videos.filter((v) => !v.paused && !v.ended && v.readyState >= 2)
  if (playing.length > 0) {
    return playing.sort((a, b) => area(b) - area(a))[0]
  }

  const visible = videos.filter(isVisible)
  const pool = visible.length > 0 ? visible : videos
  return pool.sort((a, b) => area(b) - area(a))[0]
}
