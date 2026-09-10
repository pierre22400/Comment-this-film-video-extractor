// Diagnostic manuel : actions EXPLICITES uniquement. Contrairement à l'ancienne
// bascule "Analyse Gemini activée/désactivée" (Cycle 2 initial), rien ici n'est
// jamais déclenché automatiquement par une capture périodique — chaque appel à
// Gemini résulte d'un clic de l'utilisateur.

interface Props {
  queued: number
  analyzing: number
  unanalyzedCount: number
  onAnalyzeAll: () => void
}

export function DiagnosticPanel({ queued, analyzing, unanalyzedCount, onAnalyzeAll }: Props) {
  function handleAnalyzeAll() {
    if (unanalyzedCount === 0) return
    const ok = window.confirm(
      `Envoyer ${unanalyzedCount} capture(s) non analysée(s) à Gemini via le relais local ?`,
    )
    if (ok) onAnalyzeAll()
  }

  return (
    <section className="panel">
      <div className="panel-title">Diagnostic manuel</div>
      <p className="hint">
        Aucune analyse automatique : chaque description Gemini résulte d&apos;une
        action explicite ci-dessous, jamais d&apos;une capture périodique.
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
