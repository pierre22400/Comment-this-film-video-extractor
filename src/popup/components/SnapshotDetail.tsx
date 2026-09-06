import type { Snapshot } from '../../lib/types'
import { formatTimecode, formatDateTime } from '../../lib/timecode'

interface Props {
  snapshot: Snapshot
  url: string
  onClose: () => void
}

export function SnapshotDetail({ snapshot, url, onClose }: Props) {
  const idLabel = String(snapshot.id).padStart(3, '0')

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
