import { formatInterval } from '../../lib/timecode'

const PRESETS = [5, 10, 15, 30, 60, 120, 180, 300]
const MIN = 5
const MAX = 300

interface Props {
  seconds: number
  disabled: boolean
  onChange: (seconds: number) => void
}

export function IntervalSelector({ seconds, disabled, onChange }: Props) {
  function clamp(v: number): number {
    if (Number.isNaN(v)) return MIN
    return Math.min(MAX, Math.max(MIN, Math.round(v)))
  }

  return (
    <section className="panel">
      <div className="panel-title">
        Intervalle : <strong>{formatInterval(seconds)}</strong>
      </div>

      <div className="presets" role="group" aria-label="Intervalles rapides">
        {PRESETS.map((p) => (
          <button
            key={p}
            type="button"
            className={`preset ${p === seconds ? 'preset-active' : ''}`}
            disabled={disabled}
            aria-pressed={p === seconds}
            onClick={() => onChange(p)}
          >
            {p < 60 ? `${p}s` : formatInterval(p)}
          </button>
        ))}
      </div>

      <div className="slider-row">
        <input
          type="range"
          min={MIN}
          max={MAX}
          step={1}
          value={seconds}
          disabled={disabled}
          aria-label="Intervalle en secondes"
          onChange={(e) => onChange(clamp(Number(e.target.value)))}
        />
        <input
          type="number"
          min={MIN}
          max={MAX}
          value={seconds}
          disabled={disabled}
          aria-label="Intervalle en secondes (valeur)"
          onChange={(e) => onChange(clamp(Number(e.target.value)))}
        />
      </div>
    </section>
  )
}
