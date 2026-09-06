interface Props {
  enabled: boolean
  queued: number
  analyzing: number
  unanalyzedCount: number
  onToggle: (enabled: boolean) => void
  onAnalyzeAll: () => void
}

export function AnalysisControl({
  enabled,
  queued,
  analyzing,
  unanalyzedCount,
  onToggle,
  onAnalyzeAll,
}: Props) {
  function handleAnalyzeAll() {
    if (unanalyzedCount === 0) return
    const ok = window.confirm(
      `Envoyer ${unanalyzedCount} capture(s) non analysée(s) à Gemini via le relais local ?`,
    )
    if (ok) onAnalyzeAll()
  }

  return (
    <section className="panel">
      <div className="toggle-row">
        <div className="toggle-label">
          <span className="panel-title" style={{ margin: 0 }}>
            Analyse Gemini
          </span>
          <span className={`chip chip-${enabled ? 'ok' : 'idle'}`}>
            {enabled ? 'activée' : 'désactivée'}
          </span>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={enabled}
          aria-label="Activer l’analyse Gemini"
          className={`switch ${enabled ? 'switch-on' : ''}`}
          onClick={() => onToggle(!enabled)}
        >
          <span className="switch-knob" />
        </button>
      </div>

      <p className="hint">
        {enabled
          ? 'Chaque nouveau snapshot est automatiquement décrit.'
          : 'Désactivée par défaut. Activez pour décrire les nouveaux snapshots.'}
      </p>

      {(queued > 0 || analyzing > 0) && (
        <div className="queue-line">
          File : {queued} en attente · {analyzing} en cours
        </div>
      )}

      <button
        type="button"
        className="btn btn-block"
        disabled={unanalyzedCount === 0}
        onClick={handleAnalyzeAll}
      >
        Analyser les captures non analysées{unanalyzedCount > 0 ? ` (${unanalyzedCount})` : ''}
      </button>
    </section>
  )
}
