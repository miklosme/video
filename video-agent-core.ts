import { copyFile, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'

import { stepCountIs, tool, ToolLoopAgent, type ModelMessage } from 'ai'
import { z } from 'zod'

import {
  loadCharacterSheets,
  loadConfig,
  loadKeyframeArtifacts,
  loadKeyframes,
  loadModelOptions,
  loadStatus,
  loadVideoPrompts,
  parseCharacterSheetEntry,
  parseKeyframeArtifactEntry,
  validateConfigAgainstModelOptions,
  WORKFLOW_FILES,
  WORKFLOW_FOLDERS,
  workspacePathExists,
  type CharacterSheetEntry,
  type ConfigData,
  type KeyframeArtifactEntry,
  type ModelOptionsData,
  type StatusData,
} from './workflow-data'

const SESSION_HISTORY_LIMIT = 12

const ALLOWED_WORKSPACE_FILES = new Set([
  'IDEA.md',
  'CONFIG.json',
  'STORY.md',
  'CHARACTERS.md',
  'STORYBOARD.md',
  'KEYFRAMES.json',
  'VIDEO-PROMPTS.json',
  'STATUS.json',
])

const ALLOWED_WORKSPACE_FOLDERS = new Set<string>([
  WORKFLOW_FOLDERS.characters,
  WORKFLOW_FOLDERS.keyframes,
])

export type TranscriptRole = 'assistant' | 'user' | 'tool'
export type ArtifactReadiness = 'missing' | 'incomplete' | 'ready'
export type WorkflowVisualState = ArtifactReadiness | 'approved'

export interface TranscriptEntry {
  id: string
  role: TranscriptRole
  text: string
}

export interface WorkflowFileSummary {
  fileName: string
  exists: boolean
}

export interface WorkflowMilestoneSummary {
  index: number
  title: string
  instruction: string
  relatedFiles: string[]
  checked: boolean
  state: WorkflowVisualState
}

export interface WorkflowStatusItem {
  title: string
  instruction: string
  checked: boolean
  relatedFiles: string[]
  state: WorkflowVisualState
}

export interface WorkflowSummary {
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

export interface BootstrappedWorkspaceFile {
  fileName: string
  workspacePath: string
}

export interface WorkflowResetResult {
  removedFiles: string[]
}

export interface WorkspaceFileReadResult {
  fileName: string
  exists: boolean
  workspacePath: string
  templatePath: string | null
  content: string | null
  templateContent?: string | null
}

export interface WorkspaceArtifactReadResult {
  artifactPath: string
  exists: boolean
  workspacePath: string
  content: string | null
  entries?: string[]
}

export interface WorkspaceFolderResult {
  folderName: string
  existed: boolean
  folderPath: string
  entries: string[]
}

export interface WorkspaceWriteResult {
  fileName: string
  bootstrappedFromTemplate: boolean
  bytesWritten: number
  lineChanges: {
    added: number
    removed: number
  }
  workspacePath: string
  bootstrappedFiles: BootstrappedWorkspaceFile[]
  workflow: WorkflowSummary
}

export interface RunTurnResult {
  text: string
  initialWorkflow: WorkflowSummary
  finalWorkflow: WorkflowSummary
  bootstrappedFiles: BootstrappedWorkspaceFile[]
}

export interface VideoAgentRuntimeEvents {
  onToolEvent?: (message: string) => void
  onFileChange?: (fileName: string) => void
  onWorkflowChange?: (workflow: WorkflowSummary) => void
}

export interface VideoAgentRunner {
  stream: (args: {
    messages: ModelMessage[]
    experimental_onToolCallStart?: (event: {
      toolCall: {
        toolName: string
      }
    }) => void
    experimental_onToolCallFinish?: (event: {
      toolCall: {
        toolName: string
      }
      success: boolean
    }) => void
  }) => Promise<{
    textStream: AsyncIterable<string>
    text: PromiseLike<string>
  }>
}

export interface VideoAgentRuntimeOptions extends VideoAgentRuntimeEvents {
  rootDir?: string
  creativePrompt?: string
  creativePromptPath?: string
  promptingGuidePath?: string
  createAgent?: (options: { instructions: string; model: string }) => VideoAgentRunner
}

export interface RunTurnOptions {
  userInput: string
  transcript: TranscriptEntry[]
  onTextDelta?: (delta: string) => void
}

export interface VideoAgentRuntime {
  setEventHandlers: (events: VideoAgentRuntimeEvents) => void
  loadWorkflowSummary: () => Promise<WorkflowSummary>
  bootstrapNextMilestoneScaffold: (
    workflow: WorkflowSummary,
  ) => Promise<BootstrappedWorkspaceFile[]>
  readWorkspaceFile: (fileName: string) => Promise<WorkspaceFileReadResult>
  writeWorkspaceFile: (fileName: string, content: string) => Promise<WorkspaceWriteResult>
  readWorkspaceArtifact: (artifactPath: string) => Promise<WorkspaceArtifactReadResult>
  writeWorkspaceArtifact: (
    artifactPath: string,
    content: string,
  ) => Promise<WorkspaceArtifactReadResult>
  ensureWorkspaceFolder: (folderName: string) => Promise<WorkspaceFolderResult>
  resetWorkflowFromMilestone: (startIndex: number) => Promise<WorkflowResetResult>
  runTurn: (options: RunTurnOptions) => Promise<RunTurnResult>
}

function resolveWorkspacePath(rootDir: string, fileName: string) {
  return path.resolve(rootDir, 'workspace', fileName)
}

function resolveTemplatePath(rootDir: string, fileName: string) {
  const extension = path.extname(fileName)
  const stem = fileName.slice(0, fileName.length - extension.length)

  return path.resolve(rootDir, 'templates', `${stem}.template${extension}`)
}

function resolveCreativePromptPath(rootDir: string, explicitPath?: string) {
  return explicitPath ?? path.resolve(rootDir, 'CREATIVE_AGENTS.md')
}

function resolvePromptingGuidePath(rootDir: string, explicitPath?: string) {
  return explicitPath ?? path.resolve(rootDir, 'MODEL_PROMPTING_GUIDE.md')
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

function getAllowedWorkspaceArtifactFolder(artifactPath: string) {
  const normalizedPath = path.posix.normalize(artifactPath.replace(/\\/g, '/'))

  for (const folderName of ALLOWED_WORKSPACE_FOLDERS) {
    if (normalizedPath === folderName || normalizedPath.startsWith(folderName)) {
      return folderName
    }
  }

  return null
}

function assertWorkspaceArtifactPath(artifactPath: string) {
  const normalizedPath = path.posix.normalize(artifactPath.replace(/\\/g, '/'))

  if (
    path.posix.isAbsolute(normalizedPath) ||
    normalizedPath === '..' ||
    normalizedPath.startsWith('../')
  ) {
    throw new Error(`Artifact path ${artifactPath} must stay within workspace.`)
  }

  const folderName = getAllowedWorkspaceArtifactFolder(normalizedPath)

  if (!folderName) {
    throw new Error(`Artifact ${artifactPath} is not inside an allowed workspace folder.`)
  }

  if (normalizedPath.endsWith('/')) {
    return
  }

  if (!normalizedPath.endsWith('.json')) {
    throw new Error(`Artifact ${artifactPath} must be a JSON sidecar file.`)
  }
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

function buildRuntimeDirective(workflow: WorkflowSummary, rawStatusContent: string): ModelMessage {
  const lines = ['Private runtime brief for this turn:']

  lines.push(
    `Configured models: agent=${workflow.config.agentModel}; image=${workflow.config.imageModel}; video=${workflow.config.videoModel}`,
  )
  lines.push('Use the raw workspace/STATUS.json below as the exact workflow map for this turn.')
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
    '- Before writing or revising keyframe sidecars, character-sheet sidecars, or VIDEO-PROMPTS.json, read workspace/CONFIG.json and MODEL_PROMPTING_GUIDE.md.',
  )
  lines.push(
    '- Use workspace/CONFIG.json.imageModel for workspace/KEYFRAMES/*.json and workspace/CHARACTERS/*.json model fields and still-image prompting style.',
  )
  lines.push(
    '- Character-sheet prompts are for downstream Veo reference assets, not hero shots: prefer one clean single-subject reference image with readable face, clear silhouette, stable wardrobe/markings, plain background, and soft even lighting.',
  )
  lines.push(
    '- Avoid grid or collage layouts, split panels, extra subjects, scene clutter, dramatic lighting, text overlays, and non-canonical props in character-sheet prompts unless they are part of identity.',
  )
  lines.push(
    '- Every KEYFRAMES.json entry must include characterIds listing only the characters visible in that frame, in reference priority order.',
  )
  lines.push(
    '- Character sidecar schema is exact: { characterId, displayName, model, prompt, status }.',
  )
  lines.push(
    '- Keyframe sidecar schema is exact: { keyframeId, shotId, frameType, model, prompt, status }.',
  )
  lines.push(
    '- Use workspace/CONFIG.json.videoModel for VIDEO-PROMPTS.json model fields and motion-prompt style.',
  )
  lines.push(
    '- Do not auto-run paid image generation. When sidecar JSON is ready but PNGs are missing, tell the user which script to run and continue after review.',
  )
  lines.push('Raw workspace/STATUS.json:')
  lines.push(rawStatusContent.trim())

  return {
    role: 'system',
    content: lines.join('\n'),
  }
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

export function createVideoAgentRuntime(options: VideoAgentRuntimeOptions = {}): VideoAgentRuntime {
  const rootDir = path.resolve(options.rootDir ?? process.cwd())
  let eventHandlers: VideoAgentRuntimeEvents = {
    onToolEvent: options.onToolEvent,
    onFileChange: options.onFileChange,
    onWorkflowChange: options.onWorkflowChange,
  }
  let cachedCreativePrompt: string | null = options.creativePrompt ?? null

  const emitToolEvent = (message: string) => {
    eventHandlers.onToolEvent?.(message)
  }

  const emitFileChange = (fileName: string) => {
    eventHandlers.onFileChange?.(fileName)
  }

  const emitWorkflowChange = (workflow: WorkflowSummary) => {
    eventHandlers.onWorkflowChange?.(workflow)
  }

  const getCreativePrompt = async () => {
    if (cachedCreativePrompt !== null) {
      return cachedCreativePrompt
    }

    cachedCreativePrompt = await readFile(
      resolveCreativePromptPath(rootDir, options.creativePromptPath),
      'utf8',
    )

    return cachedCreativePrompt
  }

  const ensureStatusBootstrapped = async () => {
    const statusPath = resolveWorkspacePath(rootDir, WORKFLOW_FILES.status)

    if (await workspacePathExists(WORKFLOW_FILES.status, rootDir)) {
      return false
    }

    await mkdir(path.dirname(statusPath), { recursive: true })
    await copyFile(resolveTemplatePath(rootDir, WORKFLOW_FILES.status), statusPath)

    return true
  }

  const ensureConfigBootstrapped = async () => {
    const workspacePath = resolveWorkspacePath(rootDir, WORKFLOW_FILES.config)
    const modelOptions = await loadModelOptions(rootDir)
    const defaultConfig = createDefaultConfigFromModelOptions(modelOptions)
    const normalizedDefaultContent = `${JSON.stringify(defaultConfig, null, 2)}\n`

    if (!(await workspacePathExists(WORKFLOW_FILES.config, rootDir))) {
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

  const validateWorkspaceFile = async (fileName: string) => {
    switch (fileName) {
      case 'CONFIG.json': {
        const [config, modelOptions] = await Promise.all([
          loadConfig(rootDir),
          loadModelOptions(rootDir),
        ])
        validateConfigAgainstModelOptions(config, modelOptions)
        return
      }
      case 'KEYFRAMES.json':
        await loadKeyframes(rootDir)
        return
      case 'VIDEO-PROMPTS.json':
        await loadVideoPrompts(rootDir)
        return
      case 'STATUS.json':
        await loadStatus(rootDir)
        return
      default:
        return
    }
  }

  const bootstrapWorkspaceFileFromTemplate = async (
    fileName: string,
  ): Promise<BootstrappedWorkspaceFile | null> => {
    assertWorkspaceFile(fileName)

    const workspacePath = resolveWorkspacePath(rootDir, fileName)
    if (await workspacePathExists(fileName, rootDir)) {
      return null
    }

    const templatePath = resolveTemplatePath(rootDir, fileName)
    const templateExists = await readFile(templatePath, 'utf8')
      .then(() => true)
      .catch(() => false)
    if (!templateExists) {
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

  const bootstrapMissingWorkspaceFiles = async (fileNames: string[]) => {
    const results = await Promise.all(
      [...new Set(fileNames)].map((fileName) => bootstrapWorkspaceFileFromTemplate(fileName)),
    )

    return results.filter((result): result is BootstrappedWorkspaceFile => result !== null)
  }

  const bootstrapMissingWorkspaceArtifacts = async (artifactNames: string[]) => {
    const uniqueArtifactNames = [...new Set(artifactNames)]
    const fileNames = uniqueArtifactNames.filter((artifactName) => !artifactName.endsWith('/'))
    const folderNames = uniqueArtifactNames.filter((artifactName) => artifactName.endsWith('/'))
    const bootstrappedFiles = await bootstrapMissingWorkspaceFiles(fileNames)
    const bootstrappedFolders = await Promise.all(
      folderNames.map(async (folderName) => {
        if (await workspacePathExists(folderName, rootDir)) {
          return null
        }

        const folderPath = resolveWorkspacePath(rootDir, folderName)
        await mkdir(folderPath, { recursive: true })

        return {
          fileName: folderName,
          workspacePath: folderPath,
        }
      }),
    )

    return [
      ...bootstrappedFiles,
      ...bootstrappedFolders.filter(
        (result): result is BootstrappedWorkspaceFile => result !== null,
      ),
    ]
  }

  const inspectWorkspaceArtifact = async (fileName: string): Promise<ArtifactReadiness> => {
    const workspacePath = resolveWorkspacePath(rootDir, fileName)

    if (fileName.endsWith('/')) {
      if (!(await workspacePathExists(fileName, rootDir))) {
        return 'missing'
      }

      const entries = await readdir(workspacePath)
      return entries.length === 0 ? 'incomplete' : 'ready'
    }

    if (!(await workspacePathExists(fileName, rootDir))) {
      return 'missing'
    }

    if (fileName.endsWith('.json')) {
      try {
        switch (fileName) {
          case 'CONFIG.json': {
            const [config, modelOptions] = await Promise.all([
              loadConfig(rootDir),
              loadModelOptions(rootDir),
            ])
            validateConfigAgainstModelOptions(config, modelOptions)
            return 'ready'
          }
          case 'KEYFRAMES.json': {
            const entries = await loadKeyframes(rootDir)
            if (entries.length === 0) {
              return 'incomplete'
            }

            return containsPlaceholderValue(entries) ? 'incomplete' : 'ready'
          }
          case 'VIDEO-PROMPTS.json': {
            await loadConfig(rootDir)
            const entries = await loadVideoPrompts(rootDir)
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

  const inspectCharacterSheetsPreparation = async (): Promise<ArtifactReadiness> => {
    if (!(await workspacePathExists(WORKFLOW_FOLDERS.characters, rootDir))) {
      return 'missing'
    }

    try {
      const entries = await loadCharacterSheets(rootDir)

      if (entries.length === 0) {
        return 'incomplete'
      }

      return containsPlaceholderValue(entries) ? 'incomplete' : 'ready'
    } catch {
      return 'incomplete'
    }
  }

  const inspectCharacterSheetsReview = async (): Promise<ArtifactReadiness> => {
    const preparationState = await inspectCharacterSheetsPreparation()

    if (preparationState === 'missing') {
      return 'missing'
    }

    try {
      const entries = await loadCharacterSheets(rootDir)
      const imageStates = await Promise.all(
        entries.map((entry) =>
          workspacePathExists(`${WORKFLOW_FOLDERS.characters}${entry.characterId}.png`, rootDir),
        ),
      )

      return imageStates.length > 0 && imageStates.every(Boolean) ? 'ready' : 'incomplete'
    } catch {
      return 'incomplete'
    }
  }

  const inspectKeyframesPreparation = async (): Promise<ArtifactReadiness> => {
    if (!(await workspacePathExists(WORKFLOW_FILES.keyframes, rootDir))) {
      return 'missing'
    }

    try {
      const [keyframes, artifacts] = await Promise.all([
        loadKeyframes(rootDir),
        loadKeyframeArtifacts(rootDir),
      ])

      if (keyframes.length === 0 || containsPlaceholderValue(keyframes)) {
        return 'incomplete'
      }

      const artifactById = new Map(artifacts.map((entry) => [entry.keyframeId, entry]))
      const allKeyframesPrepared = keyframes.every((entry) => {
        const artifact = artifactById.get(entry.keyframeId)

        return artifact !== undefined && !containsPlaceholderValue(artifact)
      })

      return allKeyframesPrepared ? 'ready' : 'incomplete'
    } catch {
      return 'incomplete'
    }
  }

  const inspectKeyframesReview = async (): Promise<ArtifactReadiness> => {
    const preparationState = await inspectKeyframesPreparation()

    if (preparationState === 'missing') {
      return 'missing'
    }

    try {
      const keyframes = await loadKeyframes(rootDir)
      const imageStates = await Promise.all(
        keyframes.map((entry) =>
          workspacePathExists(entry.imagePath.replace(/^workspace\//, ''), rootDir),
        ),
      )

      return imageStates.length > 0 && imageStates.every(Boolean) ? 'ready' : 'incomplete'
    } catch {
      return 'incomplete'
    }
  }

  const inspectMilestoneArtifacts = async (
    item: StatusData[number],
  ): Promise<ArtifactReadiness> => {
    const normalizedTitle = item.title.trim().toLowerCase()

    if (normalizedTitle === 'prepare character sheets') {
      return inspectCharacterSheetsPreparation()
    }

    if (normalizedTitle === 'review character sheets') {
      return inspectCharacterSheetsReview()
    }

    if (normalizedTitle === 'prepare keyframes') {
      return inspectKeyframesPreparation()
    }

    if (normalizedTitle === 'review keyframes') {
      return inspectKeyframesReview()
    }

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

  const reconcileStatus = async (status: StatusData) => {
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
      const statusPath = resolveWorkspacePath(rootDir, WORKFLOW_FILES.status)
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

  const loadWorkflowSummaryInternal = async (): Promise<WorkflowSummary> => {
    const ideaExists = await workspacePathExists('IDEA.md', rootDir)
    const configBootstrapped = await ensureConfigBootstrapped()
    const [config, modelOptions] = await Promise.all([
      loadConfig(rootDir),
      loadModelOptions(rootDir),
    ])
    validateConfigAgainstModelOptions(config, modelOptions)
    const statusBootstrapped = await ensureStatusBootstrapped()
    const statusData = await loadStatus(rootDir)
    const { status, checkedItems } = await reconcileStatus(statusData)
    const nextMilestone = getNextIncompleteMilestone(status)
    const totalItems = status.length
    const scopedFiles = await Promise.all(
      (nextMilestone?.relatedFiles ?? []).map(async (fileName) => ({
        fileName,
        exists: await workspacePathExists(fileName, rootDir),
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

  const applyWorkspaceFileWriteRules = async (fileName: string, content: string) => {
    if (fileName !== WORKFLOW_FILES.videoPrompts) {
      return content
    }

    const config = await loadConfig(rootDir)
    const parsed = JSON.parse(content)

    if (!Array.isArray(parsed)) {
      return content
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

  const validateWorkspaceArtifact = async (artifactPath: string, content: string) => {
    const normalizedPath = path.posix.normalize(artifactPath.replace(/\\/g, '/'))
    const parsed = JSON.parse(content)

    if (normalizedPath.startsWith(WORKFLOW_FOLDERS.characters)) {
      parseCharacterSheetEntry(parsed, normalizedPath)
      return
    }

    if (normalizedPath.startsWith(WORKFLOW_FOLDERS.keyframes)) {
      parseKeyframeArtifactEntry(parsed, normalizedPath)
    }
  }

  const applyWorkspaceArtifactWriteRules = async (artifactPath: string, content: string) => {
    const config = await loadConfig(rootDir)
    const normalizedPath = path.posix.normalize(artifactPath.replace(/\\/g, '/'))
    const parsed = JSON.parse(content)

    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return content
    }

    if (
      normalizedPath.startsWith(WORKFLOW_FOLDERS.characters) ||
      normalizedPath.startsWith(WORKFLOW_FOLDERS.keyframes)
    ) {
      return JSON.stringify(
        {
          ...parsed,
          model: config.imageModel,
        },
        null,
        2,
      )
    }

    return content
  }

  const bootstrapNextMilestoneScaffoldInternal = async (workflow: WorkflowSummary) => {
    if (!workflow.nextMilestone) {
      return []
    }

    return bootstrapMissingWorkspaceArtifacts(workflow.nextMilestone.relatedFiles)
  }

  const readWorkspaceFileInternal = async (fileName: string): Promise<WorkspaceFileReadResult> => {
    assertWorkspaceFile(fileName)

    const workspacePath = resolveWorkspacePath(rootDir, fileName)
    const templatePath = resolveTemplatePath(rootDir, fileName)
    const exists = await workspacePathExists(fileName, rootDir)

    if (exists) {
      return {
        fileName,
        exists: true,
        workspacePath,
        templatePath: (await readFile(templatePath, 'utf8')
          .then(() => true)
          .catch(() => false))
          ? templatePath
          : null,
        content: await readFile(workspacePath, 'utf8'),
      }
    }

    const templateExists = await readFile(templatePath, 'utf8')
      .then(() => true)
      .catch(() => false)

    return {
      fileName,
      exists: false,
      workspacePath,
      templatePath: templateExists ? templatePath : null,
      templateContent: templateExists ? await readFile(templatePath, 'utf8') : null,
      content: null,
    }
  }

  const readWorkspaceArtifactInternal = async (
    artifactPath: string,
  ): Promise<WorkspaceArtifactReadResult> => {
    assertWorkspaceArtifactPath(artifactPath)

    const normalizedPath = path.posix.normalize(artifactPath.replace(/\\/g, '/'))
    const workspacePath = resolveWorkspacePath(rootDir, normalizedPath)
    const exists = await workspacePathExists(normalizedPath, rootDir)

    if (normalizedPath.endsWith('/')) {
      return {
        artifactPath: normalizedPath,
        exists,
        workspacePath,
        content: null,
        entries: exists ? (await readdir(workspacePath)).sort() : [],
      }
    }

    return {
      artifactPath: normalizedPath,
      exists,
      workspacePath,
      content: exists ? await readFile(workspacePath, 'utf8') : null,
    }
  }

  const writeWorkspaceFileInternal = async (
    fileName: string,
    content: string,
    options: {
      emitToolEvents?: boolean
    } = {},
  ): Promise<WorkspaceWriteResult> => {
    assertWorkspaceFile(fileName)

    const workspacePath = resolveWorkspacePath(rootDir, fileName)
    const templatePath = resolveTemplatePath(rootDir, fileName)
    const targetAlreadyExists = await workspacePathExists(fileName, rootDir)
    const templateExists = await readFile(templatePath, 'utf8')
      .then(() => true)
      .catch(() => false)
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

    const workflow = await loadWorkflowSummaryInternal()
    const bootstrappedFiles = await bootstrapNextMilestoneScaffoldInternal(workflow)

    if (options.emitToolEvents) {
      emitToolEvent(
        `Updated ${fileName} (+${lineChanges.added} -${lineChanges.removed})${bootstrappedFromTemplate ? ' (bootstrapped from template)' : ''}`,
      )
    }
    emitFileChange(fileName)

    if (bootstrappedFiles.length > 0) {
      if (options.emitToolEvents) {
        emitToolEvent(
          `Prepared next milestone files: ${bootstrappedFiles.map(({ fileName }) => fileName).join(', ')}`,
        )
      }

      for (const bootstrappedFile of bootstrappedFiles) {
        emitFileChange(bootstrappedFile.fileName)
      }
    }

    const nextWorkflow =
      bootstrappedFiles.length > 0 ? await loadWorkflowSummaryInternal() : workflow
    emitWorkflowChange(nextWorkflow)

    return {
      fileName,
      bootstrappedFromTemplate,
      bytesWritten: normalizedContent.length,
      lineChanges,
      workspacePath,
      bootstrappedFiles,
      workflow: nextWorkflow,
    }
  }

  const writeWorkspaceArtifactInternal = async (
    artifactPath: string,
    content: string,
    options: {
      emitToolEvents?: boolean
    } = {},
  ): Promise<WorkspaceArtifactReadResult> => {
    assertWorkspaceArtifactPath(artifactPath)

    const normalizedPath = path.posix.normalize(artifactPath.replace(/\\/g, '/'))
    const workspacePath = resolveWorkspacePath(rootDir, normalizedPath)
    const previousContent = await readFile(workspacePath, 'utf8').catch(() => null)
    const nextContent = await applyWorkspaceArtifactWriteRules(normalizedPath, content)
    const normalizedContent = normalizeFileContent(normalizedPath, nextContent)

    await mkdir(path.dirname(workspacePath), { recursive: true })
    await writeFile(workspacePath, normalizedContent, 'utf8')

    try {
      await validateWorkspaceArtifact(normalizedPath, normalizedContent)
    } catch (error) {
      if (previousContent === null) {
        await rm(workspacePath, { force: true })
      } else {
        await writeFile(workspacePath, previousContent, 'utf8')
      }

      throw error
    }

    if (options.emitToolEvents) {
      emitToolEvent(`Updated ${normalizedPath}`)
    }
    emitFileChange(normalizedPath)
    emitWorkflowChange(await loadWorkflowSummaryInternal())

    return {
      artifactPath: normalizedPath,
      exists: true,
      workspacePath,
      content: normalizedContent,
    }
  }

  const ensureWorkspaceFolderInternal = async (
    folderName: string,
    options: {
      emitToolEvents?: boolean
    } = {},
  ): Promise<WorkspaceFolderResult> => {
    assertWorkspaceFolder(folderName)

    const folderPath = resolveWorkspacePath(rootDir, folderName)
    const existed = await workspacePathExists(folderName, rootDir)

    await mkdir(folderPath, { recursive: true })

    const result = {
      folderName,
      existed,
      folderPath,
      entries: (await readdir(folderPath)).sort(),
    }

    if (options.emitToolEvents) {
      emitToolEvent(`${result.existed ? 'Confirmed' : 'Created'} ${folderName}`)
    }
    emitFileChange(folderName)
    emitWorkflowChange(await loadWorkflowSummaryInternal())

    return result
  }

  const resetWorkflowFromMilestoneInternal = async (
    startIndex: number,
  ): Promise<WorkflowResetResult> => {
    const status = await loadStatus(rootDir)

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
        const workspacePath = resolveWorkspacePath(rootDir, fileName)

        if (!(await workspacePathExists(fileName, rootDir))) {
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
      resolveWorkspacePath(rootDir, WORKFLOW_FILES.status),
      `${JSON.stringify(nextStatus, null, 2)}\n`,
    )

    for (const removedFile of removedFiles) {
      emitFileChange(removedFile)
    }
    emitFileChange(WORKFLOW_FILES.status)
    emitWorkflowChange(await loadWorkflowSummaryInternal())

    return {
      removedFiles: removedFiles.sort(),
    }
  }

  const createDefaultAgent = async (agentModel: string): Promise<VideoAgentRunner> => {
    const instructions = await getCreativePrompt()

    return new ToolLoopAgent({
      model: agentModel,
      instructions,
      stopWhen: stepCountIs(20),
      tools: {
        getCreativeContext: tool({
          description:
            'Read the current creative project context, including milestone readiness and the next milestone that needs creative work.',
          inputSchema: z.object({}),
          execute: async () => {
            const workflow = await loadWorkflowSummaryInternal()
            emitWorkflowChange(workflow)

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
                'Canonical workspace filename such as IDEA.md, CONFIG.json, STATUS.json, STORY.md, KEYFRAMES.json, or VIDEO-PROMPTS.json',
              ),
          }),
          execute: async ({ fileName }) => {
            const result = await readWorkspaceFileInternal(fileName)
            emitToolEvent(`Read ${fileName}`)

            return result
          },
        }),
        readWorkspaceArtifact: tool({
          description:
            'Read one JSON sidecar artifact or list one canonical workspace folder such as CHARACTERS/ or KEYFRAMES/. Character sidecars use { characterId, displayName, model, prompt, status }. Keyframe sidecars use { keyframeId, shotId, frameType, model, prompt, status }.',
          inputSchema: z.object({
            artifactPath: z
              .string()
              .describe(
                'Folder path like CHARACTERS/ or JSON sidecar path like CHARACTERS/the-dog.json or KEYFRAMES/SHOT-01/SHOT-01-START.json',
              ),
          }),
          execute: async ({ artifactPath }) => {
            const result = await readWorkspaceArtifactInternal(artifactPath)
            emitToolEvent(`Read ${artifactPath}`)

            return result
          },
        }),
        readPromptingGuide: tool({
          description:
            'Read MODEL_PROMPTING_GUIDE.md so prompt-writing work matches the configured model guidance.',
          inputSchema: z.object({}),
          execute: async () => {
            const content = await readFile(
              resolvePromptingGuidePath(rootDir, options.promptingGuidePath),
              'utf8',
            )
            emitToolEvent('Read MODEL_PROMPTING_GUIDE.md')

            return {
              path: resolvePromptingGuidePath(rootDir, options.promptingGuidePath),
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
          execute: async ({ fileName, content }) =>
            writeWorkspaceFileInternal(fileName, content, { emitToolEvents: true }),
        }),
        writeWorkspaceArtifact: tool({
          description:
            'Write one JSON sidecar artifact in CHARACTERS/ or KEYFRAMES/ while keeping model fields aligned to workspace/CONFIG.json.imageModel. CHARACTERS/<id>.json must contain exactly characterId, displayName, model, prompt, status, and its prompt should target a clean single-subject reference image for downstream video consistency rather than a stylized hero scene. KEYFRAMES/<shot-id>/<keyframe-id>.json must contain exactly keyframeId, shotId, frameType, model, prompt, status.',
          inputSchema: z.object({
            artifactPath: z
              .string()
              .describe(
                'JSON sidecar path like CHARACTERS/the-dog.json or KEYFRAMES/SHOT-01/SHOT-01-START.json',
              ),
            content: z.string().describe('The complete new JSON file contents.'),
          }),
          execute: async ({ artifactPath, content }) =>
            writeWorkspaceArtifactInternal(artifactPath, content, { emitToolEvents: true }),
        }),
        createWorkspaceFolder: tool({
          description:
            'Create or confirm one canonical workspace folder such as CHARACTERS/ or KEYFRAMES/ when the creative workflow needs it.',
          inputSchema: z.object({
            folderName: z.string().describe('Canonical workspace folder name such as CHARACTERS/'),
          }),
          execute: async ({ folderName }) =>
            ensureWorkspaceFolderInternal(folderName, { emitToolEvents: true }),
        }),
      },
    })
  }

  const getAgent = async (agentModel: string): Promise<VideoAgentRunner> => {
    if (options.createAgent) {
      return options.createAgent({
        instructions: await getCreativePrompt(),
        model: agentModel,
      })
    }

    return createDefaultAgent(agentModel)
  }

  return {
    setEventHandlers(nextEvents) {
      eventHandlers = {
        onToolEvent: nextEvents.onToolEvent,
        onFileChange: nextEvents.onFileChange,
        onWorkflowChange: nextEvents.onWorkflowChange,
      }
    },
    async loadWorkflowSummary() {
      const workflow = await loadWorkflowSummaryInternal()
      emitWorkflowChange(workflow)
      return workflow
    },
    async bootstrapNextMilestoneScaffold(workflow) {
      const bootstrappedFiles = await bootstrapNextMilestoneScaffoldInternal(workflow)

      if (bootstrappedFiles.length > 0) {
        for (const bootstrappedFile of bootstrappedFiles) {
          emitFileChange(bootstrappedFile.fileName)
        }

        emitWorkflowChange(await loadWorkflowSummaryInternal())
      }

      return bootstrappedFiles
    },
    readWorkspaceFile(fileName) {
      return readWorkspaceFileInternal(fileName)
    },
    writeWorkspaceFile(fileName, content) {
      return writeWorkspaceFileInternal(fileName, content)
    },
    readWorkspaceArtifact(artifactPath) {
      return readWorkspaceArtifactInternal(artifactPath)
    },
    writeWorkspaceArtifact(artifactPath, content) {
      return writeWorkspaceArtifactInternal(artifactPath, content)
    },
    ensureWorkspaceFolder(folderName) {
      return ensureWorkspaceFolderInternal(folderName)
    },
    resetWorkflowFromMilestone(startIndex) {
      return resetWorkflowFromMilestoneInternal(startIndex)
    },
    async runTurn({ userInput, transcript, onTextDelta }) {
      const trimmedInput = userInput.trim()

      if (trimmedInput.length === 0) {
        throw new Error('User input must not be empty.')
      }

      let initialWorkflow = await loadWorkflowSummaryInternal()
      emitWorkflowChange(initialWorkflow)

      const bootstrappedFiles = await bootstrapNextMilestoneScaffoldInternal(initialWorkflow)

      if (bootstrappedFiles.length > 0) {
        for (const bootstrappedFile of bootstrappedFiles) {
          emitFileChange(bootstrappedFile.fileName)
        }

        initialWorkflow = await loadWorkflowSummaryInternal()
        emitWorkflowChange(initialWorkflow)
      }

      const rawStatusContent = await readFile(
        resolveWorkspacePath(rootDir, WORKFLOW_FILES.status),
        'utf8',
      )
      const agent = await getAgent(initialWorkflow.config.agentModel)
      const result = await agent.stream({
        messages: [
          buildRuntimeDirective(initialWorkflow, rawStatusContent),
          ...buildAgentMessages(trimmedInput, transcript),
        ],
        experimental_onToolCallStart: ({ toolCall }) => {
          emitToolEvent(`Running ${toolCall.toolName}`)
        },
        experimental_onToolCallFinish: ({ toolCall, success }) => {
          emitToolEvent(`${success ? 'Completed' : 'Failed'} ${toolCall.toolName}`)
        },
      })

      let streamedText = ''

      for await (const delta of result.textStream) {
        streamedText += delta
        onTextDelta?.(delta)
      }

      const finalText = (await result.text).trim()
      const finalWorkflow = await loadWorkflowSummaryInternal()
      emitWorkflowChange(finalWorkflow)

      return {
        text: finalText.length > 0 ? finalText : streamedText || 'No response generated.',
        initialWorkflow,
        finalWorkflow,
        bootstrappedFiles,
      }
    },
  }
}
