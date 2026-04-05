import { access, readFile, readdir } from 'node:fs/promises'
import path from 'node:path'

export const FRAME_TYPES = ['start', 'end'] as const
export const END_FRAME_MODES = ['bridge'] as const
export const DEFAULT_VIDEO_DURATION_SECONDS = 4
export const DEFAULT_VARIANT_COUNT = 1
export const FINAL_CUT_VERSION = 1
export const FINAL_CUT_TRANSITION_TYPES = ['cut', 'fade'] as const
export const ARTIFACT_TYPES = ['storyboard', 'character', 'keyframe', 'shot'] as const
export const REFERENCE_SOURCES = ['user', 'system'] as const
export const CAMERA_VOCABULARY_CATEGORIES = [
  'shot_size',
  'camera_position',
  'camera_angle',
  'camera_movement',
] as const
export const AUTHORED_REFERENCE_KINDS = [
  'storyboard-template',
  'storyboard',
  'character-sheet',
  'previous-shot-end-frame',
  'start-frame',
  'user-reference',
] as const

export type FrameType = (typeof FRAME_TYPES)[number]
export type EndFrameMode = (typeof END_FRAME_MODES)[number]
export type FinalCutTransitionType = (typeof FINAL_CUT_TRANSITION_TYPES)[number]
export type ArtifactType = (typeof ARTIFACT_TYPES)[number]
export type ReferenceSource = (typeof REFERENCE_SOURCES)[number]
export type CameraVocabularyCategory = (typeof CAMERA_VOCABULARY_CATEGORIES)[number]
export type AuthoredReferenceKind = (typeof AUTHORED_REFERENCE_KINDS)[number]

type JsonObject = Record<string, unknown>

interface ArtifactReferenceDescriptor {
  path: string
  label?: string
  notes?: string
}

export interface ArtifactReferenceEntry extends ArtifactReferenceDescriptor {
  kind: AuthoredReferenceKind
}

export interface ResolvedArtifactReference extends ArtifactReferenceDescriptor {
  source: ReferenceSource
  kind: GenerationReferenceKind
}

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
  imagePath: string
  title?: string
  goal?: string
  status?: string
  characterIds?: string[]
}

export type KeyframesData = KeyframeEntry[]

export interface KeyframeArtifactEntry {
  keyframeId: string
  shotId: string
  frameType: FrameType
  camera?: KeyframeCameraSpec
  prompt: string
  status: string
  references?: ArtifactReferenceEntry[]
}

export type KeyframeArtifactsData = KeyframeArtifactEntry[]

export interface CharacterSheetEntry {
  characterId: string
  displayName: string
  prompt: string
  status: string
  references?: ArtifactReferenceEntry[]
}

export type CharacterSheetsData = CharacterSheetEntry[]

export interface ShotKeyframeEntry {
  keyframeId: string
  frameType: FrameType
  imagePath: string
}

export interface ShotEntry {
  shotId: string
  status: string
  videoPath: string
  endFrameMode?: EndFrameMode
  keyframes?: ShotKeyframeEntry[]
  keyframeIds: string[]
  durationSeconds: number
}

export type ShotsData = ShotEntry[]

export interface ShotArtifactEntry {
  shotId: string
  camera?: ShotCameraSpec
  prompt: string
  status: string
  references?: ArtifactReferenceEntry[]
}

export interface StoryboardSidecar {
  references?: ArtifactReferenceEntry[]
}

export type ShotArtifactsData = ShotArtifactEntry[]

export interface KeyframeCameraSpec {
  shotSize: string
  cameraPosition: string
  cameraAngle: string
}

export interface ShotCameraSpec extends KeyframeCameraSpec {
  cameraMovement: string
}

export interface CameraVocabularyCategoryEntry {
  id: CameraVocabularyCategory
  name: string
  description: string
}

export interface CameraVocabularyEntry {
  id: string
  category: CameraVocabularyCategory
  name: string
  description: string
  aliases?: string[]
  abbreviations?: string[]
  appliesToKeyframe: boolean
  appliesToShot: boolean
}

export interface CameraVocabularyData {
  version: number
  source: {
    title: string
    url: string
    accessedOn: string
  }
  categories: CameraVocabularyCategoryEntry[]
  entries: CameraVocabularyEntry[]
}

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
  variantCount: number
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
    seed?: number
  }
  outputDir: string
  outputPaths: string[]
  keyframeId: string | null
  shotId: string | null
  frameType: FrameType | null
  promptId: string | null
  artifactType?: ArtifactType | null
  artifactId?: string | null
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
  | 'selected-image'
  | 'user-reference'

export interface GenerationReferenceEntry {
  kind: GenerationReferenceKind
  path: string
}

export const WORKSPACE_DIR = 'workspace'
export const MODEL_OPTIONS_FILE = 'MODEL_OPTIONS.json'
export const CAMERA_VOCABULARY_FILE = 'CAMERA_VOCABULARY.json'
export const LEGACY_KEYFRAMES_FILE = 'KEYFRAMES.json'

export const WORKFLOW_FILES = {
  config: 'CONFIG.json',
  status: 'STATUS.json',
  storyboard: 'STORYBOARD.md',
  storyboardSidecar: 'STORYBOARD.json',
  storyboardImage: 'STORYBOARD.png',
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

export function getStoryboardSidecarPath() {
  return path.posix.join(WORKSPACE_DIR, WORKFLOW_FILES.storyboardSidecar)
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

export function normalizeRepoRelativePath(fileName: string, context = 'path') {
  const normalizedPath = path.posix.normalize(fileName.replace(/\\/g, '/'))

  if (normalizedPath.length === 0 || normalizedPath === '.') {
    throw new Error(`${context} must be a non-empty repo-relative path.`)
  }

  if (
    path.posix.isAbsolute(normalizedPath) ||
    normalizedPath === '..' ||
    normalizedPath.startsWith('../')
  ) {
    throw new Error(`${context} must stay repo-relative and must not escape the repository root.`)
  }

  return normalizedPath
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

function expectPositiveInteger(value: unknown, context: string): number {
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    !Number.isInteger(value) ||
    value < 1
  ) {
    throw new Error(`${context} must be a positive integer.`)
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

function parseOptionalString(value: unknown, context: string) {
  if (value === undefined) {
    return undefined
  }

  return expectString(value, context)
}

function parseOptionalStringArray(value: unknown, context: string) {
  if (value === undefined) {
    return undefined
  }

  return expectStringArray(value, context)
}

function expectCameraVocabularyCategory(value: unknown, context: string): CameraVocabularyCategory {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${context} must be one of: ${CAMERA_VOCABULARY_CATEGORIES.join(', ')}.`)
  }

  const category = value

  if (!CAMERA_VOCABULARY_CATEGORIES.includes(category as CameraVocabularyCategory)) {
    throw new Error(`${context} must be one of: ${CAMERA_VOCABULARY_CATEGORIES.join(', ')}.`)
  }

  return category as CameraVocabularyCategory
}

function expectAuthoredReferenceKind(value: unknown, context: string): AuthoredReferenceKind {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${context} must be one of: ${AUTHORED_REFERENCE_KINDS.join(', ')}.`)
  }

  const kind = value

  if (!AUTHORED_REFERENCE_KINDS.includes(kind as AuthoredReferenceKind)) {
    throw new Error(`${context} must be one of: ${AUTHORED_REFERENCE_KINDS.join(', ')}.`)
  }

  return kind as AuthoredReferenceKind
}

function parseArtifactReferenceEntry(value: unknown, context: string): ArtifactReferenceEntry {
  const object = expectObject(value, context)

  return {
    path: normalizeRepoRelativePath(
      expectString(object.path, `${context}.path`),
      `${context}.path`,
    ),
    kind: expectAuthoredReferenceKind(object.kind, `${context}.kind`),
    label: parseOptionalString(object.label, `${context}.label`),
    notes: parseOptionalString(object.notes, `${context}.notes`),
  }
}

function parseArtifactReferenceEntries(value: unknown, context: string) {
  return expectArray(value, context).map((entry, index) =>
    parseArtifactReferenceEntry(entry, `${context}[${index}]`),
  )
}

function parseKeyframeCameraSpec(value: unknown, context: string): KeyframeCameraSpec {
  const object = expectObject(value, context)

  return {
    shotSize: expectString(object.shotSize, `${context}.shotSize`),
    cameraPosition: expectString(object.cameraPosition, `${context}.cameraPosition`),
    cameraAngle: expectString(object.cameraAngle, `${context}.cameraAngle`),
  }
}

function parseShotCameraSpec(value: unknown, context: string): ShotCameraSpec {
  const object = expectObject(value, context)

  return {
    ...parseKeyframeCameraSpec(value, context),
    cameraMovement: expectString(object.cameraMovement, `${context}.cameraMovement`),
  }
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

function parseOptionalEndFrameMode(value: unknown, context: string): EndFrameMode | undefined {
  if (value === undefined) {
    return undefined
  }

  const endFrameMode = expectString(value, context)

  if (!END_FRAME_MODES.includes(endFrameMode as EndFrameMode)) {
    throw new Error(`${context} must be one of: ${END_FRAME_MODES.join(', ')}.`)
  }

  return endFrameMode as EndFrameMode
}

function expectFinalCutTransitionType(value: unknown, context: string): FinalCutTransitionType {
  const transitionType = expectString(value, context)

  if (!FINAL_CUT_TRANSITION_TYPES.includes(transitionType as FinalCutTransitionType)) {
    throw new Error(`${context} must be one of: ${FINAL_CUT_TRANSITION_TYPES.join(', ')}.`)
  }

  return transitionType as FinalCutTransitionType
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

function parseShotKeyframeEntry(
  value: unknown,
  shotId: string,
  context: string,
): ShotKeyframeEntry {
  const object = expectObject(value, context)
  const keyframeId = expectString(object.keyframeId, `${context}.keyframeId`)
  const imagePath = expectString(object.imagePath, `${context}.imagePath`)
  const expectedImagePath = getKeyframeImagePath({ keyframeId, shotId })

  if (imagePath !== expectedImagePath) {
    throw new Error(`${context}.imagePath must be "${expectedImagePath}".`)
  }

  return {
    keyframeId,
    frameType: expectFrameType(object.frameType, `${context}.frameType`),
    imagePath,
  }
}

function flattenShotKeyframes(shots: ShotsData): KeyframesData {
  return shots.flatMap((shot) =>
    (shot.keyframes ?? []).map((keyframe) => ({
      keyframeId: keyframe.keyframeId,
      shotId: shot.shotId,
      frameType: keyframe.frameType,
      imagePath: keyframe.imagePath,
    })),
  )
}

export function parseKeyframeArtifactEntry(value: unknown, context: string): KeyframeArtifactEntry {
  const object = expectObject(value, context)

  return {
    keyframeId: expectString(object.keyframeId, `${context}.keyframeId`),
    shotId: expectString(object.shotId, `${context}.shotId`),
    frameType: expectFrameType(object.frameType, `${context}.frameType`),
    camera:
      object.camera === undefined
        ? undefined
        : parseKeyframeCameraSpec(object.camera, `${context}.camera`),
    prompt: expectString(object.prompt, `${context}.prompt`),
    status: expectString(object.status, `${context}.status`),
    references:
      object.references === undefined
        ? undefined
        : parseArtifactReferenceEntries(object.references, `${context}.references`),
  }
}

export function parseCharacterSheetEntry(value: unknown, context: string): CharacterSheetEntry {
  const object = expectObject(value, context)

  return {
    characterId: expectString(object.characterId, `${context}.characterId`),
    displayName: expectString(object.displayName, `${context}.displayName`),
    prompt: expectString(object.prompt, `${context}.prompt`),
    status: expectString(object.status, `${context}.status`),
    references:
      object.references === undefined
        ? undefined
        : parseArtifactReferenceEntries(object.references, `${context}.references`),
  }
}

export function parseStoryboardSidecar(value: unknown): StoryboardSidecar {
  const object = expectObject(value, WORKFLOW_FILES.storyboardSidecar)

  return {
    references:
      object.references === undefined
        ? undefined
        : parseArtifactReferenceEntries(
            object.references,
            `${WORKFLOW_FILES.storyboardSidecar}.references`,
          ),
  }
}

function parseShotEntry(value: unknown, context: string): ShotEntry {
  const object = expectObject(value, context)
  const shotId = expectString(object.shotId, `${context}.shotId`)
  const videoPath = expectString(object.videoPath, `${context}.videoPath`)
  const expectedVideoPath = getShotVideoPath({ shotId })
  const keyframes = expectArray(object.keyframes, `${context}.keyframes`).map((entry, index) =>
    parseShotKeyframeEntry(entry, shotId, `${context}.keyframes[${index}]`),
  )
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
    endFrameMode: parseOptionalEndFrameMode(object.endFrameMode, `${context}.endFrameMode`),
    keyframes,
    keyframeIds: keyframes.map((entry) => entry.keyframeId),
    durationSeconds,
  }
}

export function parseShotArtifactEntry(value: unknown, context: string): ShotArtifactEntry {
  const object = expectObject(value, context)

  return {
    shotId: expectString(object.shotId, `${context}.shotId`),
    camera:
      object.camera === undefined
        ? undefined
        : parseShotCameraSpec(object.camera, `${context}.camera`),
    prompt: expectString(object.prompt, `${context}.prompt`),
    status: expectString(object.status, `${context}.status`),
    references:
      object.references === undefined
        ? undefined
        : parseArtifactReferenceEntries(object.references, `${context}.references`),
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
  const variantCount =
    object.variantCount === undefined
      ? DEFAULT_VARIANT_COUNT
      : expectPositiveInteger(object.variantCount, 'CONFIG.json.variantCount')

  return {
    agentModel: expectConcreteString(object.agentModel, 'CONFIG.json.agentModel'),
    imageModel: expectConcreteString(object.imageModel, 'CONFIG.json.imageModel'),
    videoModel: expectConcreteString(object.videoModel, 'CONFIG.json.videoModel'),
    variantCount,
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

function parseCameraVocabularyData(value: unknown): CameraVocabularyData {
  const object = expectObject(value, CAMERA_VOCABULARY_FILE)
  const source = expectObject(object.source, `${CAMERA_VOCABULARY_FILE}.source`)

  return {
    version: expectPositiveInteger(object.version, `${CAMERA_VOCABULARY_FILE}.version`),
    source: {
      title: expectString(source.title, `${CAMERA_VOCABULARY_FILE}.source.title`),
      url: expectString(source.url, `${CAMERA_VOCABULARY_FILE}.source.url`),
      accessedOn: expectString(source.accessedOn, `${CAMERA_VOCABULARY_FILE}.source.accessedOn`),
    },
    categories: expectArray(object.categories, `${CAMERA_VOCABULARY_FILE}.categories`).map(
      (entry, index) => {
        const category = expectObject(entry, `${CAMERA_VOCABULARY_FILE}.categories[${index}]`)

        return {
          id: expectCameraVocabularyCategory(
            category.id,
            `${CAMERA_VOCABULARY_FILE}.categories[${index}].id`,
          ),
          name: expectString(category.name, `${CAMERA_VOCABULARY_FILE}.categories[${index}].name`),
          description: expectString(
            category.description,
            `${CAMERA_VOCABULARY_FILE}.categories[${index}].description`,
          ),
        }
      },
    ),
    entries: expectArray(object.entries, `${CAMERA_VOCABULARY_FILE}.entries`).map(
      (entry, index) => {
        const cameraEntry = expectObject(entry, `${CAMERA_VOCABULARY_FILE}.entries[${index}]`)

        return {
          id: expectString(cameraEntry.id, `${CAMERA_VOCABULARY_FILE}.entries[${index}].id`),
          category: expectCameraVocabularyCategory(
            cameraEntry.category,
            `${CAMERA_VOCABULARY_FILE}.entries[${index}].category`,
          ),
          name: expectString(cameraEntry.name, `${CAMERA_VOCABULARY_FILE}.entries[${index}].name`),
          description: expectString(
            cameraEntry.description,
            `${CAMERA_VOCABULARY_FILE}.entries[${index}].description`,
          ),
          aliases: parseOptionalStringArray(
            cameraEntry.aliases,
            `${CAMERA_VOCABULARY_FILE}.entries[${index}].aliases`,
          ),
          abbreviations: parseOptionalStringArray(
            cameraEntry.abbreviations,
            `${CAMERA_VOCABULARY_FILE}.entries[${index}].abbreviations`,
          ),
          appliesToKeyframe: expectBoolean(
            cameraEntry.appliesToKeyframe,
            `${CAMERA_VOCABULARY_FILE}.entries[${index}].appliesToKeyframe`,
          ),
          appliesToShot: expectBoolean(
            cameraEntry.appliesToShot,
            `${CAMERA_VOCABULARY_FILE}.entries[${index}].appliesToShot`,
          ),
        }
      },
    ),
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
      if (entry.name === 'HISTORY') {
        continue
      }

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

export async function loadCameraVocabulary(cwd = process.cwd()) {
  return readRepoJsonFile(CAMERA_VOCABULARY_FILE, parseCameraVocabularyData, cwd)
}

export async function loadKeyframes(cwd = process.cwd()) {
  const shots = await loadShotPrompts(cwd)

  return flattenShotKeyframes(shots)
}

export async function loadStoryboardSidecar(cwd = process.cwd()) {
  if (!(await workspacePathExists(WORKFLOW_FILES.storyboardSidecar, cwd))) {
    return null
  }

  return readJsonFile(WORKFLOW_FILES.storyboardSidecar, parseStoryboardSidecar, cwd)
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
  if (await workspacePathExists(LEGACY_KEYFRAMES_FILE, cwd)) {
    throw new Error(
      `Legacy ${LEGACY_KEYFRAMES_FILE} is no longer supported. Merge its entries into ${WORKFLOW_FILES.shotPrompts} and remove the old file.`,
    )
  }

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

  expectPositiveInteger(config.variantCount, 'CONFIG.json.variantCount')
}
