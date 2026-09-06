import type { Snapshot } from '../../lib/types'
import { formatTimecode, formatDateTime } from '../../lib/timecode'
import { analysisStateView, analysisErrorText, notApplicableText } from '../analysisLabels'

interface Props {
  snapshot: Snapshot
  url: string
  onClose: () => void
  onRetry: (id: number) => void
}

export function SnapshotDetail({ snapshot, url, onClose, onRetry }: Props) {
  const idLabel = String(snapshot.id).padStart(3, '0')
  const view = analysisStateView(snapshot)
  const errorText = analysisErrorText(snapshot)
  const naText = notApplicableText(snapshot)
  const state = snapshot.analysisState ?? 'not_requested'

  function download() {
    const ext = snapshot.mimeType.includes('png') ? 'png' : 'webp'
    const a = document.createElement('a')
    a.href = url
    a.download = `snapshot-${idLabel}-${formatTimecode(snapshot.mediaTime).replace(/[:.]/g, '-')}.${ext}`
    document.body.appendChild(a)
    a.click()
    a.remove()
  }

  return (
    <div
      className="modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label={`Snapshot #${idLabel}`}
      onClick={onClose}
    >
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <strong>Snapshot #{idLabel}</strong>
          <button type="button" className="icon-btn" aria-label="Fermer" onClick={onClose}>
            ×
          </button>
        </div>

        <img className="modal-img" src={url} alt={`Snapshot #${idLabel} agrandi`} />

        <div className="analysis-block">
          <div className="analysis-head">
            <span className="panel-title" style={{ margin: 0 }}>
              Description Gemini
            </span>
            <span className={`chip chip-${view.kind}`}>{view.text}</span>
          </div>

          {snapshot.description ? (
            <p className="analysis-desc">{snapshot.description}</p>
          ) : state === 'analyzing' || state === 'queued' ? (
            <p className="analysis-desc muted-text">Analyse en cours…</p>
          ) : state === 'not_applicable' ? (
            <p className="analysis-na">{naText}</p>
          ) : errorText ? (
            <p className="analysis-error">{errorText}</p>
          ) : (
            <p className="analysis-desc muted-text">Pas encore de description.</p>
          )}

          {state === 'failed' && (
            <button
              type="button"
              className="btn btn-block"
              onClick={() => onRetry(snapshot.id)}
            >
              Réessayer
            </button>
          )}
        </div>

        <dl className="kv kv-detail">
          <div>
            <dt>Timecode vidéo</dt>
            <dd className="mono">{formatTimecode(snapshot.mediaTime)}</dd>
          </div>
          <div>
            <dt>mediaTime (s)</dt>
            <dd className="mono">{snapshot.mediaTime.toFixed(3)}</dd>
          </div>
          <div>
            <dt>Capturé le</dt>
            <dd>{formatDateTime(snapshot.capturedAt)}</dd>
          </div>
          <div>
            <dt>Dimensions</dt>
            <dd>
              {snapshot.videoWidth} × {snapshot.videoHeight}
            </dd>
          </div>
          <div>
            <dt>Format</dt>
            <dd>{snapshot.mimeType}</dd>
          </div>
          {snapshot.analysisModel && (
            <div>
              <dt>Modèle</dt>
              <dd className="truncate" title={snapshot.analysisModel}>
                {snapshot.analysisModel}
              </dd>
            </div>
          )}
          {snapshot.analysisLatencyMs != null && (
            <div>
              <dt>Latence</dt>
              <dd>{snapshot.analysisLatencyMs} ms</dd>
            </div>
          )}
          <div className="kv-wide">
            <dt>Page</dt>
            <dd className="truncate" title={snapshot.pageTitle}>
              {snapshot.pageTitle || '—'}
            </dd>
          </div>
          <div className="kv-wide">
            <dt>URL</dt>
            <dd className="truncate" title={snapshot.pageUrl}>
              {snapshot.pageUrl}
            </dd>
          </div>
        </dl>

        <button type="button" className="btn btn-primary btn-block" onClick={download}>
          Télécharger cette image
        </button>
      </div>
    </div>
  )
}
