import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CaptureState, Snapshot } from '../lib/types'
import type { AnalysisStatus, ProbeDefinition } from '../lib/messages'
import type { VisualProbeRequest } from '../lib/probe'
import {
  getActiveTab,
  injectContentScript,
  sendToTab,
  clearSnapshots,
  getAnalysisStatus,
  enqueueUnanalyzed,
  retrySnapshot,
  createVisualProbe,
  cancelVisualProbe,
  listVisualProbes,
  runPlan,
  cancelPlan,
  getPlanState,
  listGalleryRuns,
  deleteGalleryRun,
  analyzeGallery,
  exportGallery,
} from './api'
import { getAllSnapshots, countSnapshots } from '../lib/snapshotStore'
import { detectPlatform } from '../lib/platform'
import type { PlanRunState } from '../lib/messages'
import type { GalleryRun } from '../lib/gallery'
import type { ResolvedPlan } from '../lib/planner'
import { IntervalSelector } from './components/IntervalSelector'
import { StatusPanel } from './components/StatusPanel'
import { DiagnosticPanel } from './components/DiagnosticPanel'
import { VisualProbePanel } from './components/VisualProbePanel'
import { ScannerPanel } from './components/ScannerPanel'
import { Gallery } from './components/Gallery'
import { SnapshotDetail } from './components/SnapshotDetail'

function unanalyzed(s: Snapshot): boolean {
  const st = s.analysisState ?? 'not_requested'
  return st === 'not_requested' || st === 'failed'
}

export function Popup() {
  const [tabId, setTabId] = useState<number | null>(null)
  const [pageUrl, setPageUrl] = useState('')
  const [pageTitle, setPageTitle] = useState('')
  const [ready, setReady] = useState(false)
  const [detectError, setDetectError] = useState<string | null>(null)
  const [state, setState] = useState<CaptureState | null>(null)
  const [intervalSeconds, setIntervalSeconds] = useState(10)
  const [snapshots, setSnapshots] = useState<Snapshot[]>([])
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [analysis, setAnalysis] = useState<AnalysisStatus>({ queued: 0, analyzing: 0 })
  const [probes, setProbes] = useState<VisualProbeRequest[]>([])
  const [planState, setPlanState] = useState<PlanRunState | null>(null)
  const [galleryRuns, setGalleryRuns] = useState<GalleryRun[]>([])
  const [selectedGalleryId, setSelectedGalleryId] = useState<string | null>(null)
  const lastCount = useRef(-1)
  const lastSig = useRef('')

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

  // Recharge la galerie SANS provoquer de scintillement : on ne remplace la
  // liste que si une donnée visible a réellement changé (id, état, description).
  const reloadGallery = useCallback(async () => {
    const all = await getAllSnapshots()
    lastCount.current = all.length
    const sig = all
      .map((s) => `${s.id}:${s.analysisState ?? 'not_requested'}:${s.description ? 1 : 0}`)
      .join('|')
    if (sig !== lastSig.current) {
      lastSig.current = sig
      setSnapshots(all)
    }
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
        setDetectError('Aucun onglet actif accessible.')
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
      setPageUrl(tab.url ?? '')
      setPageTitle(tab.title ?? '')
      setReady(true)
      const resp = await sendToTab(tab.id, { type: 'GET_STATE' })
      if (!cancelled && resp.ok && resp.kind === 'STATE') {
        setState(resp.state)
        if (resp.state.videoInfo === null) {
          setDetectError('Aucune vidéo HTML5 détectée dans cet onglet.')
        }
      }
      const st = await getAnalysisStatus()
      if (!cancelled && st) setAnalysis(st)
      const pr = await listVisualProbes()
      if (!cancelled) setProbes(pr)
      const ps = await getPlanState(tab.id)
      if (!cancelled) setPlanState(ps)
      const gr = await listGalleryRuns()
      if (!cancelled) {
        setGalleryRuns(gr)
        setSelectedGalleryId(gr[0]?.id ?? null)
      }
      await reloadGallery()
    })()
    return () => {
      cancelled = true
    }
  }, [reloadGallery])

  // Sondage régulier : timecode/état vidéo + file de diagnostic + sondes + galerie.
  useEffect(() => {
    if (!ready || tabId === null) return
    const timer = setInterval(async () => {
      const resp = await sendToTab(tabId, { type: 'GET_STATE' })
      if (resp.ok && resp.kind === 'STATE') {
        setState(resp.state)
        setDetectError(
          resp.state.videoInfo === null ? 'Aucune vidéo HTML5 détectée dans cet onglet.' : null,
        )
      }
      const st = await getAnalysisStatus()
      if (st) setAnalysis(st)
      const pr = await listVisualProbes()
      setProbes(pr)
      const ps = await getPlanState(tabId)
      setPlanState(ps)
      const gr = await listGalleryRuns()
      setGalleryRuns(gr)

      const c = await countSnapshots()
      const busy = (st?.queued ?? 0) > 0 || (st?.analyzing ?? 0) > 0 || (ps?.running ?? false)
      // Recharge si le nombre change, ou tant que des analyses/plan sont en cours.
      if (c !== lastCount.current || busy) await reloadGallery()
    }, 1000)
    return () => clearInterval(timer)
  }, [ready, tabId, reloadGallery])

  const running = state?.running ?? false
  const unanalyzedCount = snapshots.filter(unanalyzed).length
  const visibleSnapshots = selectedGalleryId
    ? snapshots.filter((snapshot) => snapshot.galleryId === selectedGalleryId)
    : snapshots
  const selected = selectedId !== null
    ? visibleSnapshots.find((s) => s.id === selectedId) ?? null
    : null

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
    setSelectedId(null)
    setSelectedGalleryId(null)
    lastSig.current = ''
    await reloadGallery()
    setProbes(await listVisualProbes())
  }

  async function handleAnalyzeAll() {
    await enqueueUnanalyzed()
    const st = await getAnalysisStatus()
    if (st) setAnalysis(st)
    await reloadGallery()
  }

  async function handleRetry(id: number) {
    await retrySnapshot(id)
    const st = await getAnalysisStatus()
    if (st) setAnalysis(st)
    await reloadGallery()
  }

  async function handleCreateProbe(def: ProbeDefinition): Promise<boolean> {
    if (tabId === null) return false
    const created = await createVisualProbe(tabId, def)
    setProbes(await listVisualProbes())
    return created !== null
  }

  async function handleCancelProbe(id: string) {
    if (tabId === null) return
    await cancelVisualProbe(tabId, id)
    setProbes(await listVisualProbes())
  }

  async function handleRunPlan(plan: ResolvedPlan): Promise<boolean> {
    if (tabId === null) return false
    const info = state?.videoInfo ?? null
    const galleryId = await runPlan(tabId, {
      name: plan.name,
      fixtureName: plan.name,
      pageUrl: pageUrl,
      pageTitle: pageTitle,
      platform: detectPlatform(pageUrl),
      strategy: plan.mode,
      timecodes: plan.timecodes,
      settleMs: plan.settleMs,
    })
    if (galleryId === null) return false
    setSelectedGalleryId(galleryId)
    setGalleryRuns(await listGalleryRuns())
    if (info) setPlanState(await getPlanState(tabId))
    return true
  }

  async function handleCancelPlan() {
    if (tabId === null) return
    await cancelPlan(tabId)
    setPlanState(await getPlanState(tabId))
    setGalleryRuns(await listGalleryRuns())
  }

  async function handleAnalyzeGallery(galleryId: string) {
    await analyzeGallery(galleryId)
    setGalleryRuns(await listGalleryRuns())
    const st = await getAnalysisStatus()
    if (st) setAnalysis(st)
    await reloadGallery()
  }

  async function handleExportGallery(galleryId: string) {
    await exportGallery(galleryId)
  }

  async function handleDeleteGallery(galleryId: string) {
    await deleteGalleryRun(galleryId)
    const remaining = await listGalleryRuns()
    setGalleryRuns(remaining)
    if (selectedGalleryId === galleryId) setSelectedGalleryId(remaining[0]?.id ?? null)
    setSelectedId(null)
    lastSig.current = ''
    await reloadGallery()
  }

  return (
    <div className="app">
      <header className="app-header">
        <h1>Comment-this-film</h1>
        <span className="cycle">
          Cycle 3 · capture locale + sondes ciblées + scanner visuel planifié (relais local)
        </span>
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

      <VisualProbePanel
        probes={probes}
        currentTime={state?.videoInfo?.currentTime ?? null}
        onCreate={handleCreateProbe}
        onCancel={handleCancelProbe}
      />

      <ScannerPanel
        knownDuration={state?.videoInfo?.duration ?? null}
        planState={planState}
        runs={galleryRuns}
        selectedGalleryId={selectedGalleryId}
        onSelectGallery={(galleryId) => {
          setSelectedGalleryId(galleryId)
          setSelectedId(null)
        }}
        onRun={handleRunPlan}
        onCancel={handleCancelPlan}
        onAnalyzeGallery={handleAnalyzeGallery}
        onExportGallery={handleExportGallery}
        onDeleteGallery={handleDeleteGallery}
      />

      <DiagnosticPanel
        queued={analysis.queued}
        analyzing={analysis.analyzing}
        unanalyzedCount={unanalyzedCount}
        onAnalyzeAll={handleAnalyzeAll}
      />

      <Gallery snapshots={visibleSnapshots} urls={urls} onSelect={(s) => setSelectedId(s.id)} />

      {selected && urls.get(selected.id) && (
        <SnapshotDetail
          snapshot={selected}
          url={urls.get(selected.id) as string}
          onClose={() => setSelectedId(null)}
          onRetry={handleRetry}
        />
      )}
    </div>
  )
}
