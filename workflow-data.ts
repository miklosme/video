import { readFile } from 'node:fs/promises'
import path from 'node:path'

export const PHASES = [
  'concept',
  'story',
  'storyboard',
  'keyframes',
  'prompts',
  'revision',
] as const
export const FRAME_TYPES = ['start', 'end', 'single'] as const
export const REFERENCE_STATUSES = ['planned', 'candidate', 'approved', 'rejected'] as const
export const QC_RESULTS = ['pass', 'fail', 'maybe'] as const

export type Phase = (typeof PHASES)[number]
export type FrameType = (typeof FRAME_TYPES)[number]
export type ReferenceStatus = (typeof REFERENCE_STATUSES)[number]
export type QcResult = (typeof QC_RESULTS)[number]

type JsonObject = Record<string, unknown>

export interface ModelSelection {
  displayName: string
  modelId: string
}

export interface ProjectData {
  version: number
  projectId: string
  concept: string
  targetVideoLengthSeconds: {
    min: number
    max: number
  }
  intendedAudience: string
  targetEmotionalEffect: string
  currentPhase: Phase
  targetModels: {
    keyframe: ModelSelection | null
    video: ModelSelection | null
    comparison: ModelSelection[]
  }
  workingAssumptions: string[]
}

export interface StoryboardShot {
  shotId: string
  durationSeconds: number
  framing: string
  cameraMotion: string
  subjectAction: string
  mood: string
  continuityDependencies: string[]
  intendedTransition: string
  firstFrameState: string
  lastFrameState: string
}

export interface StoryboardScene {
  sceneId: string
  title: string
  purpose: string
  emotionalBeat: string
  locationAndTime: string
  participants: string[]
  whatChanges: string
  transitionIn: string
  transitionOut: string
  shots: StoryboardShot[]
}

export interface StoryboardData {
  version: number
  sequenceOverview: {
    targetRuntimeSeconds: number
    sceneCount: number
    shotCount: number
    structure: string
    escalationRule: string
  }
  scenes: StoryboardScene[]
}

export interface ReferenceCollectionTarget {
  targetId: string
  title: string
  filePath: string | null
  assetType: string
  guides: string[]
  status: ReferenceStatus
  notes: string
}

export interface ReferenceAsset {
  assetId: string
  filePath: string
  assetType: string
  purpose: string[]
  status: ReferenceStatus
  influence: string
  notes: string
  source: string
  shotId?: string
  frameType?: FrameType
}

export interface ReferencesData {
  version: number
  collectionTargets: ReferenceCollectionTarget[]
  assets: ReferenceAsset[]
}

export interface KeyframeAnchor {
  anchorId: string
  name: string
  details: string[]
}

export interface KeyframePrompt {
  frameType: FrameType
  promptId: string
  prompt: string
  approvedAssetId: string | null
}

export interface KeyframeShot {
  shotId: string
  sceneId: string
  frameGoal: string
  frames: KeyframePrompt[]
}

export interface KeyframesData {
  version: number
  activeModel: ModelSelection
  workflowNotes: string[]
  anchors: KeyframeAnchor[]
  shots: KeyframeShot[]
}

export interface PromptPackShot {
  shotId: string
  status: string
  videoPromptId: string | null
  videoPrompt: string | null
  approvedKeyframeAssetIds: string[]
  notes: string
}

export interface PromptPackData {
  version: number
  status: string
  targetVideoModel: ModelSelection | null
  shots: PromptPackShot[]
}

export interface TodoItem {
  itemId: string
  text: string
  checked: boolean
  sourceFiles: string[]
}

export interface TodoSection {
  sectionId: string
  title: string
  items: TodoItem[]
}

export interface TodoData {
  version: number
  sections: TodoSection[]
}

export interface QcCategory {
  categoryId: string
  label: string
  description: string
}

export interface QcReviewFinding {
  categoryId: string
  result: QcResult
  notes: string
}

export interface QcReview {
  reviewId: string
  generationId: string
  shotId: string
  result: QcResult
  createdAt: string
  summary: string
  findings: QcReviewFinding[]
}

export interface QcData {
  version: number
  categories: QcCategory[]
  reviews: QcReview[]
}

export interface EditSelection {
  shotId: string
  order: number
  include: boolean
  approvedGenerationId: string | null
  notes: string
}

export interface EditData {
  version: number
  cutId: string
  status: string
  selections: EditSelection[]
  notes: string[]
}

export interface TestCase {
  testId: string
  title: string
  status: string
  shotIds: string[]
  goal: string
  acceptanceCriteria: string[]
}

export interface TestsData {
  version: number
  cases: TestCase[]
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
  shotId: string | null
  frameType: FrameType | null
  promptId: string | null
  logFile: string
  error: {
    name: string
    message: string
  } | null
}

export const WORKFLOW_FILES = {
  project: 'PROJECT.json',
  storyboard: 'STORYBOARD.json',
  references: 'REFERENCES.json',
  keyframes: 'KEYFRAMES.json',
  promptPack: 'PROMPT-PACK.json',
  status: 'STATUS.json',
  qc: 'QC.json',
  edit: 'EDIT.json',
  tests: 'TESTS.json',
  generationLog: 'GENERATION-LOG.jsonl',
} as const

const WORKSPACE_DIR = 'workspace'

function resolveWorkflowPath(fileName: string, cwd = process.cwd()) {
  return path.resolve(cwd, WORKSPACE_DIR, fileName)
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
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${context} must be a non-empty string.`)
  }

  return value
}

function expectNullableString(value: unknown, context: string): string | null {
  if (value === null) {
    return null
  }

  return expectString(value, context)
}

function expectNumber(value: unknown, context: string): number {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    throw new Error(`${context} must be a number.`)
  }

  return value
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

function expectEnum<T extends readonly string[]>(
  value: unknown,
  allowed: T,
  context: string,
): T[number] {
  const stringValue = expectString(value, context)

  if (!allowed.includes(stringValue)) {
    throw new Error(`${context} must be one of: ${allowed.join(', ')}.`)
  }

  return stringValue as T[number]
}

function expectVersion(value: unknown, context: string) {
  const version = expectNumber(value, context)

  if (version !== 1) {
    throw new Error(`${context} must be 1.`)
  }

  return version
}

function parseModelSelection(value: unknown, context: string): ModelSelection {
  const object = expectObject(value, context)

  return {
    displayName: expectString(object.displayName, `${context}.displayName`),
    modelId: expectString(object.modelId, `${context}.modelId`),
  }
}

function parseNullableModelSelection(value: unknown, context: string): ModelSelection | null {
  if (value === null) {
    return null
  }

  return parseModelSelection(value, context)
}

function parseProjectData(value: unknown): ProjectData {
  const object = expectObject(value, 'PROJECT.json')
  const targetVideoLengthSeconds = expectObject(
    object.targetVideoLengthSeconds,
    'PROJECT.json.targetVideoLengthSeconds',
  )
  const targetModels = expectObject(object.targetModels, 'PROJECT.json.targetModels')

  return {
    version: expectVersion(object.version, 'PROJECT.json.version'),
    projectId: expectString(object.projectId, 'PROJECT.json.projectId'),
    concept: expectString(object.concept, 'PROJECT.json.concept'),
    targetVideoLengthSeconds: {
      min: expectNumber(targetVideoLengthSeconds.min, 'PROJECT.json.targetVideoLengthSeconds.min'),
      max: expectNumber(targetVideoLengthSeconds.max, 'PROJECT.json.targetVideoLengthSeconds.max'),
    },
    intendedAudience: expectString(object.intendedAudience, 'PROJECT.json.intendedAudience'),
    targetEmotionalEffect: expectString(
      object.targetEmotionalEffect,
      'PROJECT.json.targetEmotionalEffect',
    ),
    currentPhase: expectEnum(object.currentPhase, PHASES, 'PROJECT.json.currentPhase'),
    targetModels: {
      keyframe: parseNullableModelSelection(
        targetModels.keyframe,
        'PROJECT.json.targetModels.keyframe',
      ),
      video: parseNullableModelSelection(targetModels.video, 'PROJECT.json.targetModels.video'),
      comparison: expectArray(targetModels.comparison, 'PROJECT.json.targetModels.comparison').map(
        (entry, index) =>
          parseModelSelection(entry, `PROJECT.json.targetModels.comparison[${index}]`),
      ),
    },
    workingAssumptions: expectStringArray(
      object.workingAssumptions,
      'PROJECT.json.workingAssumptions',
    ),
  }
}

function parseStoryboardShot(value: unknown, context: string): StoryboardShot {
  const object = expectObject(value, context)

  return {
    shotId: expectString(object.shotId, `${context}.shotId`),
    durationSeconds: expectNumber(object.durationSeconds, `${context}.durationSeconds`),
    framing: expectString(object.framing, `${context}.framing`),
    cameraMotion: expectString(object.cameraMotion, `${context}.cameraMotion`),
    subjectAction: expectString(object.subjectAction, `${context}.subjectAction`),
    mood: expectString(object.mood, `${context}.mood`),
    continuityDependencies: expectStringArray(
      object.continuityDependencies,
      `${context}.continuityDependencies`,
    ),
    intendedTransition: expectString(object.intendedTransition, `${context}.intendedTransition`),
    firstFrameState: expectString(object.firstFrameState, `${context}.firstFrameState`),
    lastFrameState: expectString(object.lastFrameState, `${context}.lastFrameState`),
  }
}

function parseStoryboardScene(value: unknown, context: string): StoryboardScene {
  const object = expectObject(value, context)

  return {
    sceneId: expectString(object.sceneId, `${context}.sceneId`),
    title: expectString(object.title, `${context}.title`),
    purpose: expectString(object.purpose, `${context}.purpose`),
    emotionalBeat: expectString(object.emotionalBeat, `${context}.emotionalBeat`),
    locationAndTime: expectString(object.locationAndTime, `${context}.locationAndTime`),
    participants: expectStringArray(object.participants, `${context}.participants`),
    whatChanges: expectString(object.whatChanges, `${context}.whatChanges`),
    transitionIn: expectString(object.transitionIn, `${context}.transitionIn`),
    transitionOut: expectString(object.transitionOut, `${context}.transitionOut`),
    shots: expectArray(object.shots, `${context}.shots`).map((entry, index) =>
      parseStoryboardShot(entry, `${context}.shots[${index}]`),
    ),
  }
}

function parseStoryboardData(value: unknown): StoryboardData {
  const object = expectObject(value, 'STORYBOARD.json')
  const sequenceOverview = expectObject(object.sequenceOverview, 'STORYBOARD.json.sequenceOverview')

  return {
    version: expectVersion(object.version, 'STORYBOARD.json.version'),
    sequenceOverview: {
      targetRuntimeSeconds: expectNumber(
        sequenceOverview.targetRuntimeSeconds,
        'STORYBOARD.json.sequenceOverview.targetRuntimeSeconds',
      ),
      sceneCount: expectNumber(
        sequenceOverview.sceneCount,
        'STORYBOARD.json.sequenceOverview.sceneCount',
      ),
      shotCount: expectNumber(
        sequenceOverview.shotCount,
        'STORYBOARD.json.sequenceOverview.shotCount',
      ),
      structure: expectString(
        sequenceOverview.structure,
        'STORYBOARD.json.sequenceOverview.structure',
      ),
      escalationRule: expectString(
        sequenceOverview.escalationRule,
        'STORYBOARD.json.sequenceOverview.escalationRule',
      ),
    },
    scenes: expectArray(object.scenes, 'STORYBOARD.json.scenes').map((entry, index) =>
      parseStoryboardScene(entry, `STORYBOARD.json.scenes[${index}]`),
    ),
  }
}

function parseReferenceCollectionTarget(
  value: unknown,
  context: string,
): ReferenceCollectionTarget {
  const object = expectObject(value, context)

  return {
    targetId: expectString(object.targetId, `${context}.targetId`),
    title: expectString(object.title, `${context}.title`),
    filePath: expectNullableString(object.filePath, `${context}.filePath`),
    assetType: expectString(object.assetType, `${context}.assetType`),
    guides: expectStringArray(object.guides, `${context}.guides`),
    status: expectEnum(object.status, REFERENCE_STATUSES, `${context}.status`),
    notes: expectString(object.notes, `${context}.notes`),
  }
}

function parseReferenceAsset(value: unknown, context: string): ReferenceAsset {
  const object = expectObject(value, context)

  return {
    assetId: expectString(object.assetId, `${context}.assetId`),
    filePath: expectString(object.filePath, `${context}.filePath`),
    assetType: expectString(object.assetType, `${context}.assetType`),
    purpose: expectStringArray(object.purpose, `${context}.purpose`),
    status: expectEnum(object.status, REFERENCE_STATUSES, `${context}.status`),
    influence: expectString(object.influence, `${context}.influence`),
    notes: expectString(object.notes, `${context}.notes`),
    source: expectString(object.source, `${context}.source`),
    shotId:
      object.shotId === undefined ? undefined : expectString(object.shotId, `${context}.shotId`),
    frameType:
      object.frameType === undefined
        ? undefined
        : expectEnum(object.frameType, FRAME_TYPES, `${context}.frameType`),
  }
}

function parseReferencesData(value: unknown): ReferencesData {
  const object = expectObject(value, 'REFERENCES.json')

  return {
    version: expectVersion(object.version, 'REFERENCES.json.version'),
    collectionTargets: expectArray(
      object.collectionTargets,
      'REFERENCES.json.collectionTargets',
    ).map((entry, index) =>
      parseReferenceCollectionTarget(entry, `REFERENCES.json.collectionTargets[${index}]`),
    ),
    assets: expectArray(object.assets, 'REFERENCES.json.assets').map((entry, index) =>
      parseReferenceAsset(entry, `REFERENCES.json.assets[${index}]`),
    ),
  }
}

function parseKeyframeAnchor(value: unknown, context: string): KeyframeAnchor {
  const object = expectObject(value, context)

  return {
    anchorId: expectString(object.anchorId, `${context}.anchorId`),
    name: expectString(object.name, `${context}.name`),
    details: expectStringArray(object.details, `${context}.details`),
  }
}

function parseKeyframePrompt(value: unknown, context: string): KeyframePrompt {
  const object = expectObject(value, context)

  return {
    frameType: expectEnum(object.frameType, FRAME_TYPES, `${context}.frameType`),
    promptId: expectString(object.promptId, `${context}.promptId`),
    prompt: expectString(object.prompt, `${context}.prompt`),
    approvedAssetId: expectNullableString(object.approvedAssetId, `${context}.approvedAssetId`),
  }
}

function parseKeyframeShot(value: unknown, context: string): KeyframeShot {
  const object = expectObject(value, context)

  return {
    shotId: expectString(object.shotId, `${context}.shotId`),
    sceneId: expectString(object.sceneId, `${context}.sceneId`),
    frameGoal: expectString(object.frameGoal, `${context}.frameGoal`),
    frames: expectArray(object.frames, `${context}.frames`).map((entry, index) =>
      parseKeyframePrompt(entry, `${context}.frames[${index}]`),
    ),
  }
}

function parseKeyframesData(value: unknown): KeyframesData {
  const object = expectObject(value, 'KEYFRAMES.json')

  return {
    version: expectVersion(object.version, 'KEYFRAMES.json.version'),
    activeModel: parseModelSelection(object.activeModel, 'KEYFRAMES.json.activeModel'),
    workflowNotes: expectStringArray(object.workflowNotes, 'KEYFRAMES.json.workflowNotes'),
    anchors: expectArray(object.anchors, 'KEYFRAMES.json.anchors').map((entry, index) =>
      parseKeyframeAnchor(entry, `KEYFRAMES.json.anchors[${index}]`),
    ),
    shots: expectArray(object.shots, 'KEYFRAMES.json.shots').map((entry, index) =>
      parseKeyframeShot(entry, `KEYFRAMES.json.shots[${index}]`),
    ),
  }
}

function parsePromptPackShot(value: unknown, context: string): PromptPackShot {
  const object = expectObject(value, context)

  return {
    shotId: expectString(object.shotId, `${context}.shotId`),
    status: expectString(object.status, `${context}.status`),
    videoPromptId: expectNullableString(object.videoPromptId, `${context}.videoPromptId`),
    videoPrompt: expectNullableString(object.videoPrompt, `${context}.videoPrompt`),
    approvedKeyframeAssetIds: expectStringArray(
      object.approvedKeyframeAssetIds,
      `${context}.approvedKeyframeAssetIds`,
    ),
    notes: expectString(object.notes, `${context}.notes`),
  }
}

function parsePromptPackData(value: unknown): PromptPackData {
  const object = expectObject(value, 'PROMPT-PACK.json')

  return {
    version: expectVersion(object.version, 'PROMPT-PACK.json.version'),
    status: expectString(object.status, 'PROMPT-PACK.json.status'),
    targetVideoModel: parseNullableModelSelection(
      object.targetVideoModel,
      'PROMPT-PACK.json.targetVideoModel',
    ),
    shots: expectArray(object.shots, 'PROMPT-PACK.json.shots').map((entry, index) =>
      parsePromptPackShot(entry, `PROMPT-PACK.json.shots[${index}]`),
    ),
  }
}

function parseTodoItem(value: unknown, context: string): TodoItem {
  const object = expectObject(value, context)

  return {
    itemId: expectString(object.itemId, `${context}.itemId`),
    text: expectString(object.text, `${context}.text`),
    checked: expectBoolean(object.checked, `${context}.checked`),
    sourceFiles: expectStringArray(object.sourceFiles, `${context}.sourceFiles`),
  }
}

function parseTodoSection(value: unknown, context: string): TodoSection {
  const object = expectObject(value, context)

  return {
    sectionId: expectString(object.sectionId, `${context}.sectionId`),
    title: expectString(object.title, `${context}.title`),
    items: expectArray(object.items, `${context}.items`).map((entry, index) =>
      parseTodoItem(entry, `${context}.items[${index}]`),
    ),
  }
}

function parseTodoData(value: unknown): TodoData {
  const object = expectObject(value, 'STATUS.json')

  return {
    version: expectVersion(object.version, 'STATUS.json.version'),
    sections: expectArray(object.sections, 'STATUS.json.sections').map((entry, index) =>
      parseTodoSection(entry, `STATUS.json.sections[${index}]`),
    ),
  }
}

function parseQcCategory(value: unknown, context: string): QcCategory {
  const object = expectObject(value, context)

  return {
    categoryId: expectString(object.categoryId, `${context}.categoryId`),
    label: expectString(object.label, `${context}.label`),
    description: expectString(object.description, `${context}.description`),
  }
}

function parseQcReviewFinding(value: unknown, context: string): QcReviewFinding {
  const object = expectObject(value, context)

  return {
    categoryId: expectString(object.categoryId, `${context}.categoryId`),
    result: expectEnum(object.result, QC_RESULTS, `${context}.result`),
    notes: expectString(object.notes, `${context}.notes`),
  }
}

function parseQcReview(value: unknown, context: string): QcReview {
  const object = expectObject(value, context)

  return {
    reviewId: expectString(object.reviewId, `${context}.reviewId`),
    generationId: expectString(object.generationId, `${context}.generationId`),
    shotId: expectString(object.shotId, `${context}.shotId`),
    result: expectEnum(object.result, QC_RESULTS, `${context}.result`),
    createdAt: expectString(object.createdAt, `${context}.createdAt`),
    summary: expectString(object.summary, `${context}.summary`),
    findings: expectArray(object.findings, `${context}.findings`).map((entry, index) =>
      parseQcReviewFinding(entry, `${context}.findings[${index}]`),
    ),
  }
}

function parseQcData(value: unknown): QcData {
  const object = expectObject(value, 'QC.json')

  return {
    version: expectVersion(object.version, 'QC.json.version'),
    categories: expectArray(object.categories, 'QC.json.categories').map((entry, index) =>
      parseQcCategory(entry, `QC.json.categories[${index}]`),
    ),
    reviews: expectArray(object.reviews, 'QC.json.reviews').map((entry, index) =>
      parseQcReview(entry, `QC.json.reviews[${index}]`),
    ),
  }
}

function parseEditSelection(value: unknown, context: string): EditSelection {
  const object = expectObject(value, context)

  return {
    shotId: expectString(object.shotId, `${context}.shotId`),
    order: expectNumber(object.order, `${context}.order`),
    include: expectBoolean(object.include, `${context}.include`),
    approvedGenerationId: expectNullableString(
      object.approvedGenerationId,
      `${context}.approvedGenerationId`,
    ),
    notes: expectString(object.notes, `${context}.notes`),
  }
}

function parseEditData(value: unknown): EditData {
  const object = expectObject(value, 'EDIT.json')

  return {
    version: expectVersion(object.version, 'EDIT.json.version'),
    cutId: expectString(object.cutId, 'EDIT.json.cutId'),
    status: expectString(object.status, 'EDIT.json.status'),
    selections: expectArray(object.selections, 'EDIT.json.selections').map((entry, index) =>
      parseEditSelection(entry, `EDIT.json.selections[${index}]`),
    ),
    notes: expectStringArray(object.notes, 'EDIT.json.notes'),
  }
}

function parseTestCase(value: unknown, context: string): TestCase {
  const object = expectObject(value, context)

  return {
    testId: expectString(object.testId, `${context}.testId`),
    title: expectString(object.title, `${context}.title`),
    status: expectString(object.status, `${context}.status`),
    shotIds: expectStringArray(object.shotIds, `${context}.shotIds`),
    goal: expectString(object.goal, `${context}.goal`),
    acceptanceCriteria: expectStringArray(
      object.acceptanceCriteria,
      `${context}.acceptanceCriteria`,
    ),
  }
}

function parseTestsData(value: unknown): TestsData {
  const object = expectObject(value, 'TESTS.json')

  return {
    version: expectVersion(object.version, 'TESTS.json.version'),
    cases: expectArray(object.cases, 'TESTS.json.cases').map((entry, index) =>
      parseTestCase(entry, `TESTS.json.cases[${index}]`),
    ),
  }
}

function parseGenerationLogEntry(value: unknown, context: string): GenerationLogEntry {
  const object = expectObject(value, context)
  const settings = expectObject(object.settings, `${context}.settings`)
  const error = object.error === null ? null : expectObject(object.error, `${context}.error`)

  return {
    generationId: expectString(object.generationId, `${context}.generationId`),
    startedAt: expectString(object.startedAt, `${context}.startedAt`),
    completedAt: expectNullableString(object.completedAt, `${context}.completedAt`),
    status: expectEnum(object.status, ['success', 'error'] as const, `${context}.status`),
    model: expectString(object.model, `${context}.model`),
    prompt: expectString(object.prompt, `${context}.prompt`),
    settings: {
      imageCount: expectNumber(settings.imageCount, `${context}.settings.imageCount`),
      aspectRatio: expectString(settings.aspectRatio, `${context}.settings.aspectRatio`),
      safetyFilterLevel: expectString(
        settings.safetyFilterLevel,
        `${context}.settings.safetyFilterLevel`,
      ),
    },
    outputDir: expectString(object.outputDir, `${context}.outputDir`),
    outputPaths: expectStringArray(object.outputPaths, `${context}.outputPaths`),
    shotId: expectNullableString(object.shotId, `${context}.shotId`),
    frameType:
      object.frameType === null
        ? null
        : expectEnum(object.frameType, FRAME_TYPES, `${context}.frameType`),
    promptId: expectNullableString(object.promptId, `${context}.promptId`),
    logFile: expectString(object.logFile, `${context}.logFile`),
    error:
      error === null
        ? null
        : {
            name: expectString(error.name, `${context}.error.name`),
            message: expectString(error.message, `${context}.error.message`),
          },
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

export async function loadProject(cwd = process.cwd()) {
  return readJsonFile(WORKFLOW_FILES.project, parseProjectData, cwd)
}

export async function loadStoryboard(cwd = process.cwd()) {
  return readJsonFile(WORKFLOW_FILES.storyboard, parseStoryboardData, cwd)
}

export async function loadReferences(cwd = process.cwd()) {
  return readJsonFile(WORKFLOW_FILES.references, parseReferencesData, cwd)
}

export async function loadKeyframes(cwd = process.cwd()) {
  return readJsonFile(WORKFLOW_FILES.keyframes, parseKeyframesData, cwd)
}

export async function loadPromptPack(cwd = process.cwd()) {
  return readJsonFile(WORKFLOW_FILES.promptPack, parsePromptPackData, cwd)
}

export async function loadStatus(cwd = process.cwd()) {
  return readJsonFile(WORKFLOW_FILES.status, parseTodoData, cwd)
}

export async function loadQc(cwd = process.cwd()) {
  return readJsonFile(WORKFLOW_FILES.qc, parseQcData, cwd)
}

export async function loadEdit(cwd = process.cwd()) {
  return readJsonFile(WORKFLOW_FILES.edit, parseEditData, cwd)
}

export async function loadTests(cwd = process.cwd()) {
  return readJsonFile(WORKFLOW_FILES.tests, parseTestsData, cwd)
}

export async function loadGenerationLog(cwd = process.cwd()) {
  const filePath = resolveWorkflowPath(WORKFLOW_FILES.generationLog, cwd)
  const raw = await readFile(filePath, 'utf8')
  const lines = raw
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)

  return lines.map((line, index) =>
    parseGenerationLogEntry(JSON.parse(line), `GENERATION-LOG.jsonl line ${index + 1}`),
  )
}

export async function loadWorkflowData(cwd = process.cwd()) {
  const [
    project,
    storyboard,
    references,
    keyframes,
    promptPack,
    status,
    qc,
    edit,
    tests,
    generationLog,
  ] = await Promise.all([
    loadProject(cwd),
    loadStoryboard(cwd),
    loadReferences(cwd),
    loadKeyframes(cwd),
    loadPromptPack(cwd),
    loadStatus(cwd),
    loadQc(cwd),
    loadEdit(cwd),
    loadTests(cwd),
    loadGenerationLog(cwd),
  ])

  return {
    project,
    storyboard,
    references,
    keyframes,
    promptPack,
    status,
    qc,
    edit,
    tests,
    generationLog,
  }
}

export function validateWorkflowConsistency(data: Awaited<ReturnType<typeof loadWorkflowData>>) {
  const storyboardShotIds = new Set<string>()
  const promptIds = new Set<string>()
  const actualShotCount = data.storyboard.scenes.reduce(
    (total, scene) => total + scene.shots.length,
    0,
  )

  if (data.storyboard.sequenceOverview.sceneCount !== data.storyboard.scenes.length) {
    throw new Error(
      `STORYBOARD.json sequenceOverview.sceneCount (${data.storyboard.sequenceOverview.sceneCount}) does not match actual scene count (${data.storyboard.scenes.length}).`,
    )
  }

  if (data.storyboard.sequenceOverview.shotCount !== actualShotCount) {
    throw new Error(
      `STORYBOARD.json sequenceOverview.shotCount (${data.storyboard.sequenceOverview.shotCount}) does not match actual shot count (${actualShotCount}).`,
    )
  }

  for (const scene of data.storyboard.scenes) {
    for (const shot of scene.shots) {
      if (storyboardShotIds.has(shot.shotId)) {
        throw new Error(`Duplicate shotId found in STORYBOARD.json: ${shot.shotId}.`)
      }

      storyboardShotIds.add(shot.shotId)
    }
  }

  for (const shot of data.keyframes.shots) {
    if (!storyboardShotIds.has(shot.shotId)) {
      throw new Error(`KEYFRAMES.json references unknown shotId ${shot.shotId}.`)
    }

    for (const frame of shot.frames) {
      if (promptIds.has(frame.promptId)) {
        throw new Error(`Duplicate promptId found in KEYFRAMES.json: ${frame.promptId}.`)
      }

      promptIds.add(frame.promptId)
    }
  }

  for (const shot of data.promptPack.shots) {
    if (!storyboardShotIds.has(shot.shotId)) {
      throw new Error(`PROMPT-PACK.json references unknown shotId ${shot.shotId}.`)
    }
  }

  for (const selection of data.edit.selections) {
    if (!storyboardShotIds.has(selection.shotId)) {
      throw new Error(`EDIT.json references unknown shotId ${selection.shotId}.`)
    }
  }

  for (const asset of data.references.assets) {
    if (asset.shotId && !storyboardShotIds.has(asset.shotId)) {
      throw new Error(
        `REFERENCES.json asset ${asset.assetId} references unknown shotId ${asset.shotId}.`,
      )
    }
  }

  for (const testCase of data.tests.cases) {
    for (const shotId of testCase.shotIds) {
      if (!storyboardShotIds.has(shotId)) {
        throw new Error(`TESTS.json case ${testCase.testId} references unknown shotId ${shotId}.`)
      }
    }
  }

  for (const review of data.qc.reviews) {
    if (!storyboardShotIds.has(review.shotId)) {
      throw new Error(
        `QC.json review ${review.reviewId} references unknown shotId ${review.shotId}.`,
      )
    }
  }
}
