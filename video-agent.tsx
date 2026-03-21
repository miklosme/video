import { access, copyFile, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'

import { createCliRenderer, createTextAttributes, type InputRenderable } from '@opentui/core'
import { createRoot, useKeyboard } from '@opentui/react'
import { stepCountIs, tool, ToolLoopAgent, type ModelMessage } from 'ai'
import { useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react'
import { z } from 'zod'

import {
  loadConfig,
  loadKeyframePrompts,
  loadKeyframes,
  loadModelOptions,
  loadStatus,
  loadVideoPrompts,
  validateConfigAgainstModelOptions,
  WORKFLOW_FILES,
  type ConfigData,
  type ModelOptionsData,
  type StatusData,
} from './workflow-data'

const ROOT_DIR = process.cwd()
const WORKSPACE_DIR = path.resolve(ROOT_DIR, 'workspace')
const TEMPLATES_DIR = path.resolve(ROOT_DIR, 'templates')
const CREATIVE_PROMPT_PATH = path.resolve(ROOT_DIR, 'CREATIVE_AGENTS.md')
const PROMPTING_GUIDE_PATH = path.resolve(ROOT_DIR, 'MODEL_PROMPTING_GUIDE.md')
const STATUS_TEMPLATE_PATH = path.resolve(TEMPLATES_DIR, 'STATUS.template.json')
const AGENT_STATE_PATH = path.resolve(ROOT_DIR, '.history.json')
const SESSION_HISTORY_LIMIT = 12
const PERSISTED_AGENT_STATE_VERSION = 1

const ALLOWED_WORKSPACE_FILES = new Set([
  'IDEA.md',
  'CONFIG.json',
  'STORY.md',
  'CHARACTERS.md',
  'STORYBOARD.md',
  'KEYFRAMES.json',
  'KEYFRAME-PROMPTS.json',
  'VIDEO-PROMPTS.json',
  'STATUS.json',
])

const ALLOWED_WORKSPACE_FOLDERS = new Set(['CHARACTER-SHEETS/', 'STORYBOARD-SHOTS/'])

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

type ArtifactReadiness = 'missing' | 'incomplete' | 'ready'
type WorkflowVisualState = ArtifactReadiness | 'approved'

interface WorkflowMilestoneSummary {
  index: number
  title: string
  instruction: string
  relatedFiles: string[]
  checked: boolean
  state: WorkflowVisualState
}

interface WorkflowStatusItem {
  title: string
  instruction: string
  checked: boolean
  relatedFiles: string[]
  state: WorkflowVisualState
}

interface WorkflowSummary {
  ideaExists: boolean
  configBootstrapped: boolean
  config: ConfigData
  modelOptions: ModelOptionsData
  statusBootstrapped: boolean
  status: WorkflowStatusItem[]
  checkedItems: number
  totalItems: number
  nextMilestone: WorkflowMilestoneSummary | null
  scopedFiles: WorkflowFileSummary[]
}

interface BootstrappedWorkspaceFile {
  fileName: string
  workspacePath: string
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
  role: 'assistant' | 'user'
  text: string
}

interface WorkflowResetResult {
  removedFiles: string[]
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
  imageModel: 'Used for still-image and keyframe prompt generation.',
  videoModel: 'Used for motion and video prompt generation.',
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

function assertWorkspaceFolder(folderName: string) {
  if (!ALLOWED_WORKSPACE_FOLDERS.has(folderName)) {
    throw new Error(`Folder ${folderName} is not an allowed workspace source-of-truth folder.`)
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

function createDefaultConfigFromModelOptions(modelOptions: ModelOptionsData): ConfigData {
  const agentModel = modelOptions.agentModels[0]
  const imageModel = modelOptions.imageModels[0]
  const videoModel = modelOptions.videoModels[0]

  if (!agentModel || !imageModel || !videoModel) {
    throw new Error('MODEL_OPTIONS.json must provide at least one option for each model type.')
  }

  return {
    agentModel,
    imageModel,
    videoModel,
  }
}

function normalizeConfigValue(
  value: unknown,
  allowedValues: string[],
  fallbackValue: string,
): string {
  if (typeof value === 'string' && allowedValues.includes(value)) {
    return value
  }

  return fallbackValue
}

function normalizeConfigData(value: unknown, modelOptions: ModelOptionsData): ConfigData {
  const defaultConfig = createDefaultConfigFromModelOptions(modelOptions)
  const candidate = typeof value === 'object' && value !== null ? value : {}
  const object = candidate as Record<string, unknown>

  return {
    agentModel: normalizeConfigValue(
      object.agentModel,
      modelOptions.agentModels,
      defaultConfig.agentModel,
    ),
    imageModel: normalizeConfigValue(
      object.imageModel,
      modelOptions.imageModels,
      defaultConfig.imageModel,
    ),
    videoModel: normalizeConfigValue(
      object.videoModel,
      modelOptions.videoModels,
      defaultConfig.videoModel,
    ),
  }
}

async function ensureConfigBootstrapped() {
  const workspacePath = resolveWorkspacePath(WORKFLOW_FILES.config)
  const modelOptions = await loadModelOptions(ROOT_DIR)
  const defaultConfig = createDefaultConfigFromModelOptions(modelOptions)
  const normalizedDefaultContent = `${JSON.stringify(defaultConfig, null, 2)}\n`

  if (!(await fileExists(workspacePath))) {
    await mkdir(path.dirname(workspacePath), { recursive: true })
    await writeFile(workspacePath, normalizedDefaultContent, 'utf8')

    return true
  }

  let normalizedConfig = defaultConfig

  try {
    const raw = await readFile(workspacePath, 'utf8')
    normalizedConfig = normalizeConfigData(JSON.parse(raw), modelOptions)
  } catch {
    normalizedConfig = defaultConfig
  }

  const normalizedContent = `${JSON.stringify(normalizedConfig, null, 2)}\n`
  const currentContent = await readFile(workspacePath, 'utf8').catch(() => '')

  if (currentContent !== normalizedContent) {
    await writeFile(workspacePath, normalizedContent, 'utf8')
    return true
  }

  return false
}

async function bootstrapWorkspaceFileFromTemplate(
  fileName: string,
): Promise<BootstrappedWorkspaceFile | null> {
  assertWorkspaceFile(fileName)

  const workspacePath = resolveWorkspacePath(fileName)
  if (await fileExists(workspacePath)) {
    return null
  }

  const templatePath = resolveTemplatePath(fileName)
  if (!(await fileExists(templatePath))) {
    return null
  }

  await mkdir(path.dirname(workspacePath), { recursive: true })
  await copyFile(templatePath, workspacePath)

  try {
    await validateWorkspaceFile(fileName)
  } catch (error) {
    await rm(workspacePath, { force: true })
    throw error
  }

  return {
    fileName,
    workspacePath,
  }
}

async function bootstrapMissingWorkspaceFiles(fileNames: string[]) {
  const results = await Promise.all(
    [...new Set(fileNames)].map((fileName) => bootstrapWorkspaceFileFromTemplate(fileName)),
  )

  return results.filter((result): result is BootstrappedWorkspaceFile => result !== null)
}

function containsPlaceholderMarkers(content: string) {
  return /\bTBD\b/.test(content) || /\[[^\]\n]+\]/.test(content)
}

function extractMeaningfulText(content: string) {
  return content
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'))
    .join(' ')
}

function hasSubstantiveText(content: string, minLength = 24) {
  return extractMeaningfulText(content).replace(/\s+/g, ' ').trim().length >= minLength
}

function containsPlaceholderValue(value: unknown): boolean {
  if (typeof value === 'string') {
    return value.trim().length === 0 || /\bTBD\b/.test(value)
  }

  if (Array.isArray(value)) {
    return value.some((entry) => containsPlaceholderValue(entry))
  }

  if (typeof value === 'object' && value !== null) {
    return Object.values(value).some((entry) => containsPlaceholderValue(entry))
  }

  return false
}

async function inspectWorkspaceArtifact(fileName: string): Promise<ArtifactReadiness> {
  const workspacePath = resolveWorkspacePath(fileName)

  if (fileName.endsWith('/')) {
    if (!(await fileExists(workspacePath))) {
      return 'missing'
    }

    const entries = await readdir(workspacePath)
    return entries.length === 0 ? 'incomplete' : 'ready'
  }

  if (!(await fileExists(workspacePath))) {
    return 'missing'
  }

  if (fileName.endsWith('.json')) {
    try {
      switch (fileName) {
        case 'CONFIG.json': {
          const [config, modelOptions] = await Promise.all([
            loadConfig(ROOT_DIR),
            loadModelOptions(ROOT_DIR),
          ])
          validateConfigAgainstModelOptions(config, modelOptions)
          return 'ready'
        }
        case 'KEYFRAMES.json': {
          const entries = await loadKeyframes(ROOT_DIR)
          if (entries.length === 0) {
            return 'incomplete'
          }

          return containsPlaceholderValue(entries) ? 'incomplete' : 'ready'
        }
        case 'KEYFRAME-PROMPTS.json': {
          await loadConfig(ROOT_DIR)
          const entries = await loadKeyframePrompts(ROOT_DIR)
          if (entries.length === 0) {
            return 'incomplete'
          }

          return containsPlaceholderValue(entries) ? 'incomplete' : 'ready'
        }
        case 'VIDEO-PROMPTS.json': {
          await loadConfig(ROOT_DIR)
          const entries = await loadVideoPrompts(ROOT_DIR)
          if (entries.length === 0) {
            return 'incomplete'
          }

          return containsPlaceholderValue(entries) ? 'incomplete' : 'ready'
        }
        default:
          return 'ready'
      }
    } catch {
      return 'incomplete'
    }
  }

  const content = await readFile(workspacePath, 'utf8')

  if (content.trim().length === 0) {
    return 'missing'
  }

  if (containsPlaceholderMarkers(content)) {
    return 'incomplete'
  }

  switch (fileName) {
    case 'IDEA.md':
      return hasSubstantiveText(content, 20) ? 'ready' : 'incomplete'
    case 'CHARACTERS.md':
      return /^## /m.test(content) && hasSubstantiveText(content, 40) ? 'ready' : 'incomplete'
    case 'STORYBOARD.md':
      return /SHOT-\d+/i.test(content) && hasSubstantiveText(content, 60) ? 'ready' : 'incomplete'
    default:
      return hasSubstantiveText(content, 40) ? 'ready' : 'incomplete'
  }
}

async function inspectMilestoneArtifacts(item: StatusData[number]): Promise<ArtifactReadiness> {
  const artifactStates = await Promise.all(
    item.relatedFiles.map((fileName) => inspectWorkspaceArtifact(fileName)),
  )

  if (artifactStates.every((state) => state === 'ready')) {
    return 'ready'
  }

  if (artifactStates.every((state) => state === 'missing')) {
    return 'missing'
  }

  return 'incomplete'
}

async function reconcileStatus(status: StatusData) {
  const artifactStates = await Promise.all(status.map((item) => inspectMilestoneArtifacts(item)))
  let changed = false

  const reconciledStatus = status.map((item, index) => {
    const checked = artifactStates[index] === 'ready'

    if (item.checked !== checked) {
      changed = true
      return { ...item, checked }
    }

    return item
  })

  if (changed) {
    const statusPath = resolveWorkspacePath(WORKFLOW_FILES.status)
    await writeFile(statusPath, `${JSON.stringify(reconciledStatus, null, 2)}\n`, 'utf8')
  }

  const latestCheckedIndex = reconciledStatus.reduce(
    (latestIndex, item, index) => (item.checked ? index : latestIndex),
    -1,
  )

  const derivedStatus: WorkflowStatusItem[] = reconciledStatus.map((item, index) => ({
    ...item,
    state: item.checked
      ? index === latestCheckedIndex
        ? 'ready'
        : 'approved'
      : (artifactStates[index] ?? 'incomplete'),
  }))

  return {
    status: derivedStatus,
    checkedItems: reconciledStatus.filter((item) => item.checked).length,
  }
}

function getNextIncompleteMilestone(status: WorkflowStatusItem[]): WorkflowMilestoneSummary | null {
  for (const [index, item] of status.entries()) {
    if (!item.checked) {
      return {
        index,
        title: item.title,
        instruction: item.instruction,
        relatedFiles: item.relatedFiles,
        checked: item.checked,
        state: item.state,
      }
    }
  }

  return null
}

async function bootstrapNextMilestoneScaffold(workflow: WorkflowSummary) {
  if (!workflow.nextMilestone) {
    return []
  }

  return bootstrapMissingWorkspaceFiles(workflow.nextMilestone.relatedFiles)
}

async function loadWorkflowSummary(): Promise<WorkflowSummary> {
  const ideaExists = await fileExists(resolveWorkspacePath('IDEA.md'))
  const configBootstrapped = await ensureConfigBootstrapped()
  const [config, modelOptions] = await Promise.all([
    loadConfig(ROOT_DIR),
    loadModelOptions(ROOT_DIR),
  ])
  validateConfigAgainstModelOptions(config, modelOptions)
  const statusBootstrapped = await ensureStatusBootstrapped()
  const statusData = await loadStatus(ROOT_DIR)
  const { status, checkedItems } = await reconcileStatus(statusData)
  const nextMilestone = getNextIncompleteMilestone(status)
  const totalItems = status.length
  const scopedFiles = await Promise.all(
    (nextMilestone?.relatedFiles ?? []).map(async (fileName) => ({
      fileName,
      exists: await fileExists(resolveWorkspacePath(fileName)),
    })),
  )

  return {
    ideaExists,
    configBootstrapped,
    config,
    modelOptions,
    statusBootstrapped,
    status,
    checkedItems,
    totalItems,
    nextMilestone,
    scopedFiles,
  }
}

function buildAgentMessages(userInput: string, transcript: TranscriptEntry[]): ModelMessage[] {
  const conversation = transcript
    .filter(
      (
        entry,
      ): entry is TranscriptEntry & {
        role: 'assistant' | 'user'
      } => entry.role !== 'tool' && entry.text.trim().length > 0,
    )
    .slice(-SESSION_HISTORY_LIMIT * 2)
    .map<ModelMessage>((entry) => ({
      role: entry.role,
      content: entry.text,
    }))

  return [
    ...conversation,
    {
      role: 'user',
      content: userInput,
    },
  ]
}

function buildRuntimeDirective(workflow: WorkflowSummary): ModelMessage {
  const lines = ['Private runtime brief for this turn:']

  if (workflow.nextMilestone) {
    lines.push(`Active creative milestone: ${workflow.nextMilestone.title}`)
    lines.push(`Milestone state: ${workflow.nextMilestone.state}`)
    lines.push(`Milestone outcome: ${workflow.nextMilestone.instruction}`)
    lines.push(`Primary source files: ${workflow.nextMilestone.relatedFiles.join(', ')}`)
  } else {
    lines.push('All visible creative milestones are currently ready.')
  }

  lines.push(
    `Configured models: agent=${workflow.config.agentModel}; image=${workflow.config.imageModel}; video=${workflow.config.videoModel}`,
  )

  lines.push('Behavioral bias:')
  lines.push(
    '- If the user just supplied enough information to complete or materially advance the active milestone, do that work now.',
  )
  lines.push('- Do not ask permission to perform the obvious next creative step.')
  lines.push(
    '- When you tee up the next milestone, make sure its missing scaffold is prepared before you frame that handoff.',
  )
  lines.push(
    '- Ask a follow-up only when a real creative ambiguity would materially change the output.',
  )
  lines.push('- Reserve "if you want, I can" for optional branches, not the default workflow path.')
  lines.push('Prompt-writing rules:')
  lines.push(
    '- Before writing or revising KEYFRAME-PROMPTS.json or VIDEO-PROMPTS.json, read workspace/CONFIG.json and MODEL_PROMPTING_GUIDE.md.',
  )
  lines.push(
    '- Use workspace/CONFIG.json.imageModel for KEYFRAME-PROMPTS.json model fields and still-image prompting style.',
  )
  lines.push(
    '- Use workspace/CONFIG.json.videoModel for VIDEO-PROMPTS.json model fields and motion-prompt style.',
  )

  return {
    role: 'system',
    content: lines.join('\n'),
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

function getSelectedModelIndex(values: string[], currentValue: string) {
  const selectedIndex = values.indexOf(currentValue)

  return selectedIndex === -1 ? 0 : selectedIndex
}

function renderConfigChoice(
  key: string,
  label: string,
  value: string,
  isSelected: boolean,
  onChoose: () => void,
) {
  return (
    <box
      key={key}
      border
      paddingLeft={1}
      paddingRight={1}
      backgroundColor={isSelected ? '#334455' : undefined}
      onMouseDown={onChoose}
    >
      <text wrapMode="word">
        <span attributes={DIM_TEXT_ATTRIBUTES}>{`${label}. `}</span>
        <span fg={isSelected ? 'yellow' : undefined}>{value}</span>
      </text>
    </box>
  )
}

function renderStatusItem(item: WorkflowStatusItem, key: string, index: number) {
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
    case 'CONFIG.json': {
      const [config, modelOptions] = await Promise.all([
        loadConfig(ROOT_DIR),
        loadModelOptions(ROOT_DIR),
      ])
      validateConfigAgainstModelOptions(config, modelOptions)
      return
    }
    case 'KEYFRAMES.json':
      await loadKeyframes(ROOT_DIR)
      return
    case 'KEYFRAME-PROMPTS.json':
      await loadKeyframePrompts(ROOT_DIR)
      return
    case 'VIDEO-PROMPTS.json':
      await loadVideoPrompts(ROOT_DIR)
      return
    case 'STATUS.json':
      await loadStatus(ROOT_DIR)
      return
    default:
      return
  }
}

async function applyWorkspaceFileWriteRules(fileName: string, content: string) {
  if (fileName !== WORKFLOW_FILES.keyframePrompts && fileName !== WORKFLOW_FILES.videoPrompts) {
    return content
  }

  const config = await loadConfig(ROOT_DIR)
  const parsed = JSON.parse(content)

  if (!Array.isArray(parsed)) {
    return content
  }

  if (fileName === WORKFLOW_FILES.keyframePrompts) {
    const nextEntries = parsed.map((entry) =>
      typeof entry === 'object' && entry !== null
        ? {
            ...entry,
            model: config.imageModel,
          }
        : entry,
    )

    return JSON.stringify(nextEntries, null, 2)
  }

  const nextEntries = parsed.map((entry) =>
    typeof entry === 'object' && entry !== null
      ? {
          ...entry,
          model: config.videoModel,
        }
      : entry,
  )

  return JSON.stringify(nextEntries, null, 2)
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

  const nextContent = await applyWorkspaceFileWriteRules(fileName, content)
  const normalizedContent = normalizeFileContent(fileName, nextContent)
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

async function ensureWorkspaceFolder(folderName: string) {
  assertWorkspaceFolder(folderName)

  const folderPath = resolveWorkspacePath(folderName)
  const existed = await fileExists(folderPath)

  await mkdir(folderPath, { recursive: true })

  return {
    folderName,
    existed,
    folderPath,
    entries: (await readdir(folderPath)).sort(),
  }
}

async function resetWorkflowFromMilestone(startIndex: number): Promise<WorkflowResetResult> {
  const status = await loadStatus(ROOT_DIR)

  if (!Number.isInteger(startIndex) || startIndex < 0 || startIndex >= status.length) {
    throw new Error(`Workflow milestone index ${startIndex} is out of range.`)
  }

  const affectedItem = status[startIndex]
  if (!affectedItem) {
    throw new Error(`Workflow milestone index ${startIndex} is out of range.`)
  }
  const relatedFiles = [...new Set(affectedItem.relatedFiles)]
  const removedFiles: string[] = []

  await Promise.all(
    relatedFiles.map(async (fileName) => {
      const workspacePath = resolveWorkspacePath(fileName)

      if (!(await fileExists(workspacePath))) {
        return
      }

      await rm(workspacePath, { recursive: true, force: true })
      removedFiles.push(fileName)
    }),
  )

  const nextStatus = status.map((item, index) =>
    index === startIndex
      ? {
          ...item,
          checked: false,
        }
      : item,
  )

  await writeFile(
    resolveWorkspacePath(WORKFLOW_FILES.status),
    `${JSON.stringify(nextStatus, null, 2)}\n`,
  )

  return {
    removedFiles: removedFiles.sort(),
  }
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
    composerValue: '',
    recentChanges: bootstrappedChanges,
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

function createVideoAgent(
  creativePrompt: string,
  agentModel: string,
  bridgeRef: RefObject<AgentBridge>,
) {
  return new ToolLoopAgent({
    model: agentModel,
    instructions: creativePrompt,
    stopWhen: stepCountIs(20),
    tools: {
      getCreativeContext: tool({
        description:
          'Read the current creative project context, including milestone readiness and the next milestone that needs creative work.',
        inputSchema: z.object({}),
        execute: async () => {
          const workflow = await loadWorkflowSummary()
          await bridgeRef.current?.refreshWorkflow()

          return workflow
        },
      }),
      readWorkspaceFile: tool({
        description:
          'Read one canonical creative workspace file by filename. If the file is missing and a matching template exists, return the scaffold as lower-priority guidance.',
        inputSchema: z.object({
          fileName: z
            .string()
            .describe(
              'Canonical workspace filename such as IDEA.md, CONFIG.json, STATUS.json, STORY.md, or KEYFRAME-PROMPTS.json',
            ),
        }),
        execute: async ({ fileName }) => {
          const result = await readWorkspaceFileContents(fileName)
          bridgeRef.current?.recordToolEvent(`Read ${fileName}`)

          return result
        },
      }),
      readPromptingGuide: tool({
        description:
          'Read MODEL_PROMPTING_GUIDE.md so prompt-writing work matches the configured model guidance.',
        inputSchema: z.object({}),
        execute: async () => {
          const content = await readFile(PROMPTING_GUIDE_PATH, 'utf8')
          bridgeRef.current?.recordToolEvent('Read MODEL_PROMPTING_GUIDE.md')

          return {
            path: PROMPTING_GUIDE_PATH,
            content,
          }
        },
      }),
      writeWorkspaceFile: tool({
        description:
          'Write the full contents of one canonical workspace file while preserving established canon and the current creative workflow.',
        inputSchema: z.object({
          fileName: z
            .string()
            .describe(
              'Canonical workspace filename such as CONFIG.json, STORY.md, KEYFRAMES.json, or VIDEO-PROMPTS.json',
            ),
          content: z.string().describe('The complete new file contents.'),
        }),
        execute: async ({ fileName, content }) => {
          const result = await safeWriteWorkspaceFile(fileName, content)
          const workflow = await loadWorkflowSummary()
          const bootstrappedFiles = await bootstrapNextMilestoneScaffold(workflow)

          bridgeRef.current?.recordToolEvent(
            `Updated ${fileName} (+${result.lineChanges.added} -${result.lineChanges.removed})${result.bootstrappedFromTemplate ? ' (bootstrapped from template)' : ''}`,
          )
          bridgeRef.current?.recordFileChange(fileName)

          if (bootstrappedFiles.length > 0) {
            bridgeRef.current?.recordToolEvent(
              `Prepared next milestone files: ${bootstrappedFiles.map(({ fileName }) => fileName).join(', ')}`,
            )

            for (const bootstrappedFile of bootstrappedFiles) {
              bridgeRef.current?.recordFileChange(bootstrappedFile.fileName)
            }
          }

          if (bridgeRef.current) {
            await bridgeRef.current.refreshWorkflow()
          }

          return {
            fileName,
            ...result,
          }
        },
      }),
      createWorkspaceFolder: tool({
        description:
          'Create or confirm one canonical workspace folder such as CHARACTER-SHEETS/ or STORYBOARD-SHOTS/ when the creative workflow needs it.',
        inputSchema: z.object({
          folderName: z
            .string()
            .describe('Canonical workspace folder name such as CHARACTER-SHEETS/'),
        }),
        execute: async ({ folderName }) => {
          const result = await ensureWorkspaceFolder(folderName)

          bridgeRef.current?.recordToolEvent(
            `${result.existed ? 'Confirmed' : 'Created'} ${folderName}`,
          )
          bridgeRef.current?.recordFileChange(folderName)
          await bridgeRef.current?.refreshWorkflow()

          return result
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
  const [pendingResetIndex, setPendingResetIndex] = useState<number | null>(null)
  const [isResettingMilestone, setIsResettingMilestone] = useState(false)
  const [openConfigField, setOpenConfigField] = useState<ConfigField | null>(null)
  const [configDraft, setConfigDraft] = useState<ConfigDraft>(() =>
    createConfigDraft(initialWorkflow.config),
  )
  const [isSavingConfig, setIsSavingConfig] = useState(false)

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
    if (!isBusy && pendingResetIndex === null && openConfigField === null) {
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
      const result = await resetWorkflowFromMilestone(pendingResetIndex)
      const changedEntries = [...result.removedFiles, WORKFLOW_FILES.status]

      setRecentChangesState(
        [
          ...changedEntries,
          ...recentChangesRef.current.filter((entry) => !changedEntries.includes(entry)),
        ].slice(0, 8),
      )
      await bridgeRef.current.refreshWorkflow()
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

  const saveConfig = async () => {
    if (isBusy || isResettingMilestone || isSavingConfig) {
      return
    }

    const nextConfig = {
      agentModel: configDraft.agentModel,
      imageModel: configDraft.imageModel,
      videoModel: configDraft.videoModel,
    }

    setRuntimeErrorState(null)
    setIsSavingConfig(true)

    try {
      validateConfigAgainstModelOptions(nextConfig, workflow.modelOptions)
      await safeWriteWorkspaceFile(WORKFLOW_FILES.config, JSON.stringify(nextConfig, null, 2))
      setRecentChangesState(
        [
          WORKFLOW_FILES.config,
          ...recentChangesRef.current.filter((entry) => entry !== WORKFLOW_FILES.config),
        ].slice(0, 8),
      )
      await bridgeRef.current.refreshWorkflow()
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

      if (event.name === 'up' || event.name === 'k') {
        const currentIndex = getSelectedModelIndex(activeConfigOptions, activeConfigValue)
        const nextIndex =
          currentIndex === 0 ? activeConfigOptions.length - 1 : Math.max(0, currentIndex - 1)
        const nextValue = activeConfigOptions[nextIndex]

        if (nextValue) {
          setOpenConfigValue(nextValue)
        }

        return
      }

      if (event.name === 'down' || event.name === 'j') {
        const currentIndex = getSelectedModelIndex(activeConfigOptions, activeConfigValue)
        const nextIndex = currentIndex === activeConfigOptions.length - 1 ? 0 : currentIndex + 1
        const nextValue = activeConfigOptions[nextIndex]

        if (nextValue) {
          setOpenConfigValue(nextValue)
        }

        return
      }

      if (event.name === 'return' || event.name === 'linefeed') {
        void saveConfig()
        return
      }

      if (typeof event.sequence === 'string' && /^[1-9]$/.test(event.sequence)) {
        const optionIndex = Number(event.sequence) - 1
        const optionValue = activeConfigOptions[optionIndex]

        if (optionValue) {
          setOpenConfigValue(optionValue)
          void saveConfig()
        }
      }

      return
    }

    if (pendingResetIndex === null) {
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

  const agent = useMemo(
    () => createVideoAgent(creativePrompt, workflow.config.agentModel, bridgeRef),
    [creativePrompt, workflow.config.agentModel],
  )
  const displayTranscript = useMemo(() => buildDisplayTranscript(transcript), [transcript])
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

  const setOpenConfigValue = (value: string) => {
    if (openConfigField === null) {
      return
    }

    setConfigDraft((current) => updateConfigDraftField(current, openConfigField, value))
  }

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
      let latestWorkflow = await loadWorkflowSummary()
      const bootstrappedFiles = await bootstrapNextMilestoneScaffold(latestWorkflow)

      if (bootstrappedFiles.length > 0) {
        setRecentChangesState(
          [
            ...bootstrappedFiles.map(({ fileName }) => fileName),
            ...recentChangesRef.current.filter(
              (entry) => !bootstrappedFiles.some((file) => file.fileName === entry),
            ),
          ].slice(0, 8),
        )
        latestWorkflow = await loadWorkflowSummary()
      }

      setWorkflow(latestWorkflow)
      const nextSubmittedMessages = [
        buildRuntimeDirective(latestWorkflow),
        ...buildAgentMessages(trimmedInput, priorTranscript),
      ]

      const result = await agent.stream({
        messages: nextSubmittedMessages,
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
                    <text content={entry.text} wrapMode="word" />
                  </box>
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
          height={3}
          flexShrink={0}
          paddingLeft={1}
          paddingRight={1}
          paddingTop={0}
          paddingBottom={0}
          marginTop={1}
        >
          <input
            ref={composerInputRef}
            focused={!isBusy && pendingResetIndex === null && openConfigField === null}
            value={composerValue}
            placeholder={
              isBusy
                ? 'Wait for the current turn to finish.'
                : 'Talk through the concept, story, shots, or prompts.'
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
      <box width={42} height="100%" flexShrink={0} flexDirection="column" gap={1}>
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
            width={84}
            border
            title={`Select ${activeConfigLabel}`}
            padding={1}
            flexDirection="column"
            backgroundColor="#202020"
          >
            <box marginBottom={1}>
              <text wrapMode="word">{activeConfigDescription ?? ''}</text>
            </box>
            <box marginBottom={1} flexDirection="column">
              <text content={activeConfigLabel ?? ''} wrapMode="word" />
              <box flexDirection="column" gap={1}>
                {activeConfigOptions.map((option, index) =>
                  renderConfigChoice(
                    `config-option-${option}`,
                    String(index + 1),
                    option,
                    option === activeConfigValue,
                    () => {
                      setOpenConfigValue(option)
                      void saveConfig()
                    },
                  ),
                )}
              </box>
            </box>
            <box marginBottom={1}>
              <text wrapMode="word">
                Click an option, or use Up/Down then Enter. Number keys like 1 or 2 also work.
              </text>
            </box>
            <box flexDirection="row" justifyContent="flex-end" gap={1}>
              <box
                border
                width={10}
                height={3}
                alignItems="center"
                justifyContent="center"
                onMouseDown={() => {
                  closeConfigDialog()
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
                  void saveConfig()
                }}
              >
                <text fg="black" content={isSavingConfig ? 'Saving...' : 'Save'} wrapMode="word" />
              </box>
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
  let initialWorkflow = await loadWorkflowSummary()
  const bootstrappedFiles = await bootstrapNextMilestoneScaffold(initialWorkflow)

  if (bootstrappedFiles.length > 0) {
    initialWorkflow = await loadWorkflowSummary()
  }

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
