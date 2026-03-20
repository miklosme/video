import { access, readFile } from 'node:fs/promises'
import path from 'node:path'

export const FRAME_TYPES = ['start', 'end', 'single'] as const

export type FrameType = (typeof FRAME_TYPES)[number]

type JsonObject = Record<string, unknown>

export interface StatusItem {
  title: string
  instruction: string
  checked: boolean
  relatedFiles: string[]
}

export type StatusData = StatusItem[]

export interface KeyframeEntry {
  keyframeId: string
  shotId: string
  frameType: FrameType
  title: string
  goal: string
  status: string
  imagePath: string
}

export type KeyframesData = KeyframeEntry[]

export interface KeyframePromptEntry {
  promptId: string
  keyframeId: string
  shotId: string
  frameType: FrameType
  label: string
  model: string
  prompt: string
  status: string
  outputPath: string
}

export type KeyframePromptsData = KeyframePromptEntry[]

export interface VideoPromptEntry {
  promptId: string
  shotId: string
  model: string
  prompt: string
  status: string
  keyframePromptIds: string[]
}

export type VideoPromptsData = VideoPromptEntry[]

export interface ConfigData {
  agentModel: string
  imageModel: string
  videoModel: string
}

export interface ModelOptionsData {
  agentModels: string[]
  imageModels: string[]
  videoModels: string[]
}

export interface GenerationLogEntry {
  generationId: string
  startedAt: string
  completedAt: string | null
  status: 'success' | 'error'
  model: string
  prompt: string
  settings: {
    imageCount: number
    aspectRatio: string
    safetyFilterLevel: string
  }
  outputDir: string
  outputPaths: string[]
  keyframeId: string | null
  shotId: string | null
  frameType: FrameType | null
  promptId: string | null
  logFile: string
  error: {
    name: string
    message: string
  } | null
}

export const WORKSPACE_DIR = 'workspace'
export const MODEL_OPTIONS_FILE = 'MODEL_OPTIONS.json'

export const WORKFLOW_FILES = {
  config: 'CONFIG.json',
  status: 'STATUS.json',
  keyframes: 'KEYFRAMES.json',
  keyframePrompts: 'KEYFRAME-PROMPTS.json',
  videoPrompts: 'VIDEO-PROMPTS.json',
} as const

export function resolveWorkflowPath(fileName: string, cwd = process.cwd()) {
  return path.resolve(cwd, WORKSPACE_DIR, fileName)
}

export function resolveRepoPath(fileName: string, cwd = process.cwd()) {
  return path.resolve(cwd, fileName)
}

export async function workspacePathExists(fileName: string, cwd = process.cwd()) {
  try {
    await access(resolveWorkflowPath(fileName, cwd))
    return true
  } catch {
    return false
  }
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function expectObject(value: unknown, context: string): JsonObject {
  if (!isObject(value)) {
    throw new Error(`${context} must be an object.`)
  }

  return value
}

function expectString(value: unknown, context: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${context} must be a non-empty string.`)
  }

  return value
}

function expectConcreteString(value: unknown, context: string): string {
  const nextValue = expectString(value, context)

  if (nextValue.trim() === 'TBD') {
    throw new Error(`${context} must not be "TBD".`)
  }

  return nextValue
}

function expectBoolean(value: unknown, context: string): boolean {
  if (typeof value !== 'boolean') {
    throw new Error(`${context} must be a boolean.`)
  }

  return value
}

function expectArray(value: unknown, context: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`${context} must be an array.`)
  }

  return value
}

function expectStringArray(value: unknown, context: string): string[] {
  return expectArray(value, context).map((entry, index) =>
    expectString(entry, `${context}[${index}]`),
  )
}

function expectConcreteStringArray(value: unknown, context: string): string[] {
  const entries = expectArray(value, context).map((entry, index) =>
    expectConcreteString(entry, `${context}[${index}]`),
  )

  if (entries.length === 0) {
    throw new Error(`${context} must contain at least one model string.`)
  }

  return entries
}

function expectFrameType(value: unknown, context: string): FrameType {
  const frameType = expectString(value, context)

  if (!FRAME_TYPES.includes(frameType as FrameType)) {
    throw new Error(`${context} must be one of: ${FRAME_TYPES.join(', ')}.`)
  }

  return frameType as FrameType
}

function parseStatusItem(value: unknown, context: string): StatusItem {
  const object = expectObject(value, context)

  return {
    title: expectString(object.title, `${context}.title`),
    instruction: expectString(object.instruction, `${context}.instruction`),
    checked: expectBoolean(object.checked, `${context}.checked`),
    relatedFiles: expectStringArray(object.relatedFiles, `${context}.relatedFiles`),
  }
}

function parseStatusData(value: unknown): StatusData {
  return expectArray(value, 'STATUS.json').map((entry, index) =>
    parseStatusItem(entry, `STATUS.json[${index}]`),
  )
}

function parseKeyframeEntry(value: unknown, context: string): KeyframeEntry {
  const object = expectObject(value, context)

  return {
    keyframeId: expectString(object.keyframeId, `${context}.keyframeId`),
    shotId: expectString(object.shotId, `${context}.shotId`),
    frameType: expectFrameType(object.frameType, `${context}.frameType`),
    title: expectString(object.title, `${context}.title`),
    goal: expectString(object.goal, `${context}.goal`),
    status: expectString(object.status, `${context}.status`),
    imagePath: expectString(object.imagePath, `${context}.imagePath`),
  }
}

function parseKeyframesData(value: unknown): KeyframesData {
  return expectArray(value, 'KEYFRAMES.json').map((entry, index) =>
    parseKeyframeEntry(entry, `KEYFRAMES.json[${index}]`),
  )
}

function parseKeyframePromptEntry(value: unknown, context: string): KeyframePromptEntry {
  const object = expectObject(value, context)

  return {
    promptId: expectString(object.promptId, `${context}.promptId`),
    keyframeId: expectString(object.keyframeId, `${context}.keyframeId`),
    shotId: expectString(object.shotId, `${context}.shotId`),
    frameType: expectFrameType(object.frameType, `${context}.frameType`),
    label: expectString(object.label, `${context}.label`),
    model: expectString(object.model, `${context}.model`),
    prompt: expectString(object.prompt, `${context}.prompt`),
    status: expectString(object.status, `${context}.status`),
    outputPath: expectString(object.outputPath, `${context}.outputPath`),
  }
}

function parseKeyframePromptsData(value: unknown): KeyframePromptsData {
  return expectArray(value, 'KEYFRAME-PROMPTS.json').map((entry, index) =>
    parseKeyframePromptEntry(entry, `KEYFRAME-PROMPTS.json[${index}]`),
  )
}

function parseVideoPromptEntry(value: unknown, context: string): VideoPromptEntry {
  const object = expectObject(value, context)

  return {
    promptId: expectString(object.promptId, `${context}.promptId`),
    shotId: expectString(object.shotId, `${context}.shotId`),
    model: expectString(object.model, `${context}.model`),
    prompt: expectString(object.prompt, `${context}.prompt`),
    status: expectString(object.status, `${context}.status`),
    keyframePromptIds: expectStringArray(object.keyframePromptIds, `${context}.keyframePromptIds`),
  }
}

function parseVideoPromptsData(value: unknown): VideoPromptsData {
  return expectArray(value, 'VIDEO-PROMPTS.json').map((entry, index) =>
    parseVideoPromptEntry(entry, `VIDEO-PROMPTS.json[${index}]`),
  )
}

function parseConfigData(value: unknown): ConfigData {
  const object = expectObject(value, 'CONFIG.json')

  return {
    agentModel: expectConcreteString(object.agentModel, 'CONFIG.json.agentModel'),
    imageModel: expectConcreteString(object.imageModel, 'CONFIG.json.imageModel'),
    videoModel: expectConcreteString(object.videoModel, 'CONFIG.json.videoModel'),
  }
}

function parseModelOptionsData(value: unknown): ModelOptionsData {
  const object = expectObject(value, MODEL_OPTIONS_FILE)

  return {
    agentModels: expectConcreteStringArray(object.agentModels, `${MODEL_OPTIONS_FILE}.agentModels`),
    imageModels: expectConcreteStringArray(object.imageModels, `${MODEL_OPTIONS_FILE}.imageModels`),
    videoModels: expectConcreteStringArray(object.videoModels, `${MODEL_OPTIONS_FILE}.videoModels`),
  }
}

async function readJsonFile<T>(
  fileName: string,
  parser: (value: unknown) => T,
  cwd = process.cwd(),
): Promise<T> {
  const filePath = resolveWorkflowPath(fileName, cwd)
  const raw = await readFile(filePath, 'utf8')

  return parser(JSON.parse(raw))
}

async function readRepoJsonFile<T>(
  fileName: string,
  parser: (value: unknown) => T,
  cwd = process.cwd(),
): Promise<T> {
  const filePath = resolveRepoPath(fileName, cwd)
  const raw = await readFile(filePath, 'utf8')

  return parser(JSON.parse(raw))
}

export async function loadStatus(cwd = process.cwd()) {
  return readJsonFile(WORKFLOW_FILES.status, parseStatusData, cwd)
}

export async function loadConfig(cwd = process.cwd()) {
  return readJsonFile(WORKFLOW_FILES.config, parseConfigData, cwd)
}

export async function loadModelOptions(cwd = process.cwd()) {
  return readRepoJsonFile(MODEL_OPTIONS_FILE, parseModelOptionsData, cwd)
}

export async function loadKeyframes(cwd = process.cwd()) {
  return readJsonFile(WORKFLOW_FILES.keyframes, parseKeyframesData, cwd)
}

export async function loadKeyframePrompts(cwd = process.cwd()) {
  return readJsonFile(WORKFLOW_FILES.keyframePrompts, parseKeyframePromptsData, cwd)
}

export async function loadVideoPrompts(cwd = process.cwd()) {
  return readJsonFile(WORKFLOW_FILES.videoPrompts, parseVideoPromptsData, cwd)
}

export function validateConfigAgainstModelOptions(
  config: ConfigData,
  modelOptions: ModelOptionsData,
) {
  const checks: Array<[value: string, options: string[], context: string]> = [
    [config.agentModel, modelOptions.agentModels, 'CONFIG.json.agentModel'],
    [config.imageModel, modelOptions.imageModels, 'CONFIG.json.imageModel'],
    [config.videoModel, modelOptions.videoModels, 'CONFIG.json.videoModel'],
  ]

  for (const [value, options, context] of checks) {
    if (!options.includes(value)) {
      throw new Error(
        `${context} must match one of the configured values in ${MODEL_OPTIONS_FILE}.`,
      )
    }
  }
}
