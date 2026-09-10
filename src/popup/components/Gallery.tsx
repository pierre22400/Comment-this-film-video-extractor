import type { Snapshot } from '../../lib/types'
import { formatTimecode } from '../../lib/timecode'
import { analysisStateView, notApplicableText } from '../analysisLabels'

interface Props {
  snapshots: Snapshot[]
  urls: Map<number, string>
  onSelect: (snapshot: Snapshot) => void
}

export function Gallery({ snapshots, urls, onSelect }: Props) {
  if (snapshots.length === 0) {
    return (
      <section className="panel">
        <div className="panel-title">Galerie</div>
        <p className="empty">Aucun snapshot pour le moment.</p>
      </section>
    )
  }

  // Du plus récent au plus ancien.
  const ordered = [...snapshots].sort((a, b) => b.id - a.id)

  return (
    <section className="panel">
      <div className="panel-title">Galerie · {snapshots.length}</div>
      <ul className="gallery">
        {ordered.map((s) => {
          const view = analysisStateView(s)
          return (
            <li key={s.id}>
              <button type="button" className="thumb" onClick={() => onSelect(s)}>
                <img
                  src={urls.get(s.id)}
                  alt={`Snapshot #${String(s.id).padStart(3, '0')} au timecode ${formatTimecode(s.mediaTime)}`}
                  loading="lazy"
                />
                <span className="thumb-meta">
                  <span className="thumb-line">
                    <span className="thumb-id">#{String(s.id).padStart(3, '0')}</span>
                    {s.captureOrigin === 'visual_probe' && (
                      <span className="chip chip-idle" title="Issu d’une sonde visuelle">
                        Sonde
                      </span>
                    )}
                    <span className={`chip chip-${view.kind}`}>{view.text}</span>
                  </span>
                  <span className="mono">{formatTimecode(s.mediaTime)}</span>
                  {s.description ? (
                    <span className="thumb-desc">{s.description}</span>
                  ) : s.analysisState === 'not_applicable' ? (
                    <span className="thumb-na">{notApplicableText(s)}</span>
                  ) : (
                    <span className="thumb-dim">
                      {s.videoWidth} × {s.videoHeight}
                    </span>
                  )}
                </span>
              </button>
            </li>
          )
        })}
      </ul>
    </section>
  )
}
