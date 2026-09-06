import type { CaptureState } from '../../lib/types'
import { formatTimecode, formatInterval } from '../../lib/timecode'

interface Props {
  state: CaptureState | null
  detectError: string | null
}

export function StatusPanel({ state, detectError }: Props) {
  if (detectError) {
    return (
      <section className="panel status status-error">
        <div className="status-line">{detectError}</div>
      </section>
    )
  }

  const info = state?.videoInfo ?? null

  if (!info) {
    return (
      <section className="panel status">
        <div className="status-line">Recherche d'une vidéo…</div>
      </section>
    )
  }

  const running = state?.running ?? false
  const paused = info.paused

  return (
    <section className="panel status">
      <div className="status-head">
        <span className="badge badge-ok">Vidéo détectée</span>
        {running && !paused && <span className="badge badge-live">Capture active</span>}
        {running && paused && (
          <span className="badge badge-warn">Vidéo en pause — capture suspendue</span>
        )}
      </div>

      <dl className="kv">
        <div>
          <dt>Dimensions</dt>
          <dd>
            {info.videoWidth} × {info.videoHeight}
          </dd>
        </div>
        <div>
          <dt>Durée</dt>
          <dd>{info.duration != null ? formatTimecode(info.duration) : '—'}</dd>
        </div>
        <div>
          <dt>Timecode</dt>
          <dd className="mono">{formatTimecode(info.currentTime)}</dd>
        </div>
        <div>
          <dt>État</dt>
          <dd>{info.ended ? 'terminée' : paused ? 'en pause' : 'lecture'}</dd>
        </div>
        {running && (
          <>
            <div>
              <dt>Intervalle</dt>
              <dd>{formatInterval(Math.round((state?.intervalMs ?? 0) / 1000))}</dd>
            </div>
            <div>
              <dt>Snapshots</dt>
              <dd>{state?.count ?? 0}</dd>
            </div>
          </>
        )}
      </dl>
    </section>
  )
}
