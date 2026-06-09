import { useCallback, useEffect, useRef, useState } from 'react'
import studioAdPresetsJson from '../../shared/ad-formats.json'

type RunStatus = 'idle' | 'running' | 'success' | 'error'

type StudioRunKind = 'style_guide' | 'creative'

interface LogLine {
  source: 'stdout' | 'stderr'
  text: string
}

interface OutputPreviewVersion {
  versionId: string
  versionLabel: string
  relativePath: string
  previewUrl: string
  mtimeMs: number
  pageTitle: string
}

interface OutputFolderPreview {
  folderName: string
  pageTitle: string
  versionCount: number
  versions: OutputPreviewVersion[]
  mtimeMs: number
}

type PreviewModalState = {
  previewUrl: string
  pageTitle: string
  versionLabel: string
  relativePath: string
}

interface StudioCatalog {
  styleGuideScripts: string[]
  creativeCodeScripts: string[]
  outputFoldersWithStyleGuide: Array<{
    folderName: string
    mtimeMs: number
    codeVersionCount: number
  }>
  capabilities?: {
    preflightReferenceUrl?: boolean
  }
}

const PREFERRED_CREATIVE_SCRIPT = 'gen-creative-code-native.mts'

type ReferencePreflightUiState =
  | 'idle'
  | 'checking'
  | 'ok'
  | 'warning'
  | 'blocked'
  | 'unreachable'
  | 'invalid'

type ReferencePreflightResponse = {
  status: ReferencePreflightUiState
  normalizedUrl: string
  message: string
}

/** Last segment of `Output directory path:` from gen-style-guide (UUID folder under output/). */
function outputFolderNameFromDirectoryPath (dirPath: string): string {
  const normalized = dirPath.replace(/\\/gu, '/').replace(/\/+$/u, '')
  const parts = normalized.split('/')
  return parts[parts.length - 1] ?? ''
}

type ArchePresetJson = {
  headerPx: number
  gutterPx: number
  mainFocusWidthPx: number
  maxTotalWeightKB: number
  allowedRasterMime: string[]
  trackingNote: string
  companionPresetIds: string[]
}

type StudioAdPreset = {
  id: string
  width: number
  height: number
  label: string
  arche?: ArchePresetJson
}
type StudioAdPresetsFile = { presets: StudioAdPreset[] }

const STUDIO_AD_PRESETS = (studioAdPresetsJson as StudioAdPresetsFile).presets

type CreativeAdFormat = { id: string; width: number; height: number; arche?: ArchePresetJson }

type ApiCallTimingRow = {
  call_index: number
  duration_ms: number
  stop_reason?: string | null
  label?: string
}

type SubStepTimingRow = {
  label: string
  duration_ms: number
}

type PipelineUsageEntryRow = {
  action: string
  model: string | null
  phase?: 'style_guide' | 'creative'
  review_round: number | null
  api_calls: number
  billed_input_tokens: number
  output_tokens: number
  duration_ms?: number
  api_call_timings?: ApiCallTimingRow[]
  sub_step_timings?: SubStepTimingRow[]
  price_usd: { total: number }
}

type PhaseDurationMs = {
  style_guide: number
  creative: number
}

type PipelineUsagePayload = {
  entries: PipelineUsageEntryRow[]
  totals: {
    billed_input_tokens: number
    output_tokens: number
    duration_ms: number
    claude_api_duration_ms: number
    wall_clock_ms: number
    phase_duration_ms?: PhaseDurationMs
    price_usd: { total: number }
  }
  run_summary?: {
    wall_clock_ms: number
    claude_api_duration_ms: number
    claude_api_calls: number
    phase_duration_ms?: PhaseDurationMs
  }
}

/** Duration as `m:ss` (aligned with pipeline console logs). */
function formatDurationMinSec (ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) {
    return '—'
  }
  const totalSec = Math.round(ms / 1000)
  const min = Math.floor(totalSec / 60)
  const sec = totalSec % 60
  return `${String(min)}:${sec.toString().padStart(2, '0')}`
}

function messageForProxyFailure (status: number): string | null {
  if (status === 502 || status === 503 || status === 504) {
    return (
      'Le proxy Vite n’a pas pu joindre l’API studio (port 3001). '
      + 'Dans un autre terminal, à la racine du dépôt : node src/studio/style-guide-studio-api.mts'
    )
  }
  if (status === 404) {
    return (
      'Le port 3001 a répondu 404 pour cette route : ce n’est en général pas l’API studio à jour. '
      + 'Arrêtez le processus sur 3001 puis relancez à la racine du dépôt : node src/studio/style-guide-studio-api.mts '
      + '(pas src/server.mts, qui sert seulement les fichiers sur le port 3000).'
    )
  }
  return null
}

/** Must match `composeStyleGuideContextFromParts` in `src/studio/style-guide-studio-api.mts`. */
function composeStyleGuideContextFromParts (brand: string, context: string): string {
  const b = brand.trim()
  const c = context.trim()
  if (b.length > 0 && c.length > 0) {
    return `The brand is ${b} and the context is ${c}`
  }
  if (b.length > 0) {
    return 'The brand is '
      + b
      + ' and the context is not specified beyond the brand; infer positioning from official sites and current campaigns.'
  }
  if (c.length > 0) {
    return 'No commercial brand was specified. The context is '
      + c
      + '. Infer visuals, tone, typography, and color direction from official trailers, key art, and distributor or studio materials only; do not invent a corporate brand beyond this title or IP.'
  }
  return ''
}

const THEME_OPTIONS = [ 'light', 'dark', 'night', 'dim', 'nord' ] as const

const STUDIO_DOCUMENT_TITLE_DEFAULT = 'Style guide studio'

function documentTitleForRunStatus (runStatus: RunStatus): string {
  switch (runStatus) {
    case 'idle':
      return 'Prêt'
    case 'running':
      return '🔄 En cours'
    case 'success':
      return '✅ Terminé'
    case 'error':
      return '❌ Raté'
  }
}

function App () {
  const [brand, setBrand] = useState('')
  const [referenceUrl, setReferenceUrl] = useState('')
  const [referencePreflight, setReferencePreflight] = useState<ReferencePreflightUiState>('idle')
  const [referencePreflightMessage, setReferencePreflightMessage] = useState<string | null>(null)
  const [styleContext, setStyleContext] = useState('')
  const [status, setStatus] = useState<RunStatus>('idle')
  const [logs, setLogs] = useState<LogLine[]>([])
  const [outputDir, setOutputDir] = useState<string | null>(null)
  const [pipelineUsage, setPipelineUsage] = useState<PipelineUsagePayload | null>(null)
  const [pipelineUsageLoading, setPipelineUsageLoading] = useState(false)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [theme, setTheme] = useState<string>(() =>
    document.documentElement.getAttribute('data-theme') ?? 'light'
  )
  const logEndRef = useRef<HTMLDivElement>(null)
  const eventSourceRef = useRef<EventSource | null>(null)
  const [outputPreviews, setOutputPreviews] = useState<OutputFolderPreview[]>([])
  const [previewsLoading, setPreviewsLoading] = useState(false)
  const [previewsError, setPreviewsError] = useState<string | null>(null)
  const [exportingConfigKey, setExportingConfigKey] = useState<string | null>(null)
  const [selectedVersionByFolder, setSelectedVersionByFolder] = useState<Record<string, string>>({})
  const [previewModal, setPreviewModal] = useState<PreviewModalState | null>(null)
  const [catalog, setCatalog] = useState<StudioCatalog | null>(null)
  const [catalogError, setCatalogError] = useState<string | null>(null)
  const [creativeScript, setCreativeScript] = useState(PREFERRED_CREATIVE_SCRIPT)
  const [creativeOutputFolder, setCreativeOutputFolder] = useState('')
  const [creativeAdFormats, setCreativeAdFormats] = useState<CreativeAdFormat[]>(() => {
    const p = STUDIO_AD_PRESETS.find((x) => x.id === '320x480') ?? STUDIO_AD_PRESETS[0]
    return p !== undefined ? [{ id: p.id, width: p.width, height: p.height }] : []
  })
  const [customAdW, setCustomAdW] = useState('')
  const [customAdH, setCustomAdH] = useState('')
  const [creativeUiReview, setCreativeUiReview] = useState(true)
  const [styleGuideAssetsReview, setStyleGuideAssetsReview] = useState(true)
  const [creativeCodegenPreset, setCreativeCodegenPreset] = useState<'fast' | 'balanced' | 'quality'>('fast')
  const [lastRunKind, setLastRunKind] = useState<StudioRunKind | null>(null)
  const [preflightApiAvailable, setPreflightApiAvailable] = useState<boolean | null>(null)
  const preflightApiAvailableRef = useRef<boolean | null>(null)
  const preflightRequestIdRef = useRef(0)

  const creativeSupportsNativePipeline = creativeScript === PREFERRED_CREATIVE_SCRIPT
  const creativeSupportsUiReview = creativeSupportsNativePipeline

  const styleGuideOutputFolder =
    outputDir !== null ? outputFolderNameFromDirectoryPath(outputDir) : ''
  const canRetryAssetsReview =
    status === 'error' &&
    lastRunKind === 'style_guide' &&
    styleGuideOutputFolder.length > 0
  const canRetryUiReview =
    status === 'error' &&
    lastRunKind === 'creative' &&
    creativeSupportsUiReview &&
    creativeOutputFolder.trim().length > 0

  const referenceUrlTrimmed = referenceUrl.trim()
  const referenceBlocksLaunch =
    referenceUrlTrimmed.length > 0 &&
    preflightApiAvailable !== false &&
    (referencePreflight === 'checking' ||
      referencePreflight === 'blocked' ||
      referencePreflight === 'unreachable' ||
      referencePreflight === 'invalid')

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme)
  }, [ theme ])

  useEffect(() => {
    const trimmed = referenceUrl.trim()
    if (trimmed.length === 0) {
      setReferencePreflight('idle')
      setReferencePreflightMessage(null)
      return
    }
    let validHttps = false
    try {
      const u = new URL(trimmed)
      validHttps = u.protocol === 'https:'
    } catch {
      setReferencePreflight('invalid')
      setReferencePreflightMessage('URL invalide.')
      return
    }
    if (!validHttps) {
      setReferencePreflight('invalid')
      setReferencePreflightMessage('L’URL de référence doit être en HTTPS.')
      return
    }

    if (preflightApiAvailableRef.current === false) {
      setReferencePreflight('idle')
      setReferencePreflightMessage(null)
      return
    }

    const requestId = preflightRequestIdRef.current + 1
    preflightRequestIdRef.current = requestId
    const abort = new AbortController()
    const clientTimeout = window.setTimeout(() => {
      abort.abort()
    }, 35_000)

    setReferencePreflight('checking')
    setReferencePreflightMessage(null)
    const timer = window.setTimeout(() => {
      void fetch('/api/style-guide/preflight-reference-url', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ referenceUrl: trimmed }),
        signal: abort.signal
      })
        .then(async (res) => {
          if (preflightRequestIdRef.current !== requestId) {
            return
          }
          const contentType = res.headers.get('content-type') ?? ''
          const body = contentType.includes('application/json')
            ? await res.json() as ReferencePreflightResponse & { error?: string }
            : {}
          if (!res.ok) {
            const proxyMsg = messageForProxyFailure(res.status)
            if (proxyMsg !== null) {
              preflightApiAvailableRef.current = false
              setPreflightApiAvailable(false)
              setReferencePreflight('idle')
              setReferencePreflightMessage(proxyMsg)
              return
            }
            setReferencePreflight('unreachable')
            setReferencePreflightMessage(
              typeof body.error === 'string' && body.error.length > 0
                ? body.error
                : `Vérification échouée (HTTP ${String(res.status)}).`
            )
            return
          }
          const status = body.status
          if (
            status === 'ok' ||
            status === 'warning' ||
            status === 'blocked' ||
            status === 'unreachable' ||
            status === 'invalid'
          ) {
            setReferencePreflight(status)
            setReferencePreflightMessage(
              typeof body.message === 'string' ? body.message : null
            )
          } else {
            setReferencePreflight('unreachable')
            setReferencePreflightMessage('Réponse de préflight invalide.')
          }
        })
        .catch((e: unknown) => {
          if (preflightRequestIdRef.current !== requestId) {
            return
          }
          if (e instanceof Error && e.name === 'AbortError') {
            setReferencePreflight('warning')
            setReferencePreflightMessage(
              'Délai dépassé (site trop lent, ex. Uniqlo). Vous pouvez lancer la génération — le crawl complet sera tenté au lancement.'
            )
            return
          }
          setReferencePreflight('unreachable')
          setReferencePreflightMessage(e instanceof Error ? e.message : String(e))
        })
        .finally(() => {
          window.clearTimeout(clientTimeout)
        })
    }, 600)

    return () => {
      window.clearTimeout(timer)
      window.clearTimeout(clientTimeout)
      abort.abort()
      preflightRequestIdRef.current += 1
    }
  }, [ referenceUrl ])

  useEffect(() => {
    if (status !== 'success' || outputDir === null) {
      setPipelineUsage(null)
      return
    }
    const folder = outputFolderNameFromDirectoryPath(outputDir)
    if (folder.length === 0) {
      return
    }
    setPipelineUsageLoading(true)
    void fetch(`/api/output/${encodeURIComponent(folder)}/pipeline-usage`)
      .then(async (res) => (res.ok ? (await res.json() as PipelineUsagePayload) : null))
      .then((data) => { setPipelineUsage(data) })
      .catch(() => { setPipelineUsage(null) })
      .finally(() => { setPipelineUsageLoading(false) })
  }, [ status, outputDir ])

  useEffect(() => {
    document.title = documentTitleForRunStatus(status)
  }, [ status ])

  useEffect(() => {
    return () => {
      document.title = STUDIO_DOCUMENT_TITLE_DEFAULT
    }
  }, [])

  const toggleCreativePreset = useCallback((preset: StudioAdPreset) => {
    setCreativeAdFormats((prev) => {
      const idx = prev.findIndex(
        (f) => f.id === preset.id && f.width === preset.width && f.height === preset.height
      )
      if (idx >= 0) {
        if (prev.length <= 1) {
          return prev
        }
        return prev.filter((_, i) => i !== idx)
      }
      if (prev.length >= 8) {
        return prev
      }
      return [
        ...prev,
        {
          id: preset.id,
          width: preset.width,
          height: preset.height,
          ...(preset.arche !== undefined ? { arche: preset.arche } : {})
        }
      ]
    })
  }, [])

  const addCreativeCustomFormat = useCallback(() => {
    const w = Number.parseInt(customAdW.trim(), 10)
    const h = Number.parseInt(customAdH.trim(), 10)
    if (!Number.isFinite(w) || !Number.isFinite(h) || w < 16 || h < 16 || w > 4096 || h > 4096) {
      return
    }
    setCreativeAdFormats((prev) => {
      if (prev.some((f) => f.width === w && f.height === h)) {
        return prev
      }
      if (prev.length >= 8) {
        return prev
      }
      return [ ...prev, { id: `custom-${String(w)}x${String(h)}`, width: w, height: h } ]
    })
    setCustomAdW('')
    setCustomAdH('')
  }, [ customAdW, customAdH ])

  useEffect(() => {
    return () => {
      eventSourceRef.current?.close()
    }
  }, [])

  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [ logs ])

  const loadOutputPreviews = useCallback(async () => {
    setPreviewsError(null)
    setPreviewsLoading(true)
    try {
      const res = await fetch('/api/output/index-html-previews')
      if (!res.ok) {
        setPreviewsError(messageForProxyFailure(res.status) ?? `HTTP ${String(res.status)}`)
        return
      }
      const data = await res.json() as { previews?: unknown }
      if (!Array.isArray(data.previews)) {
        setPreviewsError('Réponse API invalide.')
        return
      }
      const list: OutputFolderPreview[] = []
      for (const row of data.previews) {
        if (typeof row !== 'object' || row === null) {
          continue
        }
        const folder = row as OutputFolderPreview
        if (
          typeof folder.folderName !== 'string' ||
          typeof folder.pageTitle !== 'string' ||
          typeof folder.versionCount !== 'number' ||
          typeof folder.mtimeMs !== 'number' ||
          !Array.isArray(folder.versions)
        ) {
          continue
        }
        const versions: OutputPreviewVersion[] = []
        for (const v of folder.versions) {
          if (
            typeof v === 'object' &&
            v !== null &&
            typeof (v as OutputPreviewVersion).versionId === 'string' &&
            typeof (v as OutputPreviewVersion).versionLabel === 'string' &&
            typeof (v as OutputPreviewVersion).relativePath === 'string' &&
            typeof (v as OutputPreviewVersion).previewUrl === 'string' &&
            typeof (v as OutputPreviewVersion).mtimeMs === 'number' &&
            typeof (v as OutputPreviewVersion).pageTitle === 'string'
          ) {
            versions.push(v as OutputPreviewVersion)
          }
        }
        if (versions.length === 0) {
          continue
        }
        list.push({
          folderName: folder.folderName,
          pageTitle: folder.pageTitle,
          versionCount: folder.versionCount,
          versions,
          mtimeMs: folder.mtimeMs
        })
      }
      setOutputPreviews(list)
    } catch (e) {
      setPreviewsError(e instanceof Error ? e.message : String(e))
    } finally {
      setPreviewsLoading(false)
    }
  }, [])

  const loadCatalog = useCallback(async () => {
    setCatalogError(null)
    try {
      const res = await fetch('/api/studio/catalog')
      if (!res.ok) {
        setCatalogError(messageForProxyFailure(res.status) ?? `HTTP ${String(res.status)}`)
        setCatalog(null)
        return
      }
      const raw = await res.json() as {
        styleGuideScripts?: unknown
        creativeCodeScripts?: unknown
        outputFoldersWithStyleGuide?: unknown
        capabilities?: { preflightReferenceUrl?: unknown }
      }
      if (
        !Array.isArray(raw.styleGuideScripts) ||
        !Array.isArray(raw.creativeCodeScripts) ||
        !Array.isArray(raw.outputFoldersWithStyleGuide)
      ) {
        setCatalogError('Réponse catalogue invalide.')
        setCatalog(null)
        return
      }
      const styleGuideScripts = raw.styleGuideScripts.filter((x): x is string => typeof x === 'string')
      const creativeCodeScripts = raw.creativeCodeScripts.filter((x): x is string => typeof x === 'string')
      const folders: StudioCatalog['outputFoldersWithStyleGuide'] = []
      for (const row of raw.outputFoldersWithStyleGuide) {
        if (
          typeof row === 'object' &&
          row !== null &&
          typeof (row as { folderName?: unknown }).folderName === 'string' &&
          typeof (row as { mtimeMs?: unknown }).mtimeMs === 'number'
        ) {
          folders.push({
            folderName: (row as { folderName: string }).folderName,
            mtimeMs: (row as { mtimeMs: number }).mtimeMs,
            codeVersionCount:
              typeof (row as { codeVersionCount?: unknown }).codeVersionCount === 'number'
                ? (row as { codeVersionCount: number }).codeVersionCount
                : 0
          })
        }
      }
      const capabilities =
        typeof raw.capabilities === 'object' && raw.capabilities !== null
          ? {
              preflightReferenceUrl: raw.capabilities.preflightReferenceUrl === true
            }
          : undefined
      const next: StudioCatalog = {
        styleGuideScripts,
        creativeCodeScripts,
        outputFoldersWithStyleGuide: folders,
        ...(capabilities !== undefined ? { capabilities } : {})
      }
      setCatalog(next)
      const apiOk = capabilities?.preflightReferenceUrl === true
      preflightApiAvailableRef.current = apiOk
      setPreflightApiAvailable(apiOk)

      setCreativeScript((prev) => {
        if (creativeCodeScripts.includes(prev)) {
          return prev
        }
        if (creativeCodeScripts.includes(PREFERRED_CREATIVE_SCRIPT)) {
          return PREFERRED_CREATIVE_SCRIPT
        }
        const native = creativeCodeScripts.find((n) => n.includes('native'))
        return native ?? creativeCodeScripts[0] ?? PREFERRED_CREATIVE_SCRIPT
      })
      setCreativeOutputFolder((prev) => {
        const names = folders.map((f) => f.folderName)
        if (prev !== '' && names.includes(prev)) {
          return prev
        }
        return names[0] ?? ''
      })
    } catch (e) {
      setCatalogError(e instanceof Error ? e.message : String(e))
      setCatalog(null)
    }
  }, [])

  useEffect(() => {
    const id = window.setTimeout(() => {
      void loadOutputPreviews()
    }, 0)
    return () => {
      window.clearTimeout(id)
    }
  }, [ loadOutputPreviews ])

  useEffect(() => {
    if (status !== 'success') {
      return
    }
    const id = window.setTimeout(() => {
      void loadOutputPreviews()
      void loadCatalog()
    }, 0)
    return () => {
      window.clearTimeout(id)
    }
  }, [ status, loadOutputPreviews, loadCatalog ])

  useEffect(() => {
    const id = window.setTimeout(() => {
      void loadCatalog()
    }, 0)
    return () => {
      window.clearTimeout(id)
    }
  }, [ loadCatalog ])

  useEffect(() => {
    if (previewModal === null) {
      return
    }
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        setPreviewModal(null)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [ previewModal ])

  const resolvePreviewVersion = useCallback(
    (row: OutputFolderPreview): OutputPreviewVersion => {
      const selectedId = selectedVersionByFolder[row.folderName]
      if (selectedId !== undefined) {
        const match = row.versions.find((v) => v.versionId === selectedId)
        if (match !== undefined) {
          return match
        }
      }
      return row.versions[row.versions.length - 1]!
    },
    [ selectedVersionByFolder ]
  )

  const downloadGenericConfig = useCallback(
    async (row: OutputFolderPreview) => {
      const v = resolvePreviewVersion(row)
      setExportingConfigKey(row.folderName)
      setPreviewsError(null)
      try {
        const url =
          `/api/output/${encodeURIComponent(row.folderName)}/generic-config?version=${encodeURIComponent(v.versionId)}`
        const res = await fetch(url)
        if (!res.ok) {
          let errText = `HTTP ${String(res.status)}`
          try {
            const errBody = await res.json() as { error?: unknown }
            if (typeof errBody.error === 'string' && errBody.error.length > 0) {
              errText = errBody.error
            }
          } catch {
            /* ignore */
          }
          setPreviewsError(errText)
          return
        }
        const blob = await res.blob()
        const disp = res.headers.get('Content-Disposition')
        let filename = `${row.folderName}-${v.versionId}-generic-config.json`
        const nameMatch = disp?.match(/filename="([^"]+)"/u)
        if (nameMatch?.[1] !== undefined) {
          filename = nameMatch[1]
        }
        const objectUrl = URL.createObjectURL(blob)
        const anchor = document.createElement('a')
        anchor.href = objectUrl
        anchor.download = filename
        anchor.click()
        URL.revokeObjectURL(objectUrl)
      } catch (e) {
        setPreviewsError(e instanceof Error ? e.message : String(e))
      } finally {
        setExportingConfigKey(null)
      }
    },
    [ resolvePreviewVersion ]
  )

  const appendLog = useCallback((entry: LogLine) => {
    setLogs((prev) => [ ...prev, entry ])
  }, [])

  const subscribeToJobEvents = useCallback((jobId: string) => {
    eventSourceRef.current?.close()
    const es = new EventSource(`/api/style-guide/stream/${jobId}`)
    eventSourceRef.current = es

    es.addEventListener('log', (ev: MessageEvent) => {
      try {
        const parsed = JSON.parse(ev.data as string) as LogLine
        if (typeof parsed.text === 'string' && (parsed.source === 'stdout' || parsed.source === 'stderr')) {
          appendLog(parsed)
        }
      } catch {
        appendLog({ source: 'stderr', text: ev.data as string })
      }
    })

    es.addEventListener('done', (ev: MessageEvent) => {
      try {
        const payload = JSON.parse(ev.data as string) as { outputDirectoryPath?: string | null }
        if (typeof payload.outputDirectoryPath === 'string' && payload.outputDirectoryPath.length > 0) {
          setOutputDir(payload.outputDirectoryPath)
          const folder = outputFolderNameFromDirectoryPath(payload.outputDirectoryPath)
          if (folder.length > 0) {
            setCreativeOutputFolder(folder)
          }
        }
      } catch {
        /* ignore */
      }
      setStatus('success')
      es.close()
      eventSourceRef.current = null
    })

    es.addEventListener('failed', (ev: MessageEvent) => {
      let msg = 'Le job a échoué.'
      try {
        const payload = JSON.parse(ev.data as string) as {
          message?: string
          outputDirectoryPath?: string | null
        }
        if (typeof payload.message === 'string') {
          msg = payload.message
        }
        if (typeof payload.outputDirectoryPath === 'string' && payload.outputDirectoryPath.length > 0) {
          setOutputDir(payload.outputDirectoryPath)
          const folder = outputFolderNameFromDirectoryPath(payload.outputDirectoryPath)
          if (folder.length > 0) {
            setCreativeOutputFolder(folder)
          }
        }
      } catch {
        /* keep default */
      }
      setErrorMessage(msg)
      setStatus('error')
      es.close()
      eventSourceRef.current = null
    })

    es.onerror = () => {
      if (es.readyState === EventSource.CLOSED) {
        return
      }
      setStatus((s) => (s === 'running' ? 'error' : s))
      setErrorMessage((m) => m ?? 'Connexion SSE interrompue.')
      es.close()
      eventSourceRef.current = null
    }
  }, [appendLog])

  const runStudioJob = useCallback(
    async (url: string, body: Record<string, unknown>, runKind: StudioRunKind) => {
      setErrorMessage(null)
      setLogs([])
      setStatus('running')
      setLastRunKind(runKind)
      eventSourceRef.current?.close()

      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body)
        })

        if (res.status === 429) {
          setStatus('error')
          setErrorMessage('Un job studio est déjà en cours. Attendez la fin ou rafraîchissez.')
          return
        }

        if (!res.ok) {
          const proxyMsg = messageForProxyFailure(res.status)
          if (proxyMsg !== null) {
            setStatus('error')
            setErrorMessage(proxyMsg)
            return
          }
          const errBody = await res.json().catch(() => ({})) as { error?: string }
          setStatus('error')
          setErrorMessage(errBody.error ?? `HTTP ${String(res.status)}`)
          return
        }

        const data = await res.json() as { jobId?: string }
        if (typeof data.jobId !== 'string' || data.jobId.length === 0) {
          setStatus('error')
          setErrorMessage('Réponse API invalide (jobId manquant).')
          return
        }

        subscribeToJobEvents(data.jobId)
      } catch (e) {
        setStatus('error')
        setErrorMessage(e instanceof Error ? e.message : String(e))
      }
    },
    [subscribeToJobEvents]
  )

  const run = useCallback(async () => {
    setOutputDir(null)
    await runStudioJob(
      '/api/style-guide/run',
      {
        brand,
        context: styleContext,
        referenceUrl: referenceUrl.trim().length > 0 ? referenceUrl.trim() : undefined,
        contextPrompt: composeStyleGuideContextFromParts(brand, styleContext),
        assetsReviewAfterGeneration: styleGuideAssetsReview
      },
      'style_guide'
    )
  }, [brand, referenceUrl, styleContext, styleGuideAssetsReview, runStudioJob])

  const retryAssetsReview = useCallback(async () => {
    if (!canRetryAssetsReview) {
      return
    }
    await runStudioJob(
      '/api/style-guide/review-assets',
      {
        outputFolder: styleGuideOutputFolder
      },
      'style_guide'
    )
  }, [canRetryAssetsReview, styleGuideOutputFolder, runStudioJob])

  const runCreative = useCallback(async () => {
    setOutputDir(null)
    await runStudioJob(
      '/api/creative-code/run',
      {
        creativeScript,
        outputFolder: creativeOutputFolder,
        adFormats: creativeAdFormats,
        assetsReviewBeforeGeneration: false,
        uiReviewAfterGeneration: creativeSupportsUiReview && creativeUiReview,
        creativeCodegenPreset: creativeSupportsNativePipeline ? creativeCodegenPreset : undefined
      },
      'creative'
    )
  }, [
    creativeAdFormats,
    creativeOutputFolder,
    creativeScript,
    creativeSupportsNativePipeline,
    creativeSupportsUiReview,
    creativeUiReview,
    creativeCodegenPreset,
    runStudioJob
  ])

  const retryUiReview = useCallback(async () => {
    if (!canRetryUiReview) {
      return
    }
    await runStudioJob(
      '/api/creative-code/review-ui',
      {
        outputFolder: creativeOutputFolder.trim(),
        adFormats: creativeAdFormats
      },
      'creative'
    )
  }, [canRetryUiReview, creativeOutputFolder, creativeAdFormats, runStudioJob])

  const statusBadge =
    status === 'idle'
      ? <span className="badge badge-sm badge-soft badge-neutral rounded-full px-3">Prêt</span>
      : status === 'running'
        ? <span className="badge badge-sm badge-soft badge-info rounded-full px-3">En cours</span>
        : status === 'success'
          ? <span className="badge badge-sm badge-soft badge-success rounded-full px-3">Terminé</span>
          : <span className="badge badge-sm badge-soft badge-error rounded-full px-3">Erreur</span>

  return (
    <div className="studio-app-shell flex min-h-dvh flex-col font-sans text-base-content antialiased">
      <header className="navbar sticky top-0 z-40 border-b border-base-300/40 bg-base-100/80 px-3 py-3 shadow-sm backdrop-blur-xl sm:px-6">
        <div className="navbar-start flex items-center gap-3">

          <div className="flex min-w-0 flex-col leading-tight">
            <span className="truncate text-base font-semibold tracking-tight sm:text-lg">Style guide studio</span>
            <span className="text-[11px] font-medium uppercase tracking-[0.14em] text-base-content/90 sm:text-xs">
              src/ · pipeline Claude
            </span>
          </div>
        </div>
        <div className="navbar-end flex flex-wrap items-center gap-2">
          {status === 'running' && (
            <span className="loading loading-spinner loading-md text-primary" aria-hidden="true" />
          )}
          {statusBadge}
          <details className="dropdown dropdown-end">
            <summary className="btn btn-sm rounded-full border border-base-300/60 bg-base-100/90 shadow-sm backdrop-blur-sm">
              Thème
            </summary>
            <ul className="dropdown-content menu z-50 mt-2 w-52 rounded-2xl border border-base-300/60 bg-base-100/95 p-2 shadow-xl shadow-base-content/10 backdrop-blur-md">
              {THEME_OPTIONS.map((t) => (
                <li key={t}>
                  <button
                    type="button"
                    className={`rounded-xl ${theme === t ? 'bg-primary/10 font-semibold text-primary' : ''}`}
                    onClick={() => { setTheme(t); }}
                  >
                    {t}
                  </button>
                </li>
              ))}
            </ul>
          </details>
        </div>
      </header>

      <main className="container mx-auto flex min-w-0 max-w-3xl flex-1 flex-col gap-10 px-4 py-10 sm:px-6 lg:max-w-5xl">

        <div className="text-center sm:text-left">
          <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-base-content/40">Pipeline créatif</p>
          <h1 className="mt-1 text-2xl font-bold tracking-tight sm:text-3xl">Guides & mini-apps</h1>
          <p className="mx-auto mt-3 max-w-2xl text-sm leading-relaxed text-base-content/55 sm:mx-0">
            Contexte produit → génération Claude → artefacts dans{' '}
            <code className="rounded-md bg-base-300/50 px-1.5 py-0.5 font-mono text-xs">output/</code>
            . Aperçus alignés sur le <code className="font-mono text-xs">&lt;title&gt;</code> de chaque page.
          </p>
        </div>

        {errorMessage !== null && (
          <div
            role="alert"
            className="alert alert-soft alert-error rounded-2xl border border-error/15 shadow-lg shadow-error/10 sm:alert-horizontal"
          >
            <span className="text-sm leading-relaxed">{errorMessage}</span>
          </div>
        )}

        {outputDir !== null && status === 'success' && (
          <div
            role="status"
            className="alert alert-soft alert-success rounded-2xl border border-success/15 shadow-md shadow-success/10 sm:alert-horizontal"
          >
            <span className="text-sm leading-relaxed">
              Sortie écrite sous{' '}
              <code className="break-all rounded-md bg-base-100/60 px-1.5 py-0.5 font-mono text-xs">{outputDir}</code>
            </span>
          </div>
        )}

        {outputDir !== null && status === 'success' && (
          <section className="rounded-2xl border border-base-300/50 bg-base-100/80 px-4 py-4 shadow-sm">
            <h3 className="text-sm font-semibold text-base-content">Coûts et durées</h3>
            {pipelineUsageLoading && (
              <p className="mt-2 text-xs text-base-content/60">Chargement de pipeline-usage.json…</p>
            )}
            {!pipelineUsageLoading && pipelineUsage === null && (
              <p className="mt-2 text-xs text-base-content/60">
                Pas de ledger pipeline pour ce dossier (run antérieur ou étape sans API).
              </p>
            )}
            {pipelineUsage !== null && (
              <div className="mt-3 space-y-3 text-sm">
                <div className="flex flex-wrap gap-x-6 gap-y-1 font-mono text-xs text-base-content/80">
                  <span>
                    Total USD :{' '}
                    <strong className="text-base-content">${pipelineUsage.totals.price_usd.total.toFixed(4)}</strong>
                  </span>
                  <span>
                    Temps étapes : <strong className="text-base-content">{formatDurationMinSec(pipelineUsage.totals.duration_ms)}</strong>
                  </span>
                  {(pipelineUsage.totals.phase_duration_ms !== undefined
                    || pipelineUsage.run_summary?.phase_duration_ms !== undefined) && (
                    <>
                      <span>
                        Style guide :{' '}
                        <strong className="text-base-content">
                          {formatDurationMinSec(
                            pipelineUsage.totals.phase_duration_ms?.style_guide
                              ?? pipelineUsage.run_summary?.phase_duration_ms?.style_guide
                              ?? 0
                          )}
                        </strong>
                      </span>
                      <span>
                        Format de pub :{' '}
                        <strong className="text-base-content">
                          {formatDurationMinSec(
                            pipelineUsage.totals.phase_duration_ms?.creative
                              ?? pipelineUsage.run_summary?.phase_duration_ms?.creative
                              ?? 0
                          )}
                        </strong>
                      </span>
                    </>
                  )}
                  <span>
                    API Claude :{' '}
                    <strong className="text-base-content">{formatDurationMinSec(pipelineUsage.totals.claude_api_duration_ms)}</strong>
                  </span>
                  {pipelineUsage.run_summary !== undefined && (
                    <span>
                      Job studio :{' '}
                      <strong className="text-base-content">{formatDurationMinSec(pipelineUsage.run_summary.wall_clock_ms)}</strong>
                    </span>
                  )}
                  <span>
                    Tokens : {String(pipelineUsage.totals.billed_input_tokens)} in /{' '}
                    {String(pipelineUsage.totals.output_tokens)} out
                  </span>
                </div>
                <div className="overflow-x-auto rounded-xl border border-base-300/40">
                  <table className="table table-xs">
                    <thead>
                      <tr>
                        <th>Étape</th>
                        <th>Phase</th>
                        <th>Modèle</th>
                        <th>Durée</th>
                        <th>Tokens</th>
                        <th>USD</th>
                      </tr>
                    </thead>
                    <tbody>
                      {pipelineUsage.entries.map((entry, idx) => (
                        <tr key={`${entry.action}-${String(idx)}`}>
                          <td className="font-mono">
                            {entry.action}
                            {entry.review_round !== null ? ` (r${String(entry.review_round)})` : ''}
                          </td>
                          <td className="font-mono text-[10px] text-base-content/70">
                            {entry.phase ?? (entry.action === 'style_guide' ? 'style_guide' : 'creative')}
                          </td>
                          <td className="max-w-[8rem] truncate font-mono text-[10px]">{entry.model ?? '—'}</td>
                          <td>
                            {entry.duration_ms !== undefined ? formatDurationMinSec(entry.duration_ms) : '—'}
                            {entry.sub_step_timings !== undefined && entry.sub_step_timings.length > 0 && (
                              <ul className="mt-1 list-none space-y-0.5 font-mono text-[10px] text-base-content/55">
                                {entry.sub_step_timings.map((s) => (
                                  <li key={s.label}>
                                    {s.label} : {formatDurationMinSec(s.duration_ms)}
                                  </li>
                                ))}
                              </ul>
                            )}
                            {entry.api_call_timings !== undefined && entry.api_call_timings.length > 0 && (
                              <ul className="mt-1 list-none space-y-0.5 font-mono text-[10px] text-base-content/55">
                                {entry.api_call_timings.map((t) => (
                                  <li key={t.call_index}>
                                    {t.label ?? `call ${String(t.call_index)}`} : {formatDurationMinSec(t.duration_ms)}
                                  </li>
                                ))}
                              </ul>
                            )}
                          </td>
                          <td className="font-mono text-[10px]">
                            {String(entry.billed_input_tokens)} / {String(entry.output_tokens)}
                          </td>
                          <td className="font-mono">${entry.price_usd.total.toFixed(4)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </section>
        )}

        {catalogError !== null && (
          <div
            role="alert"
            className="alert alert-soft alert-warning rounded-2xl border border-warning/20 text-sm sm:alert-horizontal"
          >
            <span>
              Impossible de charger le catalogue <code className="font-mono text-xs">src/agents/</code> : {catalogError}
            </span>
          </div>
        )}

        <section className="card min-w-0 w-full rounded-3xl border border-base-300/50 bg-base-100 shadow-xl shadow-black/5 ring-1 ring-black/5 dark:ring-white/10 dark:shadow-black/25">
          <div className="border-b border-base-300/40 bg-linear-to-br from-base-200/50 via-base-100/80 to-primary/[0.07] px-6 py-6 sm:px-8">
            <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-primary/90">Génération</p>
            <h2 className="mt-1.5 text-xl font-semibold tracking-tight sm:text-2xl">Marque ou contenu</h2>
            <p className="mt-2 max-w-prose text-sm leading-relaxed text-base-content/55">
              Marque commerciale et/ou contexte (film, série, produit, campagne) : au moins un des deux pour lancer.
              Assemblé en anglais pour le modèle puis envoyé via{' '}
              <code className="font-mono text-xs">STYLE_GUIDE_CONTEXT</code>.
            </p>
          </div>
          <div className="card-body min-w-0 gap-6 px-6 pb-8 pt-6 sm:px-8">

            <fieldset className="fieldset min-w-0 w-full max-w-full">
              <legend className="fieldset-legend text-base-content/60">Prompt</legend>
              <div className="grid min-w-0 gap-4 sm:grid-cols-2">
                <label className="form-control min-w-0 w-full">
                  <span className="label-text text-xs font-semibold uppercase tracking-wider text-base-content/50">
                    Marque <span className="font-normal normal-case text-base-content/40">(optionnel)</span>
                  </span>
                  <input
                    type="text"
                    className="input input-bordered box-border w-full min-w-0 max-w-full rounded-2xl border-base-300 bg-base-100 font-mono text-sm transition-[border-color,box-shadow] placeholder:text-base-content/35 focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/15"
                    placeholder="Ex. Peugeot — laisser vide pour un film / titre sans marque"
                    value={brand}
                    onChange={(e) => { setBrand(e.target.value); }}
                    disabled={status === 'running'}
                    aria-label="Marque"
                    autoComplete="organization"
                  />
                </label>
                <label className="form-control min-w-0 w-full sm:col-span-2">
                  <span className="label-text block max-w-full break-words whitespace-normal text-xs font-semibold uppercase tracking-wider text-base-content/50">
                    URL de référence{' '}
                    <span className="font-normal normal-case text-base-content/40">(collection / campagne, optionnel)</span>
                  </span>
                  <input
                    type="url"
                    className="input input-bordered box-border w-full min-w-0 max-w-full overflow-x-auto rounded-2xl border-base-300 bg-base-100 font-mono text-sm transition-[border-color,box-shadow] placeholder:text-base-content/35 focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/15"
                    placeholder="https://www.petit-bateau.fr/collection/collection-ete/"
                    value={referenceUrl}
                    onChange={(e) => { setReferenceUrl(e.target.value); }}
                    disabled={status === 'running'}
                    aria-label="URL de référence campagne"
                  />
                  {preflightApiAvailable === false
                    ? (
                      <div className="alert alert-warning mt-2 py-2 text-sm" role="status">
                        API studio obsolète (route de préflight absente). Arrêtez le processus sur le port
                        {' '}
                        <span className="font-mono">3001</span>
                        {' '}
                        puis relancez :
                        {' '}
                        <span className="font-mono text-xs">node src/studio/style-guide-studio-api.mts</span>
                      </div>
                      )
                    : null}
                  {referencePreflight === 'checking' && referenceUrlTrimmed.length > 0
                    ? (
                      <p className="field-hint mt-2 text-sm text-base-content/60" role="status">
                        <span className="loading loading-spinner loading-xs mr-2 align-middle" aria-hidden="true" />
                        Vérification de l’URL de référence…
                      </p>
                      )
                    : null}
                  {referencePreflightMessage !== null &&
                    referencePreflight !== 'idle' &&
                    referencePreflight !== 'checking' &&
                    preflightApiAvailable !== false
                    ? (
                      <div
                        className={
                          referencePreflight === 'ok'
                            ? 'alert alert-success mt-2 py-2 text-sm'
                            : referencePreflight === 'warning'
                              ? 'alert alert-warning mt-2 py-2 text-sm'
                              : 'alert alert-error mt-2 py-2 text-sm'
                        }
                        role="status"
                      >
                        {referencePreflightMessage}
                      </div>
                      )
                    : null}
                </label>
                <label className="form-control min-w-0 w-full sm:col-span-2">
                  <span className="label-text text-xs font-semibold uppercase tracking-wider text-base-content/50">
                    Contexte <span className="font-normal normal-case text-base-content/40">(optionnel si marque remplie)</span>
                  </span>
                  <textarea
                    className="textarea textarea-bordered studio-textarea-field box-border w-full min-h-28 min-w-0 max-w-full rounded-2xl border-base-300 bg-base-100 font-mono text-sm leading-relaxed break-words transition-[border-color,box-shadow] placeholder:text-base-content/35 focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/15 md:min-h-32 md:text-[15px]"
                    placeholder="Ex. feature film Dune: Part Two, theatrical one-sheet and social campaign — ou produit / campagne si marque renseignée."
                    value={styleContext}
                    onChange={(e) => { setStyleContext(e.target.value); }}
                    disabled={status === 'running'}
                    aria-label="Contexte produit ou campagne"
                  />
                </label>
              </div>
              <p className="field-hint mt-2 text-sm leading-relaxed text-base-content/50">
                L’URL de référence est vérifiée avant le lancement (page + échantillon d’images). Si le site bloque l’accès automatique, modifiez l’URL pour éviter une génération inutile.
                Pour une marque seule, le contexte peut rester vide. Pour un film sans marque, décrivez le titre dans le contexte.
              </p>
            </fieldset>
            <label className="flex cursor-pointer items-start gap-3 rounded-2xl border border-base-300/50 bg-base-200/15 px-4 py-4">
              <input
                type="checkbox"
                className="checkbox checkbox-primary mt-0.5 shrink-0"
                checked={styleGuideAssetsReview}
                disabled={status === 'running'}
                onChange={(e) => { setStyleGuideAssetsReview(e.target.checked); }}
                aria-label="Review assets après style guide"
              />
              <span className="text-sm leading-relaxed text-base-content/85">
                <span className="font-medium text-base-content">Review assets après génération</span>
                {' '}
                — enchaîne{' '}
                <code className="font-mono text-xs">run-style-guide-assets-review.mts</code>
                {' '}
                (contrôles + descriptions vision Haiku pour la pub) avant toute génération créative. Produit{' '}
                <code className="font-mono text-xs">review/assets-review-final.json</code>
                {' '}
                et{' '}
                <code className="font-mono text-xs">review/asset-descriptions.json</code>.
              </span>
            </label>
            <div className="card-actions flex-col items-stretch gap-3 border-t border-base-300/30 pt-6 sm:flex-row sm:flex-wrap sm:justify-end">
              <button
                type="button"
                className="btn btn-outline rounded-xl px-6 disabled:opacity-50"
                disabled={status === 'running' || !canRetryAssetsReview}
                title={
                  canRetryAssetsReview
                    ? 'Relancer uniquement run-style-guide-assets-review.mts'
                    : 'Disponible après un échec de génération style guide (dossier output connu)'
                }
                onClick={() => { void retryAssetsReview(); }}
              >
                {status === 'running' && lastRunKind === 'style_guide'
                  ? (
                    <>
                      <span className="loading loading-spinner loading-sm" aria-hidden="true" />
                      Revue assets…
                    </>
                    )
                  : (
                      'Relancer revue assets'
                    )}
              </button>
              <button
                type="button"
                className="btn btn-primary rounded-xl px-8 shadow-lg shadow-primary/20 transition-[filter,transform] hover:brightness-105 active:scale-[0.99] disabled:shadow-none"
                disabled={
                  status === 'running'
                  || referenceBlocksLaunch
                  || (brand.trim().length === 0
                    && styleContext.trim().length === 0
                    && referenceUrl.trim().length === 0)
                  || (catalog?.styleGuideScripts.length ?? 0) === 0
                }
                onClick={() => { void run(); }}
              >
                {status === 'running' && lastRunKind === 'style_guide'
                  ? (
                    <>
                      <span className="loading loading-spinner loading-sm" aria-hidden="true" />
                      Génération…
                    </>
                    )
                  : (
                      'Lancer la génération'
                    )}
              </button>
            </div>
          </div>
        </section>

        <section className="card min-w-0 w-full rounded-3xl border border-base-300/50 bg-base-100 shadow-xl shadow-black/5 ring-1 ring-black/5 dark:ring-white/10 dark:shadow-black/25">
          <div className="border-b border-base-300/40 bg-base-200/35 px-6 py-6 sm:px-8">
            <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-secondary/90">Code créatif</p>
            <h2 className="mt-1.5 text-xl font-semibold tracking-tight sm:text-2xl">gen-creative-code*</h2>
            <p className="mt-2 max-w-prose text-sm leading-relaxed text-base-content/55">
              Lance un script <code className="font-mono text-xs">gen-creative-code*.mts</code> sur un dossier{' '}
              <code className="font-mono text-xs">output/&lt;run&gt;/</code> qui contient déjà{' '}
              <code className="font-mono text-xs">style-guide.json</code>. Chaque lancement crée une nouvelle version sous{' '}
              <code className="font-mono text-xs">code/V1</code>, <code className="font-mono text-xs">code/V2</code>, etc.
            </p>
          </div>
          <div className="card-body min-w-0 gap-6 px-6 pb-8 pt-6 sm:px-8">
            <div className="relative z-10 grid min-w-0 gap-5 sm:grid-cols-2">
              <label className="form-control relative z-20 min-w-0 w-full">
                <span className="label-text text-xs font-semibold uppercase tracking-wider text-base-content/50">
                  Script <code className="font-mono normal-case">src/agents/</code>
                </span>
                <select
                  className="studio-select-solid select select-bordered w-full rounded-2xl border-base-300 bg-base-100 font-mono text-sm text-base-content shadow-sm"
                  value={creativeScript}
                  disabled={status === 'running' || (catalog?.creativeCodeScripts.length ?? 0) === 0}
                  onChange={(e) => { setCreativeScript(e.target.value); }}
                  aria-label="Script gen-creative-code"
                >
                  {(catalog?.creativeCodeScripts ?? []).map((name) => (
                    <option key={name} value={name}>{name}</option>
                  ))}
                </select>
              </label>
              <label className="form-control relative z-20 min-w-0 w-full">
                <span className="label-text text-xs font-semibold uppercase tracking-wider text-base-content/50">
                  Dossier <code className="font-mono normal-case">output/</code>
                </span>
                <select
                  className="studio-select-solid select select-bordered w-full rounded-2xl border-base-300 bg-base-100 font-mono text-sm text-base-content shadow-sm"
                  value={creativeOutputFolder}
                  disabled={status === 'running' || (catalog?.outputFoldersWithStyleGuide.length ?? 0) === 0}
                  onChange={(e) => { setCreativeOutputFolder(e.target.value); }}
                  aria-label="Dossier output avec style-guide.json"
                >
                  {(catalog?.outputFoldersWithStyleGuide ?? []).map((row) => (
                    <option key={row.folderName} value={row.folderName}>
                      {row.folderName}
                      {row.codeVersionCount > 0
                        ? ` · ${String(row.codeVersionCount)} format${row.codeVersionCount > 1 ? 's' : ''}`
                        : ''}
                    </option>
                  ))}
                </select>
                <span className="label-text-alt text-base-content/90">
                  Tous les dossiers avec <code className="font-mono text-xs">style-guide.json</code> ; le nombre de formats déjà générés est indiqué quand il existe.
                </span>
              </label>
            </div>
            <fieldset className="rounded-2xl border border-base-300/50 bg-base-200/15 px-4 py-4">
              <legend className="px-1 text-xs font-semibold uppercase tracking-wider text-base-content/50">
                Formats pub (IAB) — <code className="font-mono normal-case text-[11px]">gen-creative-code-native.mts</code>
              </legend>
              <p className="mb-3 text-xs leading-relaxed text-base-content/55">
                Cochez une ou plusieurs tailles (max. 8). Dimensions personnalisées : 16–4096 px. Au moins un format doit rester sélectionné.
                L’option <strong>Arche 1600×960</strong> applique header 200 px, gouttières 230 px, trou central, budget image cible 150 Ko (JPEG/PNG), tracking pixel + clic documenté ; combinez avec 300×250 ou 300×600 pour des compagnons.
              </p>
              <div className="grid max-h-52 gap-2 overflow-y-auto sm:grid-cols-2">
                {STUDIO_AD_PRESETS.map((preset) => {
                  const checked = creativeAdFormats.some(
                    (f) => f.id === preset.id && f.width === preset.width && f.height === preset.height
                  )
                  return (
                    <label
                      key={preset.id}
                      className="flex cursor-pointer items-start gap-2 rounded-xl border border-base-300/40 bg-base-100/70 px-3 py-2 text-sm shadow-sm transition-colors hover:bg-base-100"
                    >
                      <input
                        type="checkbox"
                        className="checkbox checkbox-sm checkbox-primary mt-0.5 shrink-0"
                        checked={checked}
                        disabled={status === 'running' || (checked && creativeAdFormats.length <= 1)}
                        onChange={() => { toggleCreativePreset(preset); }}
                      />
                      <span className="leading-snug text-base-content/90">{preset.label}</span>
                    </label>
                  )
                })}
              </div>
              <div className="mt-4 flex flex-col gap-2 border-t border-base-300/30 pt-4 sm:flex-row sm:flex-wrap sm:items-end">
                <label className="form-control sm:w-28">
                  <span className="label-text text-[10px] font-semibold uppercase tracking-wider text-base-content/45">Largeur px</span>
                  <input
                    type="number"
                    min={16}
                    max={4096}
                    className="input input-bordered input-sm w-full rounded-xl font-mono"
                    value={customAdW}
                    onChange={(e) => { setCustomAdW(e.target.value); }}
                    disabled={status === 'running'}
                    aria-label="Largeur personnalisée"
                  />
                </label>
                <label className="form-control sm:w-28">
                  <span className="label-text text-[10px] font-semibold uppercase tracking-wider text-base-content/45">Hauteur px</span>
                  <input
                    type="number"
                    min={16}
                    max={4096}
                    className="input input-bordered input-sm w-full rounded-xl font-mono"
                    value={customAdH}
                    onChange={(e) => { setCustomAdH(e.target.value); }}
                    disabled={status === 'running'}
                    aria-label="Hauteur personnalisée"
                  />
                </label>
                <button
                  type="button"
                  className="btn btn-outline btn-sm rounded-xl"
                  disabled={
                    status === 'running' ||
                    creativeAdFormats.length >= 8 ||
                    customAdW.trim().length === 0 ||
                    customAdH.trim().length === 0
                  }
                  onClick={() => { addCreativeCustomFormat(); }}
                >
                  Ajouter taille perso.
                </button>
              </div>
              <p className="mt-2 font-mono text-[11px] text-base-content/60">
                Sélection :{' '}
                {creativeAdFormats.map((f) => `${String(f.width)}×${String(f.height)}`).join(' · ') || '—'}
              </p>
            </fieldset>
            {creativeSupportsNativePipeline && (
              <p className="rounded-2xl border border-base-300/50 bg-base-200/15 px-4 py-4 text-sm leading-relaxed text-base-content/85">
                <span className="font-medium text-base-content">Assets déjà validés</span>
                {' '}
                — la review (et les descriptions pour Opus) sont produites avec le style guide via{' '}
                <code className="font-mono text-xs">run-style-guide-assets-review.mts</code>
                . La génération créative consomme{' '}
                <code className="font-mono text-xs">review/asset-descriptions.json</code>
                {' '}
                (texte seul, sans re-review ni images vers Opus).
              </p>
            )}
            {creativeSupportsNativePipeline && (
              <fieldset className="rounded-2xl border border-base-300/50 bg-base-200/15 px-4 py-4">
                <legend className="px-1 text-sm font-medium text-base-content">Profil génération code</legend>
                <p className="mb-3 text-xs leading-relaxed text-base-content/65">
                  fast = Sonnet sans thinking (défaut) · balanced = Sonnet + thinking adaptatif · quality = Opus
                </p>
                <div className="flex flex-wrap gap-2">
                  {([ 'fast', 'balanced', 'quality' ] as const).map((id) => (
                    <label
                      key={id}
                      className={`btn btn-sm rounded-xl ${creativeCodegenPreset === id ? 'btn-primary' : 'btn-outline'}`}
                    >
                      <input
                        type="radio"
                        name="creativeCodegenPreset"
                        className="sr-only"
                        checked={creativeCodegenPreset === id}
                        disabled={status === 'running'}
                        onChange={() => { setCreativeCodegenPreset(id); }}
                      />
                      {id}
                    </label>
                  ))}
                </div>
              </fieldset>
            )}
            {creativeSupportsUiReview && (
              <label className="flex cursor-pointer items-start gap-3 rounded-2xl border border-base-300/50 bg-base-200/15 px-4 py-4">
                <input
                  type="checkbox"
                  className="checkbox checkbox-primary mt-0.5 shrink-0"
                  checked={creativeUiReview}
                  disabled={status === 'running'}
                  onChange={(e) => { setCreativeUiReview(e.target.checked); }}
                  aria-label="Review UI après génération"
                />
                <span className="text-sm leading-relaxed text-base-content/85">
                  <span className="font-medium text-base-content">Review UI après génération</span>
                  {' '}
                  — lance l&apos;agent{' '}
                  <code className="font-mono text-xs">run-creative-native-ui-review.mts</code>
                  {' '}
                  (screenshots Playwright + Haiku) après la génération ; régénération si besoin (3 itérations max).
                  Artefacts dans{' '}
                  <code className="font-mono text-xs">review/screenshots/</code>
                  {' '}
                  et{' '}
                  <code className="font-mono text-xs">review/ui-review-final.json</code>.
                </span>
              </label>
            )}
            <div className="card-actions flex-col items-stretch gap-3 border-t border-base-300/30 pt-6 sm:flex-row sm:flex-wrap sm:justify-end">
              {creativeSupportsUiReview && (
                <button
                  type="button"
                  className="btn btn-outline rounded-xl px-6 disabled:opacity-50"
                  disabled={status === 'running' || !canRetryUiReview}
                  title={
                    canRetryUiReview
                      ? 'Relancer uniquement run-creative-native-ui-review.mts'
                      : 'Disponible après un échec de génération créative (dossier et code/ requis)'
                  }
                  onClick={() => { void retryUiReview(); }}
                >
                  {status === 'running' && lastRunKind === 'creative'
                    ? (
                      <>
                        <span className="loading loading-spinner loading-sm" aria-hidden="true" />
                        Revue UI…
                      </>
                      )
                    : (
                        'Relancer revue UI'
                      )}
                </button>
              )}
              <button
                type="button"
                className="btn btn-secondary rounded-xl px-8 shadow-md transition-[filter,transform] hover:brightness-105 active:scale-[0.99] disabled:shadow-none"
                disabled={
                  status === 'running' ||
                  creativeOutputFolder.length === 0 ||
                  creativeAdFormats.length === 0 ||
                  (catalog?.creativeCodeScripts.length ?? 0) === 0 ||
                  (catalog?.outputFoldersWithStyleGuide.length ?? 0) === 0
                }
                onClick={() => { void runCreative(); }}
              >
                {status === 'running' && lastRunKind === 'creative'
                  ? (
                    <>
                      <span className="loading loading-spinner loading-sm" aria-hidden="true" />
                      Exécution…
                    </>
                    )
                  : (
                      'Lancer code créatif'
                    )}
              </button>
            </div>
            <details className="rounded-2xl border border-base-300/50 bg-base-200/20 px-4 open:bg-base-200/30">
              <summary className="cursor-pointer py-3 text-sm font-medium outline-none marker:text-base-content/40">
                Fichiers détectés dans <code className="font-mono text-xs">src/agents/</code>
              </summary>
              <div className="grid gap-6 border-t border-base-300/30 pb-4 pt-4 sm:grid-cols-2">
                  <div>
                    <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-base-content/90">gen-style-guide.mts</p>
                    <ul className="max-h-48 overflow-y-auto rounded-xl border border-base-300/40 bg-base-100/80 p-3 font-mono text-[11px] leading-relaxed text-base-content/80">
                      {(catalog?.styleGuideScripts ?? []).map((n) => (
                        <li key={n} className="break-all py-0.5">{n}</li>
                      ))}
                    </ul>
                  </div>
                  <div>
                    <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-base-content/90">gen-creative-code*.mts</p>
                    <ul className="max-h-48 overflow-y-auto rounded-xl border border-base-300/40 bg-base-100/80 p-3 font-mono text-[11px] leading-relaxed text-base-content/80">
                      {(catalog?.creativeCodeScripts ?? []).map((n) => (
                        <li key={n} className="break-all py-0.5">{n}</li>
                      ))}
                    </ul>
                  </div>
                </div>
            </details>
          </div>
        </section>

        <section className="card overflow-hidden rounded-3xl border border-base-300/50 bg-base-100/90 shadow-xl shadow-black/5 ring-1 ring-black/5 backdrop-blur-md dark:ring-white/10 dark:shadow-black/25">
          <div className="flex flex-col gap-4 border-b border-base-300/40 bg-base-200/30 px-6 py-6 sm:flex-row sm:items-center sm:justify-between sm:px-8">
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-base-content/90">Bibliothèque</p>
              <h2 className="mt-1.5 text-xl font-semibold tracking-tight sm:text-2xl">Aperçus</h2>
              <p className="mt-2 max-w-xl text-sm text-base-content/55">
                Une ligne par marque / run. Choisissez <strong>Version 1</strong>, <strong>Version 2</strong>, etc. puis ouvrez l’aperçu du format sélectionné.
              </p>
            </div>
            <button
              type="button"
              className="btn btn-outline btn-sm shrink-0 rounded-full border-base-300/80 bg-base-100/50"
              disabled={previewsLoading}
              onClick={() => { void loadOutputPreviews(); }}
            >
              {previewsLoading
                ? (
                  <>
                    <span className="loading loading-spinner loading-xs" aria-hidden="true" />
                    Chargement…
                  </>
                  )
                : (
                    'Rafraîchir'
                  )}
            </button>
          </div>
          <div className="card-body gap-5 px-6 pb-8 pt-2 sm:px-8">
            {previewsError !== null && (
              <div
                role="alert"
                className="alert alert-soft alert-error rounded-xl border border-error/15 text-sm"
              >
                <span>{previewsError}</span>
              </div>
            )}
            {outputPreviews.length === 0 && !previewsLoading && previewsError === null && (
              <p className="rounded-2xl border border-dashed border-base-300/60 bg-base-200/20 px-5 py-8 text-center text-sm text-base-content/50">
                Aucun rendu pour l’instant. Lancez une génération ou vérifiez que l’API studio tourne sur le port{' '}
                <code className="font-mono text-xs">3001</code>.
              </p>
            )}
            {outputPreviews.length > 0 && (
              <div className="overflow-hidden rounded-2xl border border-base-300/50 bg-base-200/25">
                <table className="table table-sm [&_tbody_tr]:border-base-300/25 [&_tbody_tr]:transition-colors [&_tbody_tr:hover]:bg-base-100/90">
                  <thead>
                    <tr className="border-base-300/40 text-[11px] font-semibold uppercase tracking-wider text-base-content/90">
                      <th className="bg-base-100/50">Titre</th>
                      <th className="bg-base-100/50 text-center">Formats</th>
                      <th className="bg-base-100/50">Modifié</th>
                      <th className="bg-base-100/50 text-end">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {outputPreviews.map((row) => {
                      const activeVersion = resolvePreviewVersion(row)
                      return (
                      <tr key={row.folderName}>
                        <td className="max-w-56 text-sm font-medium sm:max-w-none sm:text-base">
                          {row.pageTitle}
                        </td>
                        <td className="text-center">
                          <span className="badge badge-sm badge-neutral font-mono tabular-nums">
                            {row.versionCount}
                          </span>
                        </td>
                        <td className="whitespace-nowrap text-xs tabular-nums text-base-content/50 sm:text-sm">
                          {new Date(row.mtimeMs).toLocaleString('fr-FR')}
                        </td>
                        <td className="text-end">
                          <div className="flex flex-wrap items-center justify-end gap-1.5">
                            <select
                              className="select select-bordered select-xs max-w-36 rounded-lg font-medium"
                              value={selectedVersionByFolder[row.folderName] ?? activeVersion.versionId}
                              aria-label={`Version pour ${row.folderName}`}
                              onChange={(e) => {
                                setSelectedVersionByFolder((prev) => ({
                                  ...prev,
                                  [row.folderName]: e.target.value
                                }))
                              }}
                            >
                              {row.versions.map((v) => (
                                <option key={v.versionId} value={v.versionId}>
                                  {v.versionLabel}
                                </option>
                              ))}
                            </select>
                            <button
                              type="button"
                              className="btn btn-primary btn-xs rounded-lg px-3"
                              onClick={() => {
                                const v = resolvePreviewVersion(row)
                                setPreviewModal({
                                  previewUrl: v.previewUrl,
                                  pageTitle: v.pageTitle,
                                  versionLabel: v.versionLabel,
                                  relativePath: v.relativePath
                                })
                              }}
                            >
                              Aperçu
                            </button>
                            <button
                              type="button"
                              className="btn btn-outline btn-xs rounded-lg px-2.5"
                              disabled={previewsLoading || exportingConfigKey === row.folderName}
                              onClick={() => { void downloadGenericConfig(row); }}
                            >
                              {exportingConfigKey === row.folderName
                                ? (
                                  <>
                                    <span className="loading loading-spinner loading-xs" aria-hidden="true" />
                                    Export…
                                  </>
                                  )
                                : (
                                    'Config JSON'
                                  )}
                            </button>
                            <a
                              className="btn btn-ghost btn-xs rounded-lg font-medium opacity-85 hover:opacity-100"
                              href={activeVersion.previewUrl}
                              target="_blank"
                              rel="noreferrer"
                            >
                              Onglet
                            </a>
                          </div>
                        </td>
                      </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </section>

        <div className="flex items-center gap-5 py-1">
          <div className="h-px flex-1 bg-linear-to-r from-transparent via-base-300/80 to-transparent" />
          <span className="shrink-0 text-[10px] font-semibold uppercase tracking-[0.22em] text-base-content/40">
            Console
          </span>
          <div className="h-px flex-1 bg-linear-to-r from-transparent via-base-300/80 to-transparent" />
        </div>

        <section className="card overflow-hidden rounded-3xl border border-base-300/50 bg-base-100/90 shadow-lg shadow-black/5 ring-1 ring-black/5 backdrop-blur-sm dark:ring-white/10 dark:shadow-black/25">
          <div className="border-b border-base-300/40 bg-base-200/25 px-6 py-5 sm:px-8">
            <h2 className="text-lg font-semibold tracking-tight">Progression</h2>
            <p className="mt-2 text-sm leading-relaxed text-base-content/55">
              Sortie standard du processus Node.
            </p>
          </div>
          <div className="max-h-[min(60vh,520px)] overflow-y-auto bg-base-200/20 p-4 sm:p-6">
            <div className="mockup-code w-full rounded-xl border border-base-300/40 text-left text-xs shadow-inner ring-1 ring-black/4 sm:text-sm dark:ring-white/6">
              {logs.length === 0 && status !== 'running' && (
                <pre data-prefix=" "><code className="base-100">En attente de logs…</code></pre>
              )}
              {logs.map((line, i) => (
                <pre
                  key={`${String(i)}-${line.text.slice(0, 48)}`}
                  data-prefix={line.source === 'stderr' ? '!' : '>'}
                >
                  <code className={line.source === 'stderr' ? 'text-error' : 'base-100'}>{line.text}</code>
                </pre>
              ))}
            </div>
            <div ref={logEndRef} className="h-px w-full shrink-0" aria-hidden="true" />
          </div>
        </section>
      </main>
      {previewModal !== null && (
        <div
          className="modal modal-open"
          role="dialog"
          aria-modal="true"
          aria-labelledby="preview-modal-title"
        >
          <form className="modal-backdrop">
            <button
              type="button"
              aria-label="Fermer l’aperçu"
              onClick={() => { setPreviewModal(null); }}
            />
          </form>
          <div className="modal-box flex h-dvh w-screen max-w-none flex-col gap-0 overflow-hidden rounded-none border-0 p-0 shadow-2xl">
            <header className="navbar min-h-14 shrink-0 border-b border-base-300/50 bg-base-100/90 px-3 py-2 backdrop-blur-md sm:px-5">
              <div className="navbar-start flex min-w-0 flex-1 flex-col justify-center gap-0.5">
                <h2 id="preview-modal-title" className="truncate text-base font-semibold tracking-tight">
                  {previewModal.versionLabel} — {previewModal.pageTitle}
                </h2>
                <p className="truncate font-mono text-[10px] text-base-content/50 sm:text-xs">
                  {previewModal.relativePath}
                </p>
              </div>
              <div className="navbar-end flex shrink-0 flex-wrap gap-2">
                <a
                  className="btn btn-ghost btn-sm rounded-xl"
                  href={previewModal.previewUrl}
                  target="_blank"
                  rel="noreferrer"
                >
                  Nouvel onglet
                </a>
                <button
                  type="button"
                  className="btn btn-primary btn-sm rounded-xl px-5"
                  onClick={() => { setPreviewModal(null); }}
                >
                  Fermer
                </button>
              </div>
            </header>
            <iframe
              title="Aperçu HTML généré"
              className="min-h-0 w-full flex-1 border-0 bg-base-100"
              src={previewModal.previewUrl}
            />
          </div>
        </div>
      )}
    </div>
  )
}

export default App
