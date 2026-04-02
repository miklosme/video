import { spawn } from 'node:child_process'
import { access, mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'

import {
  createCliRenderer,
  createTextAttributes,
  type CliRenderer,
  type Selection,
  type SelectOption,
  type TextareaRenderable,
} from '@opentui/core'
import { createRoot, useKeyboard, useRenderer } from '@opentui/react'
import { useEffect, useRef, useState } from 'react'
import { z } from 'zod'

import { startArtifactReviewServer, type ArtifactReviewServer } from './artifact-review-server'
import { buildConfigSavePayload } from './config-utils'
import { getEditorStatus } from './editor-status'
import {
  clearBufferedNextStepSuggestions,
  createEmptyBufferedNextStepSuggestions,
  getNextStepSuggestionShortcutIndex,
  promotePendingBufferedNextStepSuggestions,
  setPendingBufferedNextStepSuggestions,
  type BufferedNextStepSuggestions,
  type SuggestedNextStep,
} from './next-step-suggestions'
import { captureWorkflowEvent, createTraceId, shutdownPostHog } from './posthog'
import { startManagedRemotionStudio, type ManagedRemotionStudio } from './remotion-workflow'
import {
  createVideoAgentRuntime,
  type TranscriptEntry,
  type VideoAgentRuntime,
  type WorkflowSummary,
} from './video-agent-core'
import {
  validateConfigAgainstModelOptions,
  WORKFLOW_FILES,
  type ConfigData,
  type ModelOptionsData,
} from './workflow-data'

const AGENT_STATE_PATH = 'workspace/HISTORY.json'
const LEGACY_AGENT_STATE_PATH = 'HISTORY.json'
// Bump this when agent/runtime behavior changes enough that old transcript context
// should not be replayed into new turns.
const PERSISTED_AGENT_STATE_VERSION = 2
const COPY_NOTIFICATION_DURATION_MS = 2200

interface AppProps {
  initialWorkflow: WorkflowSummary
  initialSession: PersistedAgentState
  artifactReviewUrl: string
  remotionStudioUrl: string | null
  remotionStudioStatus: string
  runtime: VideoAgentRuntime
  statePersistence: AgentStatePersistence
}

interface PersistedAgentState {
  version: typeof PERSISTED_AGENT_STATE_VERSION
  transcript: TranscriptEntry[]
  recentChanges: string[]
  runtimeError: string | null
}

interface DisplayTranscriptEntry {
  id: string
  role: 'assistant' | 'user'
  text: string
}

interface ConfigDraft {
  agentModel: string
  imageModel: string
  videoModel: string
}

type ConfigField = keyof ConfigDraft

const CONFIG_FIELD_LABELS: Record<ConfigField, string> = {
  agentModel: 'Agent model',
  imageModel: 'Image model',
  videoModel: 'Video model',
}

const CONFIG_FIELD_DESCRIPTIONS: Record<ConfigField, string> = {
  agentModel: 'Used for the creative chat agent in this app.',
  imageModel: 'Used for still-image sidecars and image generation.',
  videoModel: 'Used for shot motion prompt generation.',
}

interface AgentStatePersistence {
  saveSession: (state: PersistedAgentState) => void
  flush: () => Promise<void>
}

const transcriptEntrySchema = z.object({
  id: z.string(),
  role: z.enum(['assistant', 'user', 'tool']),
  text: z.string(),
})

const persistedAgentStateSchema = z.object({
  version: z.literal(PERSISTED_AGENT_STATE_VERSION),
  transcript: z.array(transcriptEntrySchema),
  recentChanges: z.array(z.string()),
  runtimeError: z.string().nullable(),
})

const DIM_TEXT_ATTRIBUTES = createTextAttributes({ dim: true })

const SELECTION_HIGHLIGHT_BG = '#315b83'
const SELECTION_HIGHLIGHT_FG = '#ffffff'
const NEXT_STEP_HIGHLIGHT_BG = '#2f6a45'
const NEXT_STEP_HIGHLIGHT_FG = '#ffffff'

function createId(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

function getComposerLineCount(value: string) {
  return Math.min(4, Math.max(1, value.split('\n').length))
}

function runClipboardCommand(command: string, args: string[], text: string) {
  return new Promise<boolean>((resolve) => {
    const child = spawn(command, args, {
      stdio: ['pipe', 'ignore', 'ignore'],
    })

    child.on('error', () => {
      resolve(false)
    })

    child.on('close', (code) => {
      resolve(code === 0)
    })

    child.stdin.on('error', () => {
      resolve(false)
    })
    child.stdin.end(text)
  })
}

async function copyTextWithSystemClipboard(text: string) {
  if (process.platform === 'darwin') {
    return runClipboardCommand('pbcopy', [], text)
  }

  if (process.platform === 'win32') {
    return runClipboardCommand('clip', [], text)
  }

  const candidates: Array<{ command: string; args: string[] }> = []

  if (process.env.WAYLAND_DISPLAY || process.env.XDG_SESSION_TYPE === 'wayland') {
    candidates.push({ command: 'wl-copy', args: [] })
  }

  candidates.push(
    { command: 'xclip', args: ['-selection', 'clipboard'] },
    { command: 'xsel', args: ['--clipboard', '--input'] },
  )

  for (const candidate of candidates) {
    if (await runClipboardCommand(candidate.command, candidate.args, text)) {
      return true
    }
  }

  return false
}

async function copySelectionText(renderer: CliRenderer, text: string) {
  if (renderer.copyToClipboardOSC52(text)) {
    return true
  }

  return copyTextWithSystemClipboard(text)
}

async function fileExists(targetPath: string) {
  try {
    await access(targetPath)
    return true
  } catch {
    return false
  }
}

function createConfigDraft(config: ConfigData): ConfigDraft {
  return {
    agentModel: config.agentModel,
    imageModel: config.imageModel,
    videoModel: config.videoModel,
  }
}

function updateConfigDraftField(
  config: ConfigDraft,
  field: ConfigField,
  value: string,
): ConfigDraft {
  if (field === 'agentModel') {
    return { ...config, agentModel: value }
  }

  if (field === 'imageModel') {
    return { ...config, imageModel: value }
  }

  return { ...config, videoModel: value }
}

function getConfigFieldValue(config: ConfigDraft | ConfigData, field: ConfigField) {
  if (field === 'agentModel') {
    return config.agentModel
  }

  if (field === 'imageModel') {
    return config.imageModel
  }

  return config.videoModel
}

function getModelOptionsForField(modelOptions: ModelOptionsData, field: ConfigField) {
  if (field === 'agentModel') {
    return modelOptions.agentModels
  }

  if (field === 'imageModel') {
    return modelOptions.imageModels
  }

  return modelOptions.videoModels
}

function renderConfigCard(
  label: string,
  value: string,
  key: string,
  onOpen: () => void,
  disabled = false,
) {
  return (
    <box
      key={key}
      border
      title={label}
      height={3}
      paddingLeft={1}
      paddingRight={1}
      alignItems="flex-start"
      justifyContent="center"
      onMouseDown={() => {
        if (!disabled) {
          onOpen()
        }
      }}
    >
      <text wrapMode="word" content={value} />
    </box>
  )
}

function renderStatusItem(item: WorkflowSummary['status'][number], key: string, index: number) {
  const itemText = `${index + 1}. ${item.title}`

  if (item.state === 'missing') {
    return (
      <text key={key} wrapMode="word">
        <span fg="brightBlack" attributes={DIM_TEXT_ATTRIBUTES}>
          {`- [ ] ${itemText}`}
        </span>
      </text>
    )
  }

  if (item.state === 'incomplete') {
    return (
      <text key={key} wrapMode="word">
        {`- [ ] ${itemText}`}
      </text>
    )
  }

  return (
    <text key={key} wrapMode="word">
      <span
        fg={item.state === 'approved' ? 'brightBlack' : undefined}
        attributes={item.state === 'approved' ? DIM_TEXT_ATTRIBUTES : undefined}
      >
        - [
      </span>
      <span fg="green">x</span>
      <span
        fg={item.state === 'approved' ? 'brightBlack' : undefined}
        attributes={item.state === 'approved' ? DIM_TEXT_ATTRIBUTES : undefined}
      >
        {`] ${itemText}`}
      </span>
    </text>
  )
}

function formatInitialAssistantMessage(workflow: WorkflowSummary) {
  if (!workflow.ideaExists) {
    return 'What is the irreducible concept or brief for this piece?'
  }

  if (workflow.nextMilestone) {
    return `I’ve taken in what’s here. Next we should ${workflow.nextMilestone.title.toLowerCase()}.`
  }

  return 'The current creative materials are in place. We can refine any part you want.'
}

function buildDisplayTranscript(transcript: TranscriptEntry[]) {
  return transcript
    .filter(
      (entry): entry is DisplayTranscriptEntry =>
        entry.role !== 'tool' && entry.text.trim().length > 0,
    )
    .map((entry) => ({
      id: entry.id,
      role: entry.role,
      text: entry.text,
    }))
}

function createDefaultPersistedAgentState(workflow: WorkflowSummary): PersistedAgentState {
  const bootstrappedChanges: string[] = []

  if (workflow.configBootstrapped) {
    bootstrappedChanges.push(WORKFLOW_FILES.config)
  }

  if (workflow.statusBootstrapped) {
    bootstrappedChanges.push(WORKFLOW_FILES.status)
  }

  return {
    version: PERSISTED_AGENT_STATE_VERSION,
    transcript: [
      {
        id: createId('assistant'),
        role: 'assistant',
        text: formatInitialAssistantMessage(workflow),
      },
    ],
    recentChanges: bootstrappedChanges,
    runtimeError: null,
  }
}

function clonePersistedAgentState(state: PersistedAgentState): PersistedAgentState {
  return {
    version: state.version,
    transcript: state.transcript.map((entry) => ({ ...entry })),
    recentChanges: [...state.recentChanges],
    runtimeError: state.runtimeError,
  }
}

async function loadPersistedAgentState(workflow: WorkflowSummary): Promise<PersistedAgentState> {
  const fallback = createDefaultPersistedAgentState(workflow)
  const persistedStatePath = (await fileExists(AGENT_STATE_PATH))
    ? AGENT_STATE_PATH
    : LEGACY_AGENT_STATE_PATH

  if (!(await fileExists(persistedStatePath))) {
    return fallback
  }

  try {
    const raw = await readFile(persistedStatePath, 'utf8')
    const parsed = persistedAgentStateSchema.parse(JSON.parse(raw))

    return {
      ...parsed,
      transcript: parsed.transcript.length > 0 ? parsed.transcript : fallback.transcript,
      recentChanges: [...new Set(parsed.recentChanges)].slice(0, 8),
    }
  } catch {
    return fallback
  }
}

async function writePersistedAgentState(state: PersistedAgentState) {
  await mkdir(path.dirname(AGENT_STATE_PATH), { recursive: true })
  await writeFile(AGENT_STATE_PATH, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
}

function createAgentStatePersistence(): AgentStatePersistence {
  let pendingState: PersistedAgentState | null = null
  let drainPromise: Promise<void> | null = null

  const drain = () => {
    if (drainPromise) {
      return drainPromise
    }

    drainPromise = (async () => {
      while (pendingState) {
        const nextState = pendingState
        pendingState = null

        try {
          await writePersistedAgentState(nextState)
        } catch (error) {
          console.error(
            error instanceof Error
              ? `Failed to persist video agent state: ${error.message}`
              : `Failed to persist video agent state: ${String(error)}`,
          )
        }
      }

      drainPromise = null
    })()

    return drainPromise
  }

  return {
    saveSession: (state) => {
      pendingState = clonePersistedAgentState(state)
      void drain()
    },
    flush: async () => {
      if (!pendingState && !drainPromise) {
        return
      }

      await drain()
    },
  }
}

function updateTranscriptEntry(
  transcript: TranscriptEntry[],
  entryId: string,
  updater: (entry: TranscriptEntry) => TranscriptEntry,
) {
  return transcript.map((entry) => (entry.id === entryId ? updater(entry) : entry))
}

function insertTranscriptEntryBefore(
  transcript: TranscriptEntry[],
  anchorEntryId: string,
  nextEntry: TranscriptEntry,
) {
  const anchorIndex = transcript.findIndex((entry) => entry.id === anchorEntryId)

  if (anchorIndex === -1) {
    return [...transcript, nextEntry]
  }

  return [...transcript.slice(0, anchorIndex), nextEntry, ...transcript.slice(anchorIndex)]
}

function App({
  initialWorkflow,
  initialSession,
  artifactReviewUrl,
  remotionStudioUrl,
  remotionStudioStatus,
  runtime,
  statePersistence,
}: AppProps) {
  const renderer = useRenderer()
  const [transcript, setTranscript] = useState<TranscriptEntry[]>(initialSession.transcript)
  const [composerValue, setComposerValue] = useState('')
  const [workflow, setWorkflow] = useState(initialWorkflow)
  const [recentChanges, setRecentChanges] = useState<string[]>(initialSession.recentChanges)
  const [isBusy, setIsBusy] = useState(false)
  const [runtimeError, setRuntimeError] = useState<string | null>(initialSession.runtimeError)
  const [pendingResetIndex, setPendingResetIndex] = useState<number | null>(null)
  const [isResettingMilestone, setIsResettingMilestone] = useState(false)
  const [openConfigField, setOpenConfigField] = useState<ConfigField | null>(null)
  const [configDraft, setConfigDraft] = useState<ConfigDraft>(() =>
    createConfigDraft(initialWorkflow.config),
  )
  const [isSavingConfig, setIsSavingConfig] = useState(false)
  const [copyNotification, setCopyNotification] = useState<string | null>(null)
  const [bufferedNextStepSuggestions, setBufferedNextStepSuggestions] =
    useState<BufferedNextStepSuggestions>(createEmptyBufferedNextStepSuggestions)

  const transcriptRef = useRef<TranscriptEntry[]>(initialSession.transcript)
  const composerValueRef = useRef('')
  const recentChangesRef = useRef<string[]>(initialSession.recentChanges)
  const runtimeErrorRef = useRef<string | null>(initialSession.runtimeError)
  const bufferedNextStepSuggestionsRef = useRef<BufferedNextStepSuggestions>(
    createEmptyBufferedNextStepSuggestions(),
  )
  const activeAssistantEntryIdRef = useRef<string | null>(null)
  const assistantHasStartedRef = useRef(false)
  const composerInputRef = useRef<TextareaRenderable | null>(null)
  const copyNotificationTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const focusComposerInput = () => {
    if (!isBusy && pendingResetIndex === null && openConfigField === null) {
      composerInputRef.current?.focus()
    }
  }

  const persistSession = () => {
    statePersistence.saveSession({
      version: PERSISTED_AGENT_STATE_VERSION,
      transcript: transcriptRef.current,
      recentChanges: recentChangesRef.current,
      runtimeError: runtimeErrorRef.current,
    })
  }

  const replaceTranscript = (nextTranscript: TranscriptEntry[]) => {
    transcriptRef.current = nextTranscript
    setTranscript(nextTranscript)
    persistSession()
  }

  const appendTranscriptEntries = (...entries: TranscriptEntry[]) => {
    replaceTranscript([...transcriptRef.current, ...entries])
  }

  const insertTranscriptEntryBeforeState = (anchorEntryId: string, entry: TranscriptEntry) => {
    replaceTranscript(insertTranscriptEntryBefore(transcriptRef.current, anchorEntryId, entry))
  }

  const patchTranscriptEntry = (
    entryId: string,
    updater: (entry: TranscriptEntry) => TranscriptEntry,
  ) => {
    replaceTranscript(updateTranscriptEntry(transcriptRef.current, entryId, updater))
  }

  const setComposerValueState = (value: string) => {
    composerValueRef.current = value
    setComposerValue(value)
    persistSession()
  }

  const setRecentChangesState = (nextRecentChanges: string[]) => {
    recentChangesRef.current = nextRecentChanges
    setRecentChanges(nextRecentChanges)
    persistSession()
  }

  const setRuntimeErrorState = (nextRuntimeError: string | null) => {
    runtimeErrorRef.current = nextRuntimeError
    setRuntimeError(nextRuntimeError)
    persistSession()
  }

  const setBufferedNextStepSuggestionsState = (
    nextBufferedNextStepSuggestions:
      | BufferedNextStepSuggestions
      | ((current: BufferedNextStepSuggestions) => BufferedNextStepSuggestions),
  ) => {
    const resolvedNextBufferedNextStepSuggestions =
      typeof nextBufferedNextStepSuggestions === 'function'
        ? nextBufferedNextStepSuggestions(bufferedNextStepSuggestionsRef.current)
        : nextBufferedNextStepSuggestions

    bufferedNextStepSuggestionsRef.current = {
      pending:
        resolvedNextBufferedNextStepSuggestions.pending?.map((suggestion) => ({
          ...suggestion,
        })) ?? null,
      displayed: resolvedNextBufferedNextStepSuggestions.displayed.map((suggestion) => ({
        ...suggestion,
      })),
    }
    setBufferedNextStepSuggestions(bufferedNextStepSuggestionsRef.current)
  }

  const applySuggestedNextStep = (suggestion: SuggestedNextStep) => {
    setComposerValueState(suggestion.prompt)
    composerInputRef.current?.setText(suggestion.prompt)
    focusComposerInput()
  }

  useEffect(() => {
    persistSession()
  }, [])

  useEffect(() => {
    return () => {
      if (copyNotificationTimeoutRef.current) {
        clearTimeout(copyNotificationTimeoutRef.current)
      }
    }
  }, [])

  useEffect(() => {
    const showCopyNotification = (message: string) => {
      if (copyNotificationTimeoutRef.current) {
        clearTimeout(copyNotificationTimeoutRef.current)
      }

      setCopyNotification(message)
      copyNotificationTimeoutRef.current = setTimeout(() => {
        setCopyNotification(null)
        copyNotificationTimeoutRef.current = null
      }, COPY_NOTIFICATION_DURATION_MS)
    }

    const handleSelection = (selection: Selection | null) => {
      if (!selection) {
        return
      }

      const selectedText = selection.getSelectedText()

      if (selectedText.length === 0) {
        return
      }

      void (async () => {
        const copied = await copySelectionText(renderer, selectedText)
        showCopyNotification(
          copied
            ? `Copied ${selectedText.length} character${selectedText.length === 1 ? '' : 's'}`
            : 'Selection captured, but clipboard copy is unavailable',
        )
      })()
    }

    renderer.on('selection', handleSelection)

    return () => {
      renderer.off('selection', handleSelection)
    }
  }, [renderer])

  useEffect(() => {
    runtime.setEventHandlers({
      onToolEvent: (message) => {
        const toolEntry = {
          id: createId('tool'),
          role: 'tool',
          text: message,
        } satisfies TranscriptEntry

        if (activeAssistantEntryIdRef.current && !assistantHasStartedRef.current) {
          insertTranscriptEntryBeforeState(activeAssistantEntryIdRef.current, toolEntry)
          return
        }

        appendTranscriptEntries(toolEntry)
      },
      onFileChange: (fileName) => {
        const nextRecentChanges = [
          fileName,
          ...recentChangesRef.current.filter((entry) => entry !== fileName),
        ].slice(0, 8)
        setRecentChangesState(nextRecentChanges)
      },
      onWorkflowChange: (nextWorkflow) => {
        setWorkflow(nextWorkflow)
      },
      onNextStepSuggestions: (suggestions) => {
        setBufferedNextStepSuggestionsState((current) =>
          setPendingBufferedNextStepSuggestions(current, suggestions),
        )
      },
    })

    return () => {
      runtime.setEventHandlers({})
    }
  }, [runtime, appendTranscriptEntries, insertTranscriptEntryBeforeState])

  const closeResetDialog = () => {
    if (isResettingMilestone) {
      return
    }

    setPendingResetIndex(null)
  }

  const openResetDialog = (index: number) => {
    if (isBusy || isResettingMilestone || openConfigField !== null || isSavingConfig) {
      return
    }

    setRuntimeErrorState(null)
    setPendingResetIndex(index)
  }

  const confirmResetMilestone = async () => {
    if (pendingResetIndex === null || isBusy || isResettingMilestone) {
      return
    }

    setRuntimeErrorState(null)
    setIsResettingMilestone(true)

    try {
      await runtime.resetWorkflowFromMilestone(pendingResetIndex)
      captureWorkflowEvent('milestone_reset_confirmed')
      setPendingResetIndex(null)
    } catch (error) {
      setRuntimeErrorState(error instanceof Error ? error.message : String(error))
    } finally {
      setIsResettingMilestone(false)
    }
  }

  const closeConfigDialog = () => {
    if (isSavingConfig) {
      return
    }

    setOpenConfigField(null)
    setConfigDraft(createConfigDraft(workflow.config))
  }

  const openConfigDialog = (field: ConfigField) => {
    if (isBusy || isResettingMilestone || pendingResetIndex !== null || isSavingConfig) {
      return
    }

    setRuntimeErrorState(null)
    setConfigDraft(createConfigDraft(workflow.config))
    setOpenConfigField(field)
  }

  const saveConfig = async (nextConfigOverride?: ConfigDraft) => {
    if (isBusy || isResettingMilestone || isSavingConfig) {
      return
    }

    const nextConfigDraft = nextConfigOverride ?? configDraft
    const nextConfig = buildConfigSavePayload(workflow.config, {
      agentModel: nextConfigDraft.agentModel,
      imageModel: nextConfigDraft.imageModel,
      videoModel: nextConfigDraft.videoModel,
    })

    setRuntimeErrorState(null)
    setIsSavingConfig(true)

    try {
      validateConfigAgainstModelOptions(nextConfig, workflow.modelOptions)
      await runtime.writeWorkspaceFile(WORKFLOW_FILES.config, JSON.stringify(nextConfig, null, 2))
      captureWorkflowEvent('config_saved')
      setOpenConfigField(null)
    } catch (error) {
      setRuntimeErrorState(error instanceof Error ? error.message : String(error))
    } finally {
      setIsSavingConfig(false)
    }
  }

  useKeyboard((event) => {
    if (event.eventType === 'release') {
      return
    }

    if (openConfigField !== null) {
      if (event.name === 'escape') {
        closeConfigDialog()
        return
      }

      return
    }

    if (pendingResetIndex === null) {
      const suggestionShortcutIndex = getNextStepSuggestionShortcutIndex(event.name, event.sequence)
      const displayedSuggestions = bufferedNextStepSuggestionsRef.current.displayed
      const canUseSuggestionShortcut =
        !isBusy &&
        suggestionShortcutIndex !== null &&
        suggestionShortcutIndex < displayedSuggestions.length &&
        openConfigField === null

      if (canUseSuggestionShortcut) {
        event.preventDefault()
        event.stopPropagation()
        applySuggestedNextStep(displayedSuggestions[suggestionShortcutIndex]!)
      }

      return
    }

    if (event.name === 'escape' || event.name === 'n') {
      closeResetDialog()
      return
    }

    if (event.name === 'return' || event.name === 'y') {
      void confirmResetMilestone()
    }
  })

  const displayTranscript = buildDisplayTranscript(transcript)
  const pendingResetItem =
    pendingResetIndex === null ? null : (workflow.status[pendingResetIndex] ?? null)
  const pendingResetFiles =
    pendingResetIndex === null
      ? []
      : [...new Set(workflow.status[pendingResetIndex]?.relatedFiles ?? [])]
  const activeConfigLabel = openConfigField === null ? null : CONFIG_FIELD_LABELS[openConfigField]
  const activeConfigDescription =
    openConfigField === null ? null : CONFIG_FIELD_DESCRIPTIONS[openConfigField]
  const activeConfigOptions =
    openConfigField === null ? [] : getModelOptionsForField(workflow.modelOptions, openConfigField)
  const activeConfigValue =
    openConfigField === null ? '' : getConfigFieldValue(configDraft, openConfigField)
  const activeConfigSelectOptions: SelectOption[] = activeConfigOptions.map((option) => ({
    name: option,
    description: option === activeConfigValue ? 'Current selection' : 'Available option',
    value: option,
  }))
  const displayedNextStepSuggestions = bufferedNextStepSuggestions.displayed
  const composerLineCount = getComposerLineCount(composerValue)

  async function submitPrompt(input: string) {
    const trimmedInput = input.trim()

    if (isBusy || trimmedInput.length === 0) {
      return
    }

    setRuntimeErrorState(null)
    setComposerValueState('')
    composerInputRef.current?.setText('')
    setBufferedNextStepSuggestionsState(clearBufferedNextStepSuggestions())
    setIsBusy(true)

    const assistantEntryId = createId('assistant')
    const priorTranscript = transcriptRef.current
    const traceId = createTraceId()
    activeAssistantEntryIdRef.current = assistantEntryId
    assistantHasStartedRef.current = false

    appendTranscriptEntries(
      {
        id: createId('user'),
        role: 'user',
        text: trimmedInput,
      },
      {
        id: assistantEntryId,
        role: 'assistant',
        text: '',
      },
    )

    captureWorkflowEvent('agent_turn_submitted', {
      traceId,
      turnId: assistantEntryId,
    })

    try {
      const result = await runtime.runTurn({
        userInput: trimmedInput,
        transcript: priorTranscript,
        traceId,
        onTextDelta: (delta) => {
          if (!assistantHasStartedRef.current && delta.length > 0) {
            assistantHasStartedRef.current = true
          }

          patchTranscriptEntry(assistantEntryId, (entry) => ({
            ...entry,
            text: entry.text + delta,
          }))
        },
      })

      patchTranscriptEntry(assistantEntryId, (entry) => ({
        ...entry,
        text: result.text.length > 0 ? result.text : entry.text || 'No response generated.',
      }))
      assistantHasStartedRef.current = result.text.length > 0
      captureWorkflowEvent('agent_turn_completed', {
        traceId,
        turnId: assistantEntryId,
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)

      captureWorkflowEvent('agent_turn_failed', {
        traceId,
        turnId: assistantEntryId,
        error: message,
      })
      setRuntimeErrorState(message)
      patchTranscriptEntry(assistantEntryId, (entry) => ({
        ...entry,
        text:
          entry.text.trim().length > 0
            ? `${entry.text}\n\n[error] ${message}`
            : `[error] ${message}`,
      }))
    } finally {
      setBufferedNextStepSuggestionsState((current) =>
        promotePendingBufferedNextStepSuggestions(current),
      )
      activeAssistantEntryIdRef.current = null
      assistantHasStartedRef.current = false
      setIsBusy(false)
    }
  }

  return (
    <box width="100%" height="100%" flexDirection="row" padding={1} gap={1}>
      <box
        flexGrow={3}
        flexShrink={1}
        border
        title="Creative Partner"
        padding={1}
        flexDirection="column"
        onMouseDown={focusComposerInput}
      >
        <scrollbox flexGrow={1} stickyScroll stickyStart="bottom" paddingRight={1}>
          {displayTranscript.map((entry, index) => {
            const nextEntry = displayTranscript[index + 1]
            const marginBottom = nextEntry ? 1 : 0

            if (entry.role === 'user') {
              return (
                <box key={entry.id} width="100%" alignItems="flex-end" marginBottom={marginBottom}>
                  <box width="90%" backgroundColor="#5a5a5a" padding={1} paddingLeft={2}>
                    <text
                      content={entry.text}
                      wrapMode="word"
                      selectionBg={SELECTION_HIGHLIGHT_BG}
                      selectionFg={SELECTION_HIGHLIGHT_FG}
                    />
                  </box>
                </box>
              )
            }

            return (
              <box key={entry.id} marginBottom={marginBottom}>
                <text
                  content={entry.text}
                  wrapMode="word"
                  selectionBg={SELECTION_HIGHLIGHT_BG}
                  selectionFg={SELECTION_HIGHLIGHT_FG}
                />
              </box>
            )
          })}
        </scrollbox>
        {!isBusy &&
        pendingResetIndex === null &&
        openConfigField === null &&
        displayedNextStepSuggestions.length > 0 ? (
          <box marginTop={1} flexDirection="column" gap={1} flexShrink={0}>
            {/* <box>
              <text content="Suggested next steps" fg="brightBlack" />
            </box> */}
            <box flexDirection="row" gap={1}>
              {displayedNextStepSuggestions.map((suggestion, index) => (
                <box
                  key={`next-step-suggestion-${index}`}
                  flexGrow={1}
                  width="33%"
                  border
                  paddingLeft={1}
                  paddingRight={1}
                  paddingTop={0}
                  paddingBottom={0}
                  backgroundColor={NEXT_STEP_HIGHLIGHT_BG}
                  onMouseDown={() => {
                    applySuggestedNextStep(suggestion)
                  }}
                >
                  <text
                    content={`${index + 1}. ${suggestion.label}`}
                    fg={NEXT_STEP_HIGHLIGHT_FG}
                    wrapMode="word"
                  />
                </box>
              ))}
            </box>
          </box>
        ) : null}
        <box
          border
          title={isBusy ? 'Thinking...' : 'Input'}
          height={composerLineCount + 2}
          flexShrink={0}
          paddingLeft={1}
          paddingRight={1}
          paddingTop={0}
          paddingBottom={0}
          marginTop={1}
        >
          <textarea
            ref={composerInputRef}
            focused={!isBusy && pendingResetIndex === null && openConfigField === null}
            initialValue={composerValue}
            width="100%"
            height="100%"
            placeholder={
              isBusy
                ? 'Wait for the current turn to finish.'
                : 'Talk through the concept, story, shots, or prompts. Enter sends; Shift+Enter adds a new line.'
            }
            keyBindings={[
              { name: 'return', action: 'submit' },
              { name: 'linefeed', action: 'submit' },
              { name: 'return', shift: true, action: 'newline' },
              { name: 'linefeed', shift: true, action: 'newline' },
            ]}
            onContentChange={() => {
              const nextValue = composerInputRef.current?.plainText ?? ''
              setComposerValueState(nextValue)
            }}
            onSubmit={() => {
              const nextValue = composerInputRef.current?.plainText ?? composerValueRef.current
              void submitPrompt(nextValue)
            }}
          />
        </box>
        {runtimeError ? (
          <box marginTop={1}>
            <text content={`Runtime error: ${runtimeError}`} />
          </box>
        ) : null}
      </box>
      <box width={42} flexShrink={0} flexDirection="column" gap={1} marginBottom={2}>
        <box
          border
          title="Progress"
          padding={1}
          flexGrow={1}
          flexShrink={1}
          minHeight={0}
          flexDirection="column"
        >
          <scrollbox flexGrow={1} flexShrink={1} paddingRight={1}>
            <box flexDirection="column">
              <box marginBottom={1}>
                <text
                  content={`Progress: ${workflow.checkedItems}/${workflow.totalItems} milestones ready`}
                />
              </box>
              <box marginBottom={1}>
                <text content="Milestones" />
              </box>
              {workflow.status.map((item, index) => (
                <box
                  key={`status-item-${index}`}
                  paddingLeft={1}
                  paddingRight={1}
                  onMouseDown={() => {
                    openResetDialog(index)
                  }}
                >
                  {renderStatusItem(item, `section-item-${index}`, index)}
                </box>
              ))}
            </box>
          </scrollbox>
          <box
            marginTop={1}
            onMouseDown={() => {
              spawn('open', [artifactReviewUrl], { stdio: 'ignore', detached: true }).unref()
            }}
          >
            <text content={`UI: ${artifactReviewUrl}`} wrapMode="word" />
          </box>
          <box
            marginTop={1}
            onMouseDown={() => {
              if (remotionStudioUrl) {
                spawn('open', [remotionStudioUrl], { stdio: 'ignore', detached: true }).unref()
              }
            }}
          >
            <text
              content={`Editor: ${remotionStudioUrl ?? remotionStudioStatus}`}
              wrapMode="word"
            />
          </box>
        </box>
        <box flexDirection="column" gap={0}>
          {renderConfigCard(
            'Agent model',
            workflow.config.agentModel,
            'agent-model',
            () => {
              openConfigDialog('agentModel')
            },
            isBusy || isResettingMilestone || pendingResetIndex !== null || isSavingConfig,
          )}
          {renderConfigCard(
            'Image model',
            workflow.config.imageModel,
            'image-model',
            () => {
              openConfigDialog('imageModel')
            },
            isBusy || isResettingMilestone || pendingResetIndex !== null || isSavingConfig,
          )}
          {renderConfigCard(
            'Video model',
            workflow.config.videoModel,
            'video-model',
            () => {
              openConfigDialog('videoModel')
            },
            isBusy || isResettingMilestone || pendingResetIndex !== null || isSavingConfig,
          )}
        </box>
      </box>
      {openConfigField !== null ? (
        <box
          position="absolute"
          top={0}
          right={0}
          bottom={0}
          left={0}
          zIndex={11}
          alignItems="center"
          justifyContent="center"
        >
          <box
            width={96}
            height={24}
            border
            title={`Select ${activeConfigLabel}`}
            padding={1}
            flexDirection="column"
            backgroundColor="#202020"
          >
            <box marginBottom={1}>
              <text wrapMode="word">{activeConfigDescription ?? ''}</text>
            </box>
            <box marginBottom={1} flexDirection="column" height={16}>
              <text content={activeConfigLabel ?? ''} wrapMode="word" />
              <select
                focused
                style={{ height: 14 }}
                options={activeConfigSelectOptions}
                selectedIndex={Math.max(0, activeConfigOptions.indexOf(activeConfigValue))}
                onChange={(_, option) => {
                  if (!option?.value || typeof option.value !== 'string') {
                    return
                  }

                  setConfigDraft((current) =>
                    updateConfigDraftField(current, openConfigField, option.value),
                  )
                }}
                onSelect={(_, option) => {
                  if (!option?.value || typeof option.value !== 'string') {
                    return
                  }

                  setConfigDraft((current) => {
                    const nextDraft = updateConfigDraftField(current, openConfigField, option.value)

                    queueMicrotask(() => {
                      void saveConfig(nextDraft)
                    })

                    return nextDraft
                  })
                }}
              />
            </box>
          </box>
        </box>
      ) : null}
      {pendingResetItem ? (
        <box
          position="absolute"
          top={0}
          right={0}
          bottom={0}
          left={0}
          zIndex={10}
          alignItems="center"
          justifyContent="center"
        >
          <box
            width={68}
            border
            title="Confirm Reset"
            padding={1}
            flexDirection="column"
            backgroundColor="#202020"
          >
            <box marginBottom={1}>
              <text wrapMode="word">{`Reset "${pendingResetItem.title}"?`}</text>
            </box>
            <box marginBottom={1}>
              <text wrapMode="word">
                {`This removes: ${pendingResetFiles.join(', ') || 'no files listed'}.`}
              </text>
            </box>
            <box marginBottom={1}>
              <text wrapMode="word">This only affects the selected milestone.</text>
            </box>
            <box flexDirection="row" justifyContent="flex-end" gap={1}>
              <box
                border
                width={10}
                height={3}
                alignItems="center"
                justifyContent="center"
                onMouseDown={() => {
                  closeResetDialog()
                }}
              >
                <text content="Cancel" wrapMode="word" />
              </box>
              <box
                border
                width={10}
                height={3}
                alignItems="center"
                justifyContent="center"
                backgroundColor="white"
                onMouseDown={() => {
                  void confirmResetMilestone()
                }}
              >
                <text
                  fg="black"
                  content={isResettingMilestone ? 'Resetting...' : 'Reset'}
                  wrapMode="word"
                />
              </box>
            </box>
          </box>
        </box>
      ) : null}
      {copyNotification ? (
        <box
          position="absolute"
          right={2}
          top={1}
          zIndex={21}
          border
          paddingLeft={1}
          paddingRight={1}
          borderColor="#facc15"
          backgroundColor="#000000"
        >
          <text content={copyNotification} fg="#facc15" />
        </box>
      ) : null}
    </box>
  )
}

async function main() {
  if (!process.env.AI_GATEWAY_API_KEY) {
    throw new Error('AI_GATEWAY_API_KEY is required to run app.tsx with the Vercel AI Gateway.')
  }

  const artifactReviewServer = startArtifactReviewServer()
  let remotionStudio: ManagedRemotionStudio | null = null
  let remotionStudioStatus = 'Not ready.'

  try {
    remotionStudio = await startManagedRemotionStudio()
    remotionStudioStatus = 'Running from workspace/FINAL-CUT.json without auto-opening a browser.'
  } catch (error) {
    remotionStudioStatus = getEditorStatus(error)
  }
  const runtime = createVideoAgentRuntime()
  let initialWorkflow = await runtime.loadWorkflowSummary()
  const bootstrappedFiles = await runtime.bootstrapNextMilestoneScaffold(initialWorkflow)

  if (bootstrappedFiles.length > 0) {
    initialWorkflow = await runtime.loadWorkflowSummary()
  }

  const initialSession = await loadPersistedAgentState(initialWorkflow)
  const statePersistence = createAgentStatePersistence()
  const stopArtifactReviewServer = createStopServer(artifactReviewServer)
  const stopRemotionStudio = remotionStudio ? createStopServer(remotionStudio) : async () => {}
  let renderer: Awaited<ReturnType<typeof createCliRenderer>> | null = null
  let shuttingDown = false

  const shutdown = (exitCode: number) => {
    if (shuttingDown) {
      return
    }

    shuttingDown = true

    void (async () => {
      await stopArtifactReviewServer()
      await stopRemotionStudio()
      await statePersistence.flush()
      await shutdownPostHog()
      renderer?.destroy()
      process.exit(exitCode)
    })()
  }

  renderer = await createCliRenderer({
    useAlternateScreen: true,
    exitOnCtrlC: false,
    prependInputHandlers: [
      (sequence) => {
        if (sequence === '\u0003') {
          shutdown(0)
          return true
        }

        return false
      },
    ],
    onDestroy: () => {
      void stopArtifactReviewServer()
      void stopRemotionStudio()
      void statePersistence.flush()
    },
  })
  renderer.keyInput.on('keypress', (event) => {
    if (event.ctrl && event.name === 'c') {
      event.preventDefault()
      event.stopPropagation()
      shutdown(0)
    }
  })

  process.on('SIGINT', () => shutdown(0))
  process.on('SIGTERM', () => shutdown(0))

  createRoot(renderer).render(
    <App
      initialWorkflow={initialWorkflow}
      initialSession={initialSession}
      artifactReviewUrl={artifactReviewServer.url}
      remotionStudioUrl={remotionStudio?.url ?? null}
      remotionStudioStatus={remotionStudioStatus}
      runtime={runtime}
      statePersistence={statePersistence}
    />,
  )
}

function createStopServer(server: ArtifactReviewServer | ManagedRemotionStudio) {
  let stopPromise: Promise<void> | null = null

  return () => {
    if (!stopPromise) {
      stopPromise = server.stop()
    }

    return stopPromise
  }
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
