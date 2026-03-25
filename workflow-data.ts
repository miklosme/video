import { access, readFile, readdir } from 'node:fs/promises'
import path from 'node:path'

export const FRAME_TYPES = ['start', 'end', 'single'] as const
export const DEFAULT_VIDEO_DURATION_SECONDS = 4
export const FINAL_CUT_VERSION = 1
export const FINAL_CUT_TRANSITION_TYPES = ['cut', 'fade'] as const
export const SHOT_INCOMING_TRANSITION_TYPES = ['opening', 'continuity', 'scene-change'] as const

export type FrameType = (typeof FRAME_TYPES)[number]
export type FinalCutTransitionType = (typeof FINAL_CUT_TRANSITION_TYPES)[number]
export type ShotIncomingTransitionType = (typeof SHOT_INCOMING_TRANSITION_TYPES)[number]

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
  characterIds: string[]
}

export type KeyframesData = KeyframeEntry[]

export interface KeyframeArtifactEntry {
  keyframeId: string
  shotId: string
  frameType: FrameType
  model: string
  prompt: string
  status: string
}

export type KeyframeArtifactsData = KeyframeArtifactEntry[]

export interface CharacterSheetEntry {
  characterId: string
  displayName: string
  model: string
  prompt: string
  status: string
}

export type CharacterSheetsData = CharacterSheetEntry[]

export interface ShotIncomingTransitionEntry {
  type: ShotIncomingTransitionType
  notes: string
}

export interface ShotEntry {
  shotId: string
  status: string
  videoPath: string
  keyframeIds: string[]
  durationSeconds: number
  incomingTransition: ShotIncomingTransitionEntry
}

export type ShotsData = ShotEntry[]

export interface ShotArtifactEntry {
  shotId: string
  model: string
  prompt: string
  status: string
}

export type ShotArtifactsData = ShotArtifactEntry[]

export interface FinalCutTransitionEntry {
  type: FinalCutTransitionType
  durationFrames: number
}

export interface FinalCutShotEntry {
  shotId: string
  enabled: boolean
  trimStartFrames: number
  trimEndFrames: number
  transition: FinalCutTransitionEntry
}

export interface FinalCutSoundtrackEntry {
  path: string
  volume: number
}

export interface FinalCutData {
  version: typeof FINAL_CUT_VERSION
  shots: FinalCutShotEntry[]
  soundtrack: FinalCutSoundtrackEntry | null
}

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
    imageCount?: number
    videoCount?: number
    size?: string
    aspectRatio?: string
    safetyFilterLevel?: string
    durationSeconds?: number
    referenceImageCount?: number
  }
  outputDir: string
  outputPaths: string[]
  keyframeId: string | null
  shotId: string | null
  frameType: FrameType | null
  promptId: string | null
  logFile: string
  references: GenerationReferenceEntry[]
  error: {
    name: string
    message: string
  } | null
}

export type GenerationReferenceKind =
  | 'character-sheet'
  | 'start-frame'
  | 'end-frame'
  | 'previous-shot-end-frame'
  | 'storyboard'
  | 'storyboard-template'

export interface GenerationReferenceEntry {
  kind: GenerationReferenceKind
  path: string
}

export const WORKSPACE_DIR = 'workspace'
export const MODEL_OPTIONS_FILE = 'MODEL_OPTIONS.json'

export const WORKFLOW_FILES = {
  config: 'CONFIG.json',
  status: 'STATUS.json',
  storyboard: 'STORYBOARD.md',
  storyboardImage: 'STORYBOARD.png',
  keyframes: 'KEYFRAMES.json',
  shotPrompts: 'SHOTS.json',
  finalCut: 'FINAL-CUT.json',
} as const

export const WORKFLOW_FOLDERS = {
  characters: 'CHARACTERS/',
  keyframes: 'KEYFRAMES/',
  shots: 'SHOTS/',
} as const

function folderStem(folderName: string) {
  return folderName.replace(/\/+$/, '')
}

export function getCharacterSheetJsonPath(characterId: string) {
  return path.posix.join(
    WORKSPACE_DIR,
    folderStem(WORKFLOW_FOLDERS.characters),
    `${characterId}.json`,
  )
}

export function getCharacterSheetImagePath(characterId: string) {
  return path.posix.join(
    WORKSPACE_DIR,
    folderStem(WORKFLOW_FOLDERS.characters),
    `${characterId}.png`,
  )
}

export function getStoryboardImagePath() {
  return path.posix.join(WORKSPACE_DIR, WORKFLOW_FILES.storyboardImage)
}

export function getKeyframeArtifactJsonPath(entry: Pick<KeyframeEntry, 'shotId' | 'keyframeId'>) {
  return path.posix.join(
    WORKSPACE_DIR,
    folderStem(WORKFLOW_FOLDERS.keyframes),
    entry.shotId,
    `${entry.keyframeId}.json`,
  )
}

export function getKeyframeImagePath(entry: Pick<KeyframeEntry, 'shotId' | 'keyframeId'>) {
  return path.posix.join(
    WORKSPACE_DIR,
    folderStem(WORKFLOW_FOLDERS.keyframes),
    entry.shotId,
    `${entry.keyframeId}.png`,
  )
}

export function getShotArtifactJsonPath(entry: Pick<ShotEntry, 'shotId'>) {
  return path.posix.join(WORKSPACE_DIR, folderStem(WORKFLOW_FOLDERS.shots), `${entry.shotId}.json`)
}

export function getShotVideoPath(entry: Pick<ShotEntry, 'shotId'>) {
  return path.posix.join(WORKSPACE_DIR, folderStem(WORKFLOW_FOLDERS.shots), `${entry.shotId}.mp4`)
}

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

function expectPositiveNumber(value: unknown, context: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new Error(`${context} must be a positive number.`)
  }

  return value
}

function expectNumberInRange(value: unknown, min: number, max: number, context: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    throw new Error(`${context} must be a number between ${min} and ${max}.`)
  }

  return value
}

function expectNonNegativeInteger(value: unknown, context: string): number {
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    !Number.isInteger(value) ||
    value < 0
  ) {
    throw new Error(`${context} must be a non-negative integer.`)
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

function expectFinalCutTransitionType(value: unknown, context: string): FinalCutTransitionType {
  const transitionType = expectString(value, context)

  if (!FINAL_CUT_TRANSITION_TYPES.includes(transitionType as FinalCutTransitionType)) {
    throw new Error(`${context} must be one of: ${FINAL_CUT_TRANSITION_TYPES.join(', ')}.`)
  }

  return transitionType as FinalCutTransitionType
}

function expectShotIncomingTransitionType(
  value: unknown,
  context: string,
): ShotIncomingTransitionType {
  const transitionType = expectString(value, context)

  if (!SHOT_INCOMING_TRANSITION_TYPES.includes(transitionType as ShotIncomingTransitionType)) {
    throw new Error(`${context} must be one of: ${SHOT_INCOMING_TRANSITION_TYPES.join(', ')}.`)
  }

  return transitionType as ShotIncomingTransitionType
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
  const keyframeId = expectString(object.keyframeId, `${context}.keyframeId`)
  const shotId = expectString(object.shotId, `${context}.shotId`)
  const imagePath = expectString(object.imagePath, `${context}.imagePath`)
  const expectedImagePath = getKeyframeImagePath({ keyframeId, shotId })

  if (imagePath !== expectedImagePath) {
    throw new Error(`${context}.imagePath must be "${expectedImagePath}".`)
  }

  return {
    keyframeId,
    shotId,
    frameType: expectFrameType(object.frameType, `${context}.frameType`),
    title: expectString(object.title, `${context}.title`),
    goal: expectString(object.goal, `${context}.goal`),
    status: expectString(object.status, `${context}.status`),
    imagePath,
    characterIds: expectStringArray(object.characterIds, `${context}.characterIds`),
  }
}

function parseKeyframesData(value: unknown): KeyframesData {
  return expectArray(value, 'KEYFRAMES.json').map((entry, index) =>
    parseKeyframeEntry(entry, `KEYFRAMES.json[${index}]`),
  )
}

export function parseKeyframeArtifactEntry(value: unknown, context: string): KeyframeArtifactEntry {
  const object = expectObject(value, context)

  return {
    keyframeId: expectString(object.keyframeId, `${context}.keyframeId`),
    shotId: expectString(object.shotId, `${context}.shotId`),
    frameType: expectFrameType(object.frameType, `${context}.frameType`),
    model: expectString(object.model, `${context}.model`),
    prompt: expectString(object.prompt, `${context}.prompt`),
    status: expectString(object.status, `${context}.status`),
  }
}

export function parseCharacterSheetEntry(value: unknown, context: string): CharacterSheetEntry {
  const object = expectObject(value, context)

  return {
    characterId: expectString(object.characterId, `${context}.characterId`),
    displayName: expectString(object.displayName, `${context}.displayName`),
    model: expectString(object.model, `${context}.model`),
    prompt: expectString(object.prompt, `${context}.prompt`),
    status: expectString(object.status, `${context}.status`),
  }
}

function parseShotIncomingTransitionEntry(
  value: unknown,
  context: string,
): ShotIncomingTransitionEntry {
  const object = expectObject(value, context)

  return {
    type: expectShotIncomingTransitionType(object.type, `${context}.type`),
    notes: expectString(object.notes, `${context}.notes`),
  }
}

function parseShotEntry(value: unknown, context: string): ShotEntry {
  const object = expectObject(value, context)
  const shotId = expectString(object.shotId, `${context}.shotId`)
  const videoPath = expectString(object.videoPath, `${context}.videoPath`)
  const expectedVideoPath = getShotVideoPath({ shotId })
  const durationSeconds =
    object.durationSeconds === undefined
      ? DEFAULT_VIDEO_DURATION_SECONDS
      : expectPositiveNumber(object.durationSeconds, `${context}.durationSeconds`)

  if (videoPath !== expectedVideoPath) {
    throw new Error(`${context}.videoPath must be "${expectedVideoPath}".`)
  }

  return {
    shotId,
    status: expectString(object.status, `${context}.status`),
    videoPath,
    keyframeIds: expectStringArray(object.keyframeIds, `${context}.keyframeIds`),
    durationSeconds,
    incomingTransition: parseShotIncomingTransitionEntry(
      object.incomingTransition,
      `${context}.incomingTransition`,
    ),
  }
}

export function parseShotArtifactEntry(value: unknown, context: string): ShotArtifactEntry {
  const object = expectObject(value, context)

  return {
    shotId: expectString(object.shotId, `${context}.shotId`),
    model: expectString(object.model, `${context}.model`),
    prompt: expectString(object.prompt, `${context}.prompt`),
    status: expectString(object.status, `${context}.status`),
  }
}

function parseShotsData(value: unknown): ShotsData {
  return expectArray(value, 'SHOTS.json').map((entry, index) =>
    parseShotEntry(entry, `SHOTS.json[${index}]`),
  )
}

function parseFinalCutTransitionEntry(value: unknown, context: string): FinalCutTransitionEntry {
  const object = expectObject(value, context)
  const type = expectFinalCutTransitionType(object.type, `${context}.type`)
  const durationFrames = expectNonNegativeInteger(
    object.durationFrames,
    `${context}.durationFrames`,
  )

  if (type === 'cut' && durationFrames !== 0) {
    throw new Error(`${context}.durationFrames must be 0 when transition.type is "cut".`)
  }

  if (type === 'fade' && durationFrames === 0) {
    throw new Error(`${context}.durationFrames must be greater than 0 for a fade transition.`)
  }

  return {
    type,
    durationFrames,
  }
}

function parseFinalCutShotEntry(value: unknown, context: string): FinalCutShotEntry {
  const object = expectObject(value, context)

  return {
    shotId: expectString(object.shotId, `${context}.shotId`),
    enabled: expectBoolean(object.enabled, `${context}.enabled`),
    trimStartFrames: expectNonNegativeInteger(object.trimStartFrames, `${context}.trimStartFrames`),
    trimEndFrames: expectNonNegativeInteger(object.trimEndFrames, `${context}.trimEndFrames`),
    transition: parseFinalCutTransitionEntry(object.transition, `${context}.transition`),
  }
}

function parseFinalCutSoundtrackEntry(
  value: unknown,
  context: string,
): FinalCutSoundtrackEntry | null {
  if (value === null) {
    return null
  }

  const object = expectObject(value, context)

  return {
    path: expectString(object.path, `${context}.path`),
    volume: expectNumberInRange(object.volume, 0, 1, `${context}.volume`),
  }
}

function parseFinalCutData(value: unknown): FinalCutData {
  const object = expectObject(value, 'FINAL-CUT.json')
  const version = expectNonNegativeInteger(object.version, 'FINAL-CUT.json.version')

  if (version !== FINAL_CUT_VERSION) {
    throw new Error(`FINAL-CUT.json.version must be ${FINAL_CUT_VERSION}.`)
  }

  return {
    version: FINAL_CUT_VERSION,
    shots: expectArray(object.shots, 'FINAL-CUT.json.shots').map((entry, index) =>
      parseFinalCutShotEntry(entry, `FINAL-CUT.json.shots[${index}]`),
    ),
    soundtrack: parseFinalCutSoundtrackEntry(object.soundtrack, 'FINAL-CUT.json.soundtrack'),
  }
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

async function listJsonFilesInDirectory(
  directoryPath: string,
  options: {
    recursive?: boolean
  } = {},
): Promise<string[]> {
  const { recursive = false } = options
  const entries = await readdir(directoryPath, { withFileTypes: true }).catch(() => [])
  const filePaths: string[] = []

  for (const entry of [...entries].sort((left, right) => left.name.localeCompare(right.name))) {
    const nextPath = path.join(directoryPath, entry.name)

    if (entry.isDirectory()) {
      if (recursive) {
        filePaths.push(...(await listJsonFilesInDirectory(nextPath, { recursive: true })))
      }
      continue
    }

    if (entry.isFile() && entry.name.endsWith('.json')) {
      filePaths.push(nextPath)
    }
  }

  return filePaths
}

async function loadJsonEntriesFromFolder<T>(
  folderName: string,
  parser: (value: unknown, context: string) => T,
  cwd = process.cwd(),
  options: {
    recursive?: boolean
  } = {},
) {
  const folderPath = resolveWorkflowPath(folderName, cwd)
  const filePaths = await listJsonFilesInDirectory(folderPath, options)
  const workspaceRoot = resolveWorkflowPath('', cwd)
  const entries = await Promise.all(
    filePaths.map(async (filePath) => {
      const raw = await readFile(filePath, 'utf8')
      const relativePath = path.relative(workspaceRoot, filePath).split(path.sep).join('/')
      return parser(JSON.parse(raw), relativePath)
    }),
  )

  return entries
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

export async function loadKeyframeArtifacts(cwd = process.cwd()) {
  const entries = await loadJsonEntriesFromFolder(
    WORKFLOW_FOLDERS.keyframes,
    parseKeyframeArtifactEntry,
    cwd,
    { recursive: true },
  )

  return entries.sort((left, right) => left.keyframeId.localeCompare(right.keyframeId))
}

export async function loadCharacterSheets(cwd = process.cwd()) {
  const entries = await loadJsonEntriesFromFolder(
    WORKFLOW_FOLDERS.characters,
    parseCharacterSheetEntry,
    cwd,
  )

  return entries.sort((left, right) => left.characterId.localeCompare(right.characterId))
}

export async function loadShotPrompts(cwd = process.cwd()) {
  return readJsonFile(WORKFLOW_FILES.shotPrompts, parseShotsData, cwd)
}

export async function loadFinalCut(cwd = process.cwd()) {
  return readJsonFile(WORKFLOW_FILES.finalCut, parseFinalCutData, cwd)
}

export async function loadShotArtifacts(cwd = process.cwd()) {
  const entries = await loadJsonEntriesFromFolder(
    WORKFLOW_FOLDERS.shots,
    parseShotArtifactEntry,
    cwd,
  )

  return entries.sort((left, right) => left.shotId.localeCompare(right.shotId))
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
