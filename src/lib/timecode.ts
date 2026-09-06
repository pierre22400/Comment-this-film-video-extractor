// Formatage du timecode et des intervalles. La valeur numérique originale
// (secondes) est toujours conservée par ailleurs dans les métadonnées.

const pad = (n: number, len = 2): string => String(n).padStart(len, '0')

/** Formate un nombre de secondes en HH:MM:SS.mmm (ex: 842.351 -> "00:14:02.351"). */
export function formatTimecode(totalSeconds: number): string {
  let s = totalSeconds
  if (!Number.isFinite(s) || s < 0) s = 0
  const ms = Math.floor((s % 1) * 1000)
  const whole = Math.floor(s)
  const h = Math.floor(whole / 3600)
  const m = Math.floor((whole % 3600) / 60)
  const sec = whole % 60
  return `${pad(h)}:${pad(m)}:${pad(sec)}.${pad(ms, 3)}`
}

/** Formate un intervalle en secondes de façon lisible ("45 s" ou "2 min 30 s"). */
export function formatInterval(seconds: number): string {
  if (seconds < 60) return `${seconds} s`
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  return s === 0 ? `${m} min` : `${m} min ${pad(s)} s`
}

/** Date/heure locale lisible à partir d'une chaîne ISO. */
export function formatDateTime(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleString('fr-FR')
}
