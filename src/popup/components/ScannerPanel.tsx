import { useMemo, useState } from 'react'
import { parseAndResolvePlan, type ResolvedPlan } from '../../lib/planner'
import type { PlanRunState } from '../../lib/messages'
import type { GalleryRun } from '../../lib/gallery'
import { formatTimecode } from '../../lib/timecode'
import { plannedItemView, galleryStateLabel, PLATFORM_LABELS } from '../scannerLabels'
// Fixtures chargeables (exemples reproductibles), importées en texte brut.
import youtubeSmoke from '../../../fixtures/planners/youtube-smoke.json?raw'
import scannerStress from '../../../fixtures/planners/scanner-stress-300.json?raw'

interface Props {
  /** Durée connue de la vidéo (secondes) pour valider « hors durée », si dispo. */
  knownDuration: number | null
  /** État en direct de l'exécution du plan (ou null). */
  planState: PlanRunState | null
  /** Galeries planifiées existantes (plus récente d'abord). */
  runs: GalleryRun[]
  onRun: (plan: ResolvedPlan) => Promise<boolean>
  onCancel: () => void
  onAnalyzeGallery: (galleryId: string) => void
  onExportGallery: (galleryId: string) => void
  onDeleteGallery: (galleryId: string) => void
}

export function ScannerPanel({
  knownDuration,
  planState,
  runs,
  onRun,
  onCancel,
  onAnalyzeGallery,
  onExportGallery,
  onDeleteGallery,
}: Props) {
  const [text, setText] = useState('')
  const [selectedGalleryId, setSelectedGalleryId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  // Aperçu du plan résolu, recalculé à chaque saisie (validation lisible).
  const preview = useMemo(() => {
    if (text.trim().length === 0) return null
    return parseAndResolvePlan(text, knownDuration)
  }, [text, knownDuration])

  const running = planState?.running ?? false
  const selectedRun = runs.find((r) => r.id === selectedGalleryId) ?? runs[0] ?? null

  async function handleRun() {
    setError(null)
    const result = parseAndResolvePlan(text, knownDuration)
    if (!result.ok) {
      setError(result.message)
      return
    }
    setSubmitting(true)
    const ok = await onRun(result.plan)
    setSubmitting(false)
    if (!ok) setError('Impossible de lancer le plan (vidéo indisponible dans cet onglet ?).')
  }

  function handleDelete(run: GalleryRun) {
    const ok = window.confirm(
      `Effacer définitivement la galerie « ${run.name} » et ses ${run.counters.captured + run.counters.unavailable} image(s) ?`,
    )
    if (ok) onDeleteGallery(run.id)
  }

  return (
    <section className="panel">
      <div className="panel-title">Scanner visuel planifié</div>
      <p className="hint">
        Collez un plan de captures (JSON). Chaque exécution crée une nouvelle
        galerie locale. L&apos;analyse Gemini reste désactivée par défaut et
        s&apos;active séparément, par galerie. Aucune protection n&apos;est
        contournée : une image noire ou indisponible est un résultat valable.
      </p>

      <label className="scanner-label">
        Plan de captures (JSON)
        <textarea
          className="scanner-textarea mono"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={'{ "version": 1, "mode": "seek", "items": [ { "at": "00:00:30" } ] }'}
          rows={6}
          disabled={running}
        />
      </label>

      <div className="scanner-examples">
        <button type="button" className="btn" disabled={running} onClick={() => setText(youtubeSmoke)}>
          Exemple : YouTube smoke
        </button>
        <button type="button" className="btn" disabled={running} onClick={() => setText(scannerStress)}>
          Exemple : stress 300
        </button>
      </div>

      {preview && !preview.ok && <p className="analysis-error">{preview.message}</p>}
      {preview && preview.ok && (
        <div className="scanner-preview">
          <span className="badge badge-ok">Plan valide</span>{' '}
          <span className="mono">
            {preview.plan.timecodes.length} capture(s) · mode {preview.plan.mode} · settle{' '}
            {preview.plan.settleMs} ms
          </span>
          <div className="scanner-preview-times mono">
            {preview.plan.timecodes.slice(0, 6).map((t) => formatTimecode(t)).join(' · ')}
            {preview.plan.timecodes.length > 6 ? ' · …' : ''}
          </div>
        </div>
      )}

      {error && <p className="analysis-error">{error}</p>}

      <div className="scanner-actions">
        <button
          type="button"
          className="btn btn-primary"
          disabled={running || submitting || !(preview?.ok ?? false)}
          onClick={handleRun}
        >
          Exécuter le plan
        </button>
        <button type="button" className="btn btn-danger" disabled={!running} onClick={onCancel}>
          Annuler
        </button>
      </div>

      {planState && planState.total > 0 && (
        <div className="scanner-progress">
          <div className="queue-line">
            Progression : {planState.done} / {planState.total}
            {planState.summary && !running && (
              <>
                {' '}
                · {planState.summary.captured} capturé(s), {planState.summary.unavailable} indisponible(s),{' '}
                {planState.summary.skipped} ignoré(s), {planState.summary.failed} échec(s)
                {planState.summary.cancelled ? ', annulé' : ''}
              </>
            )}
          </div>
          <ul className="scanner-items">
            {planState.items.slice(0, 40).map((it) => {
              const view = plannedItemView(it.status)
              return (
                <li key={it.index} className="scanner-item">
                  <span className="mono">{formatTimecode(it.requestedTime)}</span>
                  {it.actualTime !== undefined && it.status === 'captured' && (
                    <span className="mono scanner-item-actual">→ {formatTimecode(it.actualTime)}</span>
                  )}
                  <span className={`chip chip-${view.kind === 'live' ? 'analyzing' : view.kind}`}>
                    {view.text}
                  </span>
                </li>
              )
            })}
          </ul>
          {planState.items.length > 40 && (
            <p className="hint">… {planState.items.length - 40} item(s) supplémentaire(s)</p>
          )}
        </div>
      )}

      {runs.length > 0 && (
        <div className="scanner-galleries">
          <label className="scanner-label">
            Galerie
            <select
              value={selectedRun?.id ?? ''}
              onChange={(e) => setSelectedGalleryId(e.target.value)}
            >
              {runs.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name} · {PLATFORM_LABELS[r.platform]} · {galleryStateLabel(r.state)} ·{' '}
                  {r.counters.captured}/{r.counters.planned}
                </option>
              ))}
            </select>
          </label>

          {selectedRun && (
            <div className="scanner-gallery-detail">
              <dl className="kv">
                <div>
                  <dt>Plateforme</dt>
                  <dd>{PLATFORM_LABELS[selectedRun.platform]}</dd>
                </div>
                <div>
                  <dt>Stratégie</dt>
                  <dd>{selectedRun.strategy}</dd>
                </div>
                <div>
                  <dt>Capturées</dt>
                  <dd>
                    {selectedRun.counters.captured} exploitable(s), {selectedRun.counters.unavailable}{' '}
                    indisponible(s)
                  </dd>
                </div>
                <div>
                  <dt>Gemini</dt>
                  <dd>{selectedRun.geminiRequestedAt ? 'Analyse demandée' : 'Non demandée'}</dd>
                </div>
              </dl>

              <label className="scanner-gemini">
                <input
                  type="checkbox"
                  checked={Boolean(selectedRun.geminiRequestedAt)}
                  disabled={Boolean(selectedRun.geminiRequestedAt) || selectedRun.counters.captured === 0}
                  onChange={(e) => {
                    if (e.target.checked) onAnalyzeGallery(selectedRun.id)
                  }}
                />
                Analyser avec Gemini les captures de cette galerie
              </label>

              <div className="scanner-gallery-actions">
                <button
                  type="button"
                  className="btn"
                  disabled={selectedRun.counters.captured + selectedRun.counters.unavailable === 0}
                  onClick={() => onExportGallery(selectedRun.id)}
                >
                  Exporter la galerie
                </button>
                <button
                  type="button"
                  className="btn btn-danger"
                  onClick={() => handleDelete(selectedRun)}
                >
                  Effacer cette galerie
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </section>
  )
}
