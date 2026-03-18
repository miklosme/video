import { access, copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'

import { createCliRenderer, createTextAttributes, type InputRenderable } from '@opentui/core'
import { createRoot } from '@opentui/react'
import { stepCountIs, tool, ToolLoopAgent, type LanguageModel } from 'ai'
import { useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react'
import { z } from 'zod'

import {
  loadEdit,
  loadGenerationLog,
  loadKeyframes,
  loadProject,
  loadPromptPack,
  loadQc,
  loadReferences,
  loadStatus,
  loadStoryboard,
  loadTests,
  WORKFLOW_FILES,
  type ProjectData,
  type TodoData,
  type TodoItem,
  type TodoSection,
} from './workflow-data'

const ROOT_DIR = process.cwd()
const WORKSPACE_DIR = path.resolve(ROOT_DIR, 'workspace')
const TEMPLATES_DIR = path.resolve(ROOT_DIR, 'templates')
const CREATIVE_PROMPT_PATH = path.resolve(ROOT_DIR, 'CREATIVE_AGENTS.md')
const STATUS_TEMPLATE_PATH = path.resolve(TEMPLATES_DIR, 'STATUS.template.json')
const AGENT_STATE_PATH = path.resolve(ROOT_DIR, '.history.json')
const SESSION_HISTORY_LIMIT = 12
const PERSISTED_AGENT_STATE_VERSION = 1

const ALLOWED_WORKSPACE_FILES = new Set([
  'IDEA.md',
  'PROJECT.json',
  'PROJECT.md',
  'STORY.md',
  'CHARACTERS.md',
  'STYLE.md',
  'CONTINUITY.md',
  'SOUND.md',
  'MODELS.md',
  'REFERENCES.json',
  'STORYBOARD.json',
  'STORYBOARD.md',
  'KEYFRAMES.json',
  'PROMPT-PACK.json',
  'TESTS.json',
  'QC.json',
  'EDIT.json',
  'STATUS.json',
  'GENERATION-LOG.jsonl',
])

type TranscriptRole = 'assistant' | 'user' | 'tool'

interface TranscriptEntry {
  id: string
  role: TranscriptRole
  text: string
}

interface WorkflowFileSummary {
  fileName: string
  exists: boolean
}

interface WorkflowMilestoneSummary {
  sectionId: string
  sectionTitle: string
  itemId: string
  text: string
  sourceFiles: string[]
}

interface WorkflowSummary {
  ideaExists: boolean
  statusBootstrapped: boolean
  status: TodoData
  phase: ProjectData['currentPhase'] | null
  checkedItems: number
  totalItems: number
  nextMilestone: WorkflowMilestoneSummary | null
  scopedFiles: WorkflowFileSummary[]
}

interface AppProps {
  creativePrompt: string
  initialWorkflow: WorkflowSummary
  initialSession: PersistedAgentState
  statePersistence: AgentStatePersistence
}

interface AgentBridge {
  recordToolEvent: (message: string) => void
  recordFileChange: (fileName: string) => void
  refreshWorkflow: () => Promise<WorkflowSummary>
}

interface PersistedAgentState {
  version: typeof PERSISTED_AGENT_STATE_VERSION
  transcript: TranscriptEntry[]
  composerValue: string
  recentChanges: string[]
  runtimeError: string | null
}

interface DisplayTranscriptEntry {
  id: string
  role: TranscriptRole
  text: string
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
  composerValue: z.string(),
  recentChanges: z.array(z.string()),
  runtimeError: z.string().nullable(),
})

const DIM_TEXT_ATTRIBUTES = createTextAttributes({ dim: true })

function createId(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

async function fileExists(targetPath: string) {
  try {
    await access(targetPath)
    return true
  } catch {
    return false
  }
}

function resolveWorkspacePath(fileName: string) {
  return path.resolve(WORKSPACE_DIR, fileName)
}

function resolveTemplatePath(fileName: string) {
  const extension = path.extname(fileName)
  const stem = fileName.slice(0, fileName.length - extension.length)

  return path.resolve(TEMPLATES_DIR, `${stem}.template${extension}`)
}

function assertWorkspaceFile(fileName: string) {
  if (!ALLOWED_WORKSPACE_FILES.has(fileName)) {
    throw new Error(`File ${fileName} is not an allowed workspace source-of-truth file.`)
  }
}

async function ensureStatusBootstrapped() {
  const statusPath = resolveWorkspacePath(WORKFLOW_FILES.status)

  if (await fileExists(statusPath)) {
    return false
  }

  await mkdir(path.dirname(statusPath), { recursive: true })
  await copyFile(STATUS_TEMPLATE_PATH, statusPath)

  return true
}

function getNextIncompleteMilestone(status: TodoData): WorkflowMilestoneSummary | null {
  for (const section of status.sections) {
    for (const item of section.items) {
      if (!item.checked) {
        return {
          sectionId: section.sectionId,
          sectionTitle: section.title,
          itemId: item.itemId,
          text: item.text,
          sourceFiles: item.sourceFiles,
        }
      }
    }
  }

  return null
}

async function loadWorkflowSummary(): Promise<WorkflowSummary> {
  const ideaExists = await fileExists(resolveWorkspacePath('IDEA.md'))
  const statusBootstrapped = await ensureStatusBootstrapped()
  const status = await loadStatus(ROOT_DIR)
  const nextMilestone = getNextIncompleteMilestone(status)

  let phase: ProjectData['currentPhase'] | null = null

  if (await fileExists(resolveWorkspacePath(WORKFLOW_FILES.project))) {
    try {
      phase = (await loadProject(ROOT_DIR)).currentPhase
    } catch {
      phase = null
    }
  }

  const checkedItems = status.sections.reduce(
    (sum, section) => sum + section.items.filter((item) => item.checked).length,
    0,
  )
  const totalItems = status.sections.reduce((sum, section) => sum + section.items.length, 0)
  const scopedFiles = await Promise.all(
    (nextMilestone?.sourceFiles ?? []).map(async (fileName) => ({
      fileName,
      exists: await fileExists(resolveWorkspacePath(fileName)),
    })),
  )

  return {
    ideaExists,
    statusBootstrapped,
    status,
    phase,
    checkedItems,
    totalItems,
    nextMilestone,
    scopedFiles,
  }
}

function buildSessionContext(transcript: TranscriptEntry[]) {
  const conversation = transcript.filter(
    (entry) => entry.role !== 'tool' && entry.text.trim().length > 0,
  )

  if (conversation.length === 0) {
    return 'No previous conversation turns in this session.'
  }

  return conversation
    .slice(-SESSION_HISTORY_LIMIT * 2)
    .map((entry) => `${entry.role === 'user' ? 'User' : 'Assistant'}: ${entry.text}`)
    .join('\n\n')
}

function buildAgentPrompt(
  userInput: string,
  workflow: WorkflowSummary,
  transcript: TranscriptEntry[],
  recentChanges: string[],
) {
  const workflowLines = [
    `IDEA.md present: ${workflow.ideaExists ? 'yes' : 'no'}`,
    `Current phase: ${workflow.phase ?? 'not set yet'}`,
    `Progress: ${workflow.checkedItems}/${workflow.totalItems}`,
    workflow.nextMilestone
      ? `Next milestone (${workflow.nextMilestone.itemId}): ${workflow.nextMilestone.text}`
      : 'No incomplete milestone remains.',
    workflow.nextMilestone
      ? `Files in scope: ${workflow.nextMilestone.sourceFiles.join(', ')}`
      : 'Files in scope: none',
    `Recent session file changes: ${recentChanges.length > 0 ? recentChanges.join(', ') : 'none'}`,
  ]

  return [
    'Current workflow state:',
    workflowLines.join('\n'),
    '',
    'Conversation so far:',
    buildSessionContext(transcript),
    '',
    'Latest user input:',
    userInput,
    '',
    'Use tools when you need repo state or need to update workspace files.',
    'Respect the current milestone and keep STATUS.json aligned with the actual file state.',
  ].join('\n')
}

function formatStatusItemText(text: string, sectionTitle?: string) {
  return sectionTitle ? `${text} (${sectionTitle})` : text
}

function renderStatusItem(item: TodoItem, key: string, sectionTitle?: string) {
  const itemText = formatStatusItemText(item.text, sectionTitle)

  if (!item.checked) {
    return <text key={key} content={`- [ ] ${itemText}`} wrapMode="word" />
  }

  return (
    <text key={key} wrapMode="word">
      <span fg="brightBlack" attributes={DIM_TEXT_ATTRIBUTES}>
        - [
      </span>
      <span fg="green">x</span>
      <span fg="brightBlack" attributes={DIM_TEXT_ATTRIBUTES}>
        {`] ${itemText}`}
      </span>
    </text>
  )
}

function renderStatusSidebar(workflow: WorkflowSummary) {
  const pendingItems = workflow.status.sections.flatMap((section) =>
    section.items
      .filter((item) => !item.checked)
      .map((item) => ({ item, sectionTitle: section.title })),
  )
  const elements: ReactNode[] = []

  if (workflow.phase) {
    elements.push(
      <box key="phase" marginBottom={1}>
        <text content={`Current phase: ${workflow.phase}`} wrapMode="word" />
      </box>,
    )
  }

  elements.push(
    <box key="progress" marginBottom={1}>
      <text
        content={`Progress: ${workflow.checkedItems}/${workflow.totalItems} complete`}
        wrapMode="word"
      />
    </box>,
  )

  if (pendingItems.length > 0) {
    elements.push(
      <box key="next-up" marginBottom={1} flexDirection="column">
        <box marginBottom={1}>
          <text content="Next Up" />
        </box>
        {pendingItems.slice(0, 5).map(({ item, sectionTitle }) => (
          <box key={`next-${item.itemId}`}>
            {renderStatusItem(item, `next-item-${item.itemId}`, sectionTitle)}
          </box>
        ))}
      </box>,
    )
  }

  for (const section of workflow.status.sections) {
    elements.push(
      <box key={section.sectionId} marginBottom={1} flexDirection="column">
        <box marginBottom={1}>
          <text content={section.title} />
        </box>
        {section.items.map((item) => (
          <box key={item.itemId}>{renderStatusItem(item, `section-item-${item.itemId}`)}</box>
        ))}
      </box>,
    )
  }

  return elements
}

function normalizeFileContent(fileName: string, content: string) {
  if (fileName.endsWith('.json')) {
    return `${JSON.stringify(JSON.parse(content), null, 2)}\n`
  }

  if (fileName.endsWith('.jsonl')) {
    const normalizedLines = content
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.stringify(JSON.parse(line)))

    return normalizedLines.length === 0 ? '' : `${normalizedLines.join('\n')}\n`
  }

  return content.endsWith('\n') ? content : `${content}\n`
}

async function validateWorkspaceFile(fileName: string) {
  switch (fileName) {
    case 'PROJECT.json':
      await loadProject(ROOT_DIR)
      return
    case 'STORYBOARD.json':
      await loadStoryboard(ROOT_DIR)
      return
    case 'REFERENCES.json':
      await loadReferences(ROOT_DIR)
      return
    case 'KEYFRAMES.json':
      await loadKeyframes(ROOT_DIR)
      return
    case 'PROMPT-PACK.json':
      await loadPromptPack(ROOT_DIR)
      return
    case 'STATUS.json':
      await loadStatus(ROOT_DIR)
      return
    case 'QC.json':
      await loadQc(ROOT_DIR)
      return
    case 'EDIT.json':
      await loadEdit(ROOT_DIR)
      return
    case 'TESTS.json':
      await loadTests(ROOT_DIR)
      return
    case 'GENERATION-LOG.jsonl':
      await loadGenerationLog(ROOT_DIR)
      return
    default:
      return
  }
}

async function safeWriteWorkspaceFile(fileName: string, content: string) {
  assertWorkspaceFile(fileName)

  const workspacePath = resolveWorkspacePath(fileName)
  const templatePath = resolveTemplatePath(fileName)
  const targetAlreadyExists = await fileExists(workspacePath)
  const templateExists = await fileExists(templatePath)
  let bootstrappedFromTemplate = false
  let previousContent: string | null = null

  if (targetAlreadyExists) {
    previousContent = await readFile(workspacePath, 'utf8')
  } else if (templateExists) {
    await mkdir(path.dirname(workspacePath), { recursive: true })
    await copyFile(templatePath, workspacePath)
    bootstrappedFromTemplate = true
    previousContent = await readFile(workspacePath, 'utf8')
  } else {
    await mkdir(path.dirname(workspacePath), { recursive: true })
  }

  const normalizedContent = normalizeFileContent(fileName, content)
  const lineChanges = countChangedLines(previousContent, normalizedContent)

  await writeFile(workspacePath, normalizedContent, 'utf8')

  try {
    await validateWorkspaceFile(fileName)
  } catch (error) {
    if (previousContent === null) {
      await rm(workspacePath, { force: true })
    } else {
      await writeFile(workspacePath, previousContent, 'utf8')
    }

    throw error
  }

  return {
    bootstrappedFromTemplate,
    bytesWritten: normalizedContent.length,
    lineChanges,
    workspacePath,
  }
}

async function readWorkspaceFileContents(fileName: string) {
  assertWorkspaceFile(fileName)

  const workspacePath = resolveWorkspacePath(fileName)
  const templatePath = resolveTemplatePath(fileName)
  const exists = await fileExists(workspacePath)

  if (exists) {
    return {
      fileName,
      exists: true,
      workspacePath,
      templatePath: (await fileExists(templatePath)) ? templatePath : null,
      content: await readFile(workspacePath, 'utf8'),
    }
  }

  const templateExists = await fileExists(templatePath)

  return {
    fileName,
    exists: false,
    workspacePath,
    templatePath: templateExists ? templatePath : null,
    templateContent: templateExists ? await readFile(templatePath, 'utf8') : null,
    content: null,
  }
}

function formatInitialAssistantMessage(workflow: WorkflowSummary) {
  if (!workflow.ideaExists) {
    return 'workspace/IDEA.md is missing, so the first step is to capture the irreducible concept.'
  }

  if (workflow.statusBootstrapped) {
    return 'Creative workflow agent ready. Bootstrapped workspace/STATUS.json from the template.'
  }

  return 'Creative workflow agent ready.'
}

function parseReadToolEvent(message: string) {
  const match = /^Read (.+)$/.exec(message)

  if (!match || !match[1]) {
    return null
  }

  return { fileName: match[1] }
}

function parseWriteToolEvent(message: string) {
  const match = /^Updated (.+?) \(\+(\d+) -(\d+)\)(?: .*)?$/.exec(message)

  if (!match) {
    return null
  }

  return {
    fileName: match[1],
    added: Number(match[2]),
    removed: Number(match[3]),
  }
}

function collapseToolEntries(entries: TranscriptEntry[]) {
  const collapsedEntries: DisplayTranscriptEntry[] = []
  const pendingReadFiles = new Set<string>()
  let readEntryId: string | null = null

  const flushReadSummary = () => {
    if (pendingReadFiles.size === 0 || !readEntryId) {
      return
    }

    collapsedEntries.push({
      id: readEntryId,
      role: 'tool',
      text: `Explored ${pendingReadFiles.size} ${pendingReadFiles.size === 1 ? 'file' : 'files'}`,
    })
    pendingReadFiles.clear()
    readEntryId = null
  }

  for (const entry of entries) {
    const readEvent = parseReadToolEvent(entry.text)

    if (readEvent) {
      pendingReadFiles.add(readEvent.fileName)
      readEntryId ??= entry.id
      continue
    }

    const writeEvent = parseWriteToolEvent(entry.text)

    if (writeEvent) {
      flushReadSummary()
      collapsedEntries.push({
        id: entry.id,
        role: 'tool',
        text: `Edited ${writeEvent.fileName} +${writeEvent.added} -${writeEvent.removed}`,
      })
    }
  }

  flushReadSummary()

  return collapsedEntries
}

function buildDisplayTranscript(
  transcript: TranscriptEntry[],
  activeAssistantEntryId: string | null,
  isBusy: boolean,
) {
  const displayEntries: DisplayTranscriptEntry[] = []
  let pendingToolEntries: TranscriptEntry[] = []

  const flushToolEntries = (nextEntry?: TranscriptEntry) => {
    if (pendingToolEntries.length === 0) {
      return
    }

    const shouldRenderLive =
      (nextEntry?.id === activeAssistantEntryId && nextEntry.text.trim().length === 0) ||
      (nextEntry === undefined && isBusy)

    if (shouldRenderLive) {
      displayEntries.push(...pendingToolEntries)
      pendingToolEntries = []
      return
    }

    displayEntries.push(...collapseToolEntries(pendingToolEntries))
    pendingToolEntries = []
  }

  for (const entry of transcript) {
    if (entry.role === 'tool') {
      pendingToolEntries.push(entry)
      continue
    }

    flushToolEntries(entry)

    if (entry.text.trim().length > 0) {
      displayEntries.push(entry)
    }
  }

  flushToolEntries()

  return displayEntries
}

function createDefaultPersistedAgentState(workflow: WorkflowSummary): PersistedAgentState {
  return {
    version: PERSISTED_AGENT_STATE_VERSION,
    transcript: [
      {
        id: createId('assistant'),
        role: 'assistant',
        text: formatInitialAssistantMessage(workflow),
      },
    ],
    composerValue: '',
    recentChanges: workflow.statusBootstrapped ? [WORKFLOW_FILES.status] : [],
    runtimeError: null,
  }
}

function clonePersistedAgentState(state: PersistedAgentState): PersistedAgentState {
  return {
    version: state.version,
    transcript: state.transcript.map((entry) => ({ ...entry })),
    composerValue: state.composerValue,
    recentChanges: [...state.recentChanges],
    runtimeError: state.runtimeError,
  }
}

async function loadPersistedAgentState(workflow: WorkflowSummary): Promise<PersistedAgentState> {
  const fallback = createDefaultPersistedAgentState(workflow)

  if (!(await fileExists(AGENT_STATE_PATH))) {
    return fallback
  }

  try {
    const raw = await readFile(AGENT_STATE_PATH, 'utf8')
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

function countChangedLines(previousContent: string | null, nextContent: string) {
  const previousLines =
    previousContent === null || previousContent.length === 0
      ? []
      : previousContent.replace(/\n$/, '').split('\n')
  const nextLines = nextContent.length === 0 ? [] : nextContent.replace(/\n$/, '').split('\n')

  let prefixLength = 0

  while (
    prefixLength < previousLines.length &&
    prefixLength < nextLines.length &&
    previousLines[prefixLength] === nextLines[prefixLength]
  ) {
    prefixLength += 1
  }

  let suffixLength = 0

  while (
    suffixLength < previousLines.length - prefixLength &&
    suffixLength < nextLines.length - prefixLength &&
    previousLines[previousLines.length - 1 - suffixLength] ===
      nextLines[nextLines.length - 1 - suffixLength]
  ) {
    suffixLength += 1
  }

  return {
    added: Math.max(0, nextLines.length - prefixLength - suffixLength),
    removed: Math.max(0, previousLines.length - prefixLength - suffixLength),
  }
}

function createVideoAgent(creativePrompt: string, bridgeRef: RefObject<AgentBridge>) {
  return new ToolLoopAgent({
    model: 'openai/gpt-5.4',
    instructions: creativePrompt,
    stopWhen: stepCountIs(20),
    tools: {
      getWorkflowState: tool({
        description:
          'Read the current workspace workflow state, including the next incomplete milestone and the files currently in scope.',
        inputSchema: z.object({}),
        execute: async () => {
          const workflow = await loadWorkflowSummary()
          await bridgeRef.current?.refreshWorkflow()

          return workflow
        },
      }),
      readWorkspaceFile: tool({
        description:
          'Read one canonical workspace file by filename. If the file is missing and a matching template exists, return the template scaffold too.',
        inputSchema: z.object({
          fileName: z
            .string()
            .describe(
              'Canonical workspace filename such as IDEA.md, STATUS.json, STORY.md, or PROJECT.json',
            ),
        }),
        execute: async ({ fileName }) => {
          const result = await readWorkspaceFileContents(fileName)
          bridgeRef.current?.recordToolEvent(`Read ${fileName}`)

          return result
        },
      }),
      writeWorkspaceFile: tool({
        description:
          'Write the full contents of one canonical workspace file. Only use this for workspace files and keep the file aligned with the active workflow milestone.',
        inputSchema: z.object({
          fileName: z
            .string()
            .describe(
              'Canonical workspace filename such as STORY.md, PROJECT.json, or REFERENCES.json',
            ),
          content: z.string().describe('The complete new file contents.'),
        }),
        execute: async ({ fileName, content }) => {
          const result = await safeWriteWorkspaceFile(fileName, content)

          bridgeRef.current?.recordToolEvent(
            `Updated ${fileName} (+${result.lineChanges.added} -${result.lineChanges.removed})${result.bootstrappedFromTemplate ? ' (bootstrapped from template)' : ''}`,
          )
          bridgeRef.current?.recordFileChange(fileName)
          await bridgeRef.current?.refreshWorkflow()

          return {
            fileName,
            ...result,
          }
        },
      }),
      updateStatusItem: tool({
        description:
          'Check or uncheck one workflow milestone in workspace/STATUS.json after the corresponding files truly make it complete.',
        inputSchema: z.object({
          itemId: z.string().describe('The STATUS.json itemId to update.'),
          checked: z.boolean().describe('The new checked state for the item.'),
        }),
        execute: async ({ itemId, checked }) => {
          await ensureStatusBootstrapped()

          const status = await loadStatus(ROOT_DIR)
          let updatedSection: TodoSection | null = null
          let updatedItem: TodoItem | null = null

          for (const section of status.sections) {
            const match = section.items.find((item) => item.itemId === itemId)

            if (match) {
              match.checked = checked
              updatedSection = section
              updatedItem = match
              break
            }
          }

          if (!updatedSection || !updatedItem) {
            throw new Error(`Could not find STATUS.json itemId ${itemId}.`)
          }

          const statusPath = resolveWorkspacePath(WORKFLOW_FILES.status)
          await writeFile(statusPath, `${JSON.stringify(status, null, 2)}\n`, 'utf8')
          await loadStatus(ROOT_DIR)

          bridgeRef.current?.recordToolEvent(
            `${checked ? 'Checked' : 'Unchecked'} STATUS item ${itemId}`,
          )
          bridgeRef.current?.recordFileChange(WORKFLOW_FILES.status)
          await bridgeRef.current?.refreshWorkflow()

          return {
            itemId,
            checked,
            sectionTitle: updatedSection.title,
            text: updatedItem.text,
          }
        },
      }),
    },
  })
}

function App({ creativePrompt, initialWorkflow, initialSession, statePersistence }: AppProps) {
  const [transcript, setTranscript] = useState<TranscriptEntry[]>(initialSession.transcript)
  const [composerValue, setComposerValue] = useState(initialSession.composerValue)
  const [workflow, setWorkflow] = useState(initialWorkflow)
  const [recentChanges, setRecentChanges] = useState<string[]>(initialSession.recentChanges)
  const [isBusy, setIsBusy] = useState(false)
  const [runtimeError, setRuntimeError] = useState<string | null>(initialSession.runtimeError)

  const transcriptRef = useRef<TranscriptEntry[]>(initialSession.transcript)
  const composerValueRef = useRef(initialSession.composerValue)
  const recentChangesRef = useRef<string[]>(initialSession.recentChanges)
  const runtimeErrorRef = useRef<string | null>(initialSession.runtimeError)
  const activeAssistantEntryIdRef = useRef<string | null>(null)
  const assistantHasStartedRef = useRef(false)
  const composerInputRef = useRef<InputRenderable | null>(null)
  const bridgeRef = useRef<AgentBridge>({
    recordToolEvent: () => {},
    recordFileChange: () => {},
    refreshWorkflow: async () => initialWorkflow,
  })

  const focusComposerInput = () => {
    if (!isBusy) {
      composerInputRef.current?.focus()
    }
  }

  const persistSession = () => {
    statePersistence.saveSession({
      version: PERSISTED_AGENT_STATE_VERSION,
      transcript: transcriptRef.current,
      composerValue: composerValueRef.current,
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

  useEffect(() => {
    persistSession()
  }, [])

  bridgeRef.current.recordToolEvent = (message) => {
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
  }

  bridgeRef.current.recordFileChange = (fileName) => {
    const nextRecentChanges = [
      fileName,
      ...recentChangesRef.current.filter((entry) => entry !== fileName),
    ].slice(0, 8)
    setRecentChangesState(nextRecentChanges)
  }

  bridgeRef.current.refreshWorkflow = async () => {
    const nextWorkflow = await loadWorkflowSummary()
    setWorkflow(nextWorkflow)

    return nextWorkflow
  }

  const agent = useMemo(() => createVideoAgent(creativePrompt, bridgeRef), [creativePrompt])
  const displayTranscript = useMemo(
    () => buildDisplayTranscript(transcript, activeAssistantEntryIdRef.current, isBusy),
    [isBusy, transcript],
  )
  const statusSidebar = useMemo(() => renderStatusSidebar(workflow), [workflow])

  async function submitPrompt(input: string) {
    const trimmedInput = input.trim()

    if (isBusy || trimmedInput.length === 0) {
      return
    }

    setRuntimeErrorState(null)
    setComposerValueState('')
    setIsBusy(true)

    const assistantEntryId = createId('assistant')
    const priorTranscript = transcriptRef.current
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

    try {
      const latestWorkflow = await loadWorkflowSummary()
      setWorkflow(latestWorkflow)

      const result = await agent.stream({
        prompt: buildAgentPrompt(
          trimmedInput,
          latestWorkflow,
          priorTranscript,
          recentChangesRef.current,
        ),
        experimental_onToolCallStart: ({ toolCall }) => {
          bridgeRef.current.recordToolEvent(`Running ${toolCall.toolName}`)
        },
        experimental_onToolCallFinish: ({ toolCall, success }) => {
          bridgeRef.current.recordToolEvent(
            `${success ? 'Completed' : 'Failed'} ${toolCall.toolName}`,
          )
        },
      })

      for await (const delta of result.textStream) {
        if (!assistantHasStartedRef.current && delta.length > 0) {
          assistantHasStartedRef.current = true
        }

        patchTranscriptEntry(assistantEntryId, (entry) => ({
          ...entry,
          text: entry.text + delta,
        }))
      }

      const finalText = (await result.text).trim()

      patchTranscriptEntry(assistantEntryId, (entry) => ({
        ...entry,
        text: finalText.length > 0 ? finalText : entry.text || 'No response generated.',
      }))
      assistantHasStartedRef.current = finalText.length > 0

      await bridgeRef.current.refreshWorkflow()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)

      setRuntimeErrorState(message)
      patchTranscriptEntry(assistantEntryId, (entry) => ({
        ...entry,
        text:
          entry.text.trim().length > 0
            ? `${entry.text}\n\n[error] ${message}`
            : `[error] ${message}`,
      }))
    } finally {
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
        title="Creative Agent"
        padding={1}
        flexDirection="column"
        onMouseDown={focusComposerInput}
      >
        <scrollbox flexGrow={1} stickyScroll stickyStart="bottom" paddingRight={1}>
          {displayTranscript.map((entry, index) => {
            const nextEntry = displayTranscript[index + 1]
            const marginBottom = entry.role === 'tool' && nextEntry?.role === 'tool' ? 0 : 1

            if (entry.role === 'user') {
              return (
                <box key={entry.id} width="100%" alignItems="flex-end" marginBottom={marginBottom}>
                  <box width="90%" backgroundColor="#5a5a5a" padding={1} paddingLeft={2}>
                    <text content={entry.text} wrapMode="word" />
                  </box>
                </box>
              )
            }

            if (entry.role === 'tool') {
              return (
                <box key={entry.id} marginBottom={marginBottom}>
                  <text content={entry.text} fg="brightBlack" truncate />
                </box>
              )
            }

            return (
              <box key={entry.id} marginBottom={marginBottom}>
                <text content={entry.text} wrapMode="word" />
              </box>
            )
          })}
        </scrollbox>
        <box
          border
          title={isBusy ? 'Thinking...' : 'Input'}
          paddingLeft={1}
          paddingRight={1}
          paddingTop={0}
          paddingBottom={0}
          marginTop={1}
        >
          <input
            ref={composerInputRef}
            focused={!isBusy}
            value={composerValue}
            placeholder={
              isBusy
                ? 'Wait for the current turn to finish.'
                : 'Type a creative request and press Enter.'
            }
            onInput={(value: string) => {
              setComposerValueState(value)
            }}
            onSubmit={(valueOrEvent: unknown) => {
              void submitPrompt(
                typeof valueOrEvent === 'string' ? valueOrEvent : composerValueRef.current,
              )
            }}
          />
        </box>
        {runtimeError ? (
          <box marginTop={1}>
            <text content={`Runtime error: ${runtimeError}`} />
          </box>
        ) : null}
      </box>
      <box width={42} flexShrink={0}>
        <box border title="STATUS" padding={1} flexGrow={1} flexDirection="column">
          <scrollbox flexGrow={1} paddingRight={1}>
            <box flexDirection="column">{statusSidebar}</box>
          </scrollbox>
        </box>
      </box>
    </box>
  )
}

async function main() {
  if (!process.env.AI_GATEWAY_API_KEY) {
    throw new Error(
      'AI_GATEWAY_API_KEY is required to run video-agent.tsx with the Vercel AI Gateway.',
    )
  }

  const creativePrompt = await readFile(CREATIVE_PROMPT_PATH, 'utf8')
  const initialWorkflow = await loadWorkflowSummary()
  const initialSession = await loadPersistedAgentState(initialWorkflow)
  const statePersistence = createAgentStatePersistence()
  let renderer: Awaited<ReturnType<typeof createCliRenderer>> | null = null
  let shuttingDown = false

  const shutdown = (exitCode: number) => {
    if (shuttingDown) {
      return
    }

    shuttingDown = true

    void (async () => {
      await statePersistence.flush()
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
      creativePrompt={creativePrompt}
      initialWorkflow={initialWorkflow}
      initialSession={initialSession}
      statePersistence={statePersistence}
    />,
  )
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
