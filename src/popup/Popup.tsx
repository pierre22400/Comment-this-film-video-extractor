import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CaptureState, Snapshot } from '../lib/types'
import {
  getActiveTab,
  injectContentScript,
  sendToTab,
  clearSnapshots,
} from './api'
import { getAllSnapshots, countSnapshots } from '../lib/snapshotStore'
import { IntervalSelector } from './components/IntervalSelector'
import { StatusPanel } from './components/StatusPanel'
import { Gallery } from './components/Gallery'
import { SnapshotDetail } from './components/SnapshotDetail'

export function Popup() {
  const [tabId, setTabId] = useState<number | null>(null)
  const [ready, setReady] = useState(false)
  const [detectError, setDetectError] = useState<string | null>(null)
  const [state, setState] = useState<CaptureState | null>(null)
  const [intervalSeconds, setIntervalSeconds] = useState(10)
  const [snapshots, setSnapshots] = useState<Snapshot[]>([])
  const [selected, setSelected] = useState<Snapshot | null>(null)
  const lastCount = useRef(-1)

  // Object URLs pour l'affichage des Blobs, recréés quand la liste change.
  const urls = useMemo(() => {
    const map = new Map<number, string>()
    for (const s of snapshots) map.set(s.id, URL.createObjectURL(s.image))
    return map
  }, [snapshots])

  useEffect(() => {
    return () => {
      for (const url of urls.values()) URL.revokeObjectURL(url)
    }
  }, [urls])

  const reloadGallery = useCallback(async () => {
    const all = await getAllSnapshots()
    lastCount.current = all.length
    setSnapshots(all)
  }, [])

  // Initialisation : onglet actif + injection du content script + première détection.
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      // Cette interface ne fonctionne que chargée comme extension Chrome
      // (les API chrome.* sont absentes d'un simple navigateur).
      if (typeof chrome === 'undefined' || !chrome.tabs || !chrome.scripting) {
        setDetectError(
          'À ouvrir en tant qu\u2019extension Chrome (chrome://extensions → Charger l\u2019extension non empaquetée).',
        )
        return
      }
      const tab = await getActiveTab()
      if (!tab?.id) {
        setDetectError("Aucun onglet actif accessible.")
        return
      }
      try {
        await injectContentScript(tab.id)
      } catch {
        setDetectError(
          "Impossible d'accéder à cet onglet (page protégée du navigateur ?).",
        )
        return
      }
      if (cancelled) return
      setTabId(tab.id)
      setReady(true)
      const resp = await sendToTab(tab.id, { type: 'GET_STATE' })
      if (!cancelled && resp.ok && resp.kind === 'STATE') {
        setState(resp.state)
        if (resp.state.videoInfo === null) {
          setDetectError('Aucune vidéo HTML5 détectée dans cet onglet.')
        }
      }
      await reloadGallery()
    })()
    return () => {
      cancelled = true
    }
  }, [reloadGallery])

  // Sondage régulier : timecode/état + rafraîchissement galerie si le nombre change.
  useEffect(() => {
    if (!ready || tabId === null) return
    const timer = setInterval(async () => {
      const resp = await sendToTab(tabId, { type: 'GET_STATE' })
      if (resp.ok && resp.kind === 'STATE') {
        setState(resp.state)
        setDetectError(resp.state.videoInfo === null ? 'Aucune vidéo HTML5 détectée dans cet onglet.' : null)
      }
      const c = await countSnapshots()
      if (c !== lastCount.current) await reloadGallery()
    }, 1000)
    return () => clearInterval(timer)
  }, [ready, tabId, reloadGallery])

  const running = state?.running ?? false

  async function handleStart() {
    if (tabId === null) return
    const resp = await sendToTab(tabId, { type: 'START', intervalMs: intervalSeconds * 1000 })
    if (resp.ok && resp.kind === 'STATE') {
      setState(resp.state)
      setDetectError(null)
    } else if (!resp.ok) {
      setDetectError(resp.message)
    }
  }

  async function handleStop() {
    if (tabId === null) return
    const resp = await sendToTab(tabId, { type: 'STOP' })
    if (resp.ok && resp.kind === 'STATE') setState(resp.state)
  }

  async function handleClear() {
    await clearSnapshots()
    setSelected(null)
    await reloadGallery()
  }

  return (
    <div className="app">
      <header className="app-header">
        <h1>Comment-this-film</h1>
        <span className="cycle">Cycle 1 · capture locale · sans IA</span>
      </header>

      <StatusPanel state={state} detectError={detectError} />

      <IntervalSelector
        seconds={intervalSeconds}
        disabled={running}
        onChange={setIntervalSeconds}
      />

      <div className="controls">
        <button
          type="button"
          className="btn btn-primary"
          disabled={!ready || running}
          onClick={handleStart}
        >
          Démarrer
        </button>
        <button
          type="button"
          className="btn"
          disabled={!ready || !running}
          onClick={handleStop}
        >
          Arrêter
        </button>
        <button
          type="button"
          className="btn btn-danger"
          disabled={snapshots.length === 0}
          onClick={handleClear}
        >
          Effacer les captures
        </button>
      </div>

      <Gallery snapshots={snapshots} urls={urls} onSelect={setSelected} />

      {selected && urls.get(selected.id) && (
        <SnapshotDetail
          snapshot={selected}
          url={urls.get(selected.id) as string}
          onClose={() => setSelected(null)}
        />
      )}
    </div>
  )
}
