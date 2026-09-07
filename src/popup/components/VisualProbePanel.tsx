import { useState } from 'react'
import type { VisualProbeRequest } from '../../lib/probe'
import { PROBE_PURPOSES } from '../../lib/probe'
import type { ProbeDefinition } from '../../lib/messages'
import { formatTimecode } from '../../lib/timecode'
import { PROBE_PURPOSE_LABELS, probeStatusView, probeResultText, summarizeProbes } from '../probeLabels'

interface Props {
  probes: VisualProbeRequest[]
  currentTime: number | null
  onCreate: (definition: ProbeDefinition) => Promise<boolean>
  onCancel: (id: string) => void
}

const DEFAULT_WINDOW_SECONDS = 5

export function VisualProbePanel({ probes, currentTime, onCreate, onCancel }: Props) {
  const [startTime, setStartTime] = useState('')
  const [endTime, setEndTime] = useState('')
  const [purpose, setPurpose] = useState<ProbeDefinition['purpose']>('open_observation')
  const [question, setQuestion] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  const summary = summarizeProbes(probes)
  const ordered = [...probes].sort((a, b) => b.createdAt.localeCompare(a.createdAt))

  async function submit(def: ProbeDefinition) {
    setSubmitting(true)
    setError(null)
    const ok = await onCreate(def)
    setSubmitting(false)
    if (!ok) {
      setError("Impossible de programmer la sonde (vidéo indisponible dans cet onglet ?).")
      return
    }
    setStartTime('')
    setEndTime('')
    setQuestion('')
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    const s = Number(startTime)
    const en = Number(endTime)
    if (!Number.isFinite(s) || !Number.isFinite(en)) {
      setError('Renseignez un début et une fin (en secondes).')
      return
    }
    if (question.trim().length < 3) {
      setError('La question doit contenir au moins 3 caractères.')
      return
    }
    void submit({
      startTime: s,
      endTime: en,
      preferredTime: null,
      purpose,
      question: question.trim(),
      maxCaptures: 1,
    })
  }

  function handleDemo() {
    const base = currentTime ?? 0
    void submit({
      startTime: base + 8,
      endTime: base + 13,
      preferredTime: base + 10,
      purpose: 'open_observation',
      question: 'Que voit-on à l’écran à cet instant ?',
      maxCaptures: 2,
    })
  }

  return (
    <section className="panel">
      <div className="panel-title">
        Sondes visuelles ·{' '}
        <span className="probe-summary">
          {summary.scheduled} programmée(s) · {summary.live} en cours · {summary.done} répondue(s) ·{' '}
          {summary.missedOrFailed} sans résultat
        </span>
      </div>

      <p className="hint">
        Une sonde cible une fenêtre temporelle précise et une question précise.
        Elle capture au plus une image exploitable dans cette fenêtre puis
        interroge Gemini une seule fois — jamais liée à la capture périodique.
      </p>

      <form className="probe-form" onSubmit={handleSubmit}>
        <div className="probe-form-row">
          <label>
            Début (s)
            <input
              type="number"
              step="0.1"
              min={0}
              value={startTime}
              onChange={(e) => setStartTime(e.target.value)}
              placeholder={currentTime != null ? currentTime.toFixed(1) : '0'}
            />
          </label>
          <label>
            Fin (s)
            <input
              type="number"
              step="0.1"
              min={0}
              value={endTime}
              onChange={(e) => setEndTime(e.target.value)}
              placeholder={currentTime != null ? (currentTime + DEFAULT_WINDOW_SECONDS).toFixed(1) : '5'}
            />
          </label>
        </div>

        <label>
          Intention
          <select value={purpose} onChange={(e) => setPurpose(e.target.value as ProbeDefinition['purpose'])}>
            {PROBE_PURPOSES.map((p) => (
              <option key={p} value={p}>
                {PROBE_PURPOSE_LABELS[p]}
              </option>
            ))}
          </select>
        </label>

        <label>
          Question précise
          <textarea
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            placeholder="Ex : Quelle est la couleur du véhicule visible à l’écran ?"
            rows={2}
          />
        </label>

        {error && <p className="analysis-error">{error}</p>}

        <div className="probe-form-actions">
          <button type="submit" className="btn btn-primary" disabled={submitting}>
            Programmer la sonde
          </button>
          <button type="button" className="btn" disabled={submitting} onClick={handleDemo}>
            Démo : sonde dans 10 s
          </button>
        </div>
      </form>

      {ordered.length > 0 && (
        <ul className="probe-list">
          {ordered.map((p) => {
            const view = probeStatusView(p.status)
            const result = probeResultText(p)
            const cancellable = p.status === 'scheduled' || p.status === 'waiting'
            return (
              <li key={p.id} className="probe-item">
                <div className="probe-item-head">
                  <span className="mono">
                    {formatTimecode(p.startTime)} → {formatTimecode(p.endTime)}
                  </span>
                  <span className={`chip chip-${view.kind === 'live' ? 'analyzing' : view.kind === 'ok' ? 'ok' : view.kind === 'error' ? 'error' : view.kind === 'na' ? 'na' : 'idle'}`}>
                    {view.text}
                  </span>
                </div>
                <div className="probe-item-meta">
                  <span>{PROBE_PURPOSE_LABELS[p.purpose]}</span>
                  <span className="probe-question">{p.question}</span>
                </div>
                {result && <p className="probe-result">{result}</p>}
                {cancellable && (
                  <button type="button" className="btn btn-danger btn-block" onClick={() => onCancel(p.id)}>
                    Annuler
                  </button>
                )}
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}
