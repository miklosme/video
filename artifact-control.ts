import { access, copyFile, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'

import {
  getCharacterSheetImagePath,
  getKeyframeImagePath,
  getShotVideoPath,
  getStoryboardImagePath,
  getStoryboardSidecarPath,
  normalizeRepoRelativePath,
  resolveRepoPath,
  type ArtifactReferenceEntry,
  type ArtifactType,
  type CharacterSheetEntry,
  type FrameType,
  type GenerationLogEntry,
  type GenerationReferenceEntry,
  type GenerationReferenceKind,
  type KeyframeEntry,
  type ResolvedArtifactReference,
  type ShotEntry,
  type ShotIncomingTransitionEntry,
} from './workflow-data'

const HISTORY_FOLDER_NAME = 'HISTORY'
const STORYBOARD_ARTIFACT_ID = 'STORYBOARD'

export interface ArtifactDescriptor {
  artifactType: ArtifactType
  artifactId: string
  displayName: string
  publicPath: string
  sidecarPath: string | null
  historyDir: string
  artifactControlPath: string
  mediaExtension: '.png' | '.mp4'
  shotId: string | null
}

export interface ArtifactHistoryVersionSummary {
  versionId: string
  path: string
  metadataPath: string
  createdAt: string
  baseVersionId: string | null
  generationId: string | null
  editInstruction: string | null
}

export interface ArtifactHistory {
  artifactId: string
  artifactType: ArtifactType
  publicPath: string
  latestVersionId: string | null
  selectedVersionId: string | null
  versions: ArtifactHistoryVersionSummary[]
}

export interface ArtifactVersionMetadata {
  versionId: string
  createdAt: string
  sourceArtifactId: string
  baseVersionId: string | null
  generationId: string | null
  seed: number | null
  autoSelected: boolean
  editInstruction: string | null
  approvedActionSummary: string | null
  references: ResolvedArtifactReference[]
}

export interface ArtifactHistoryState {
  descriptor: ArtifactDescriptor
  history: ArtifactHistory | null
  activeVersionId: string | null
  activeVersion: ArtifactVersionMetadata | null
  versions: ArtifactVersionMetadata[]
}

export interface StagedArtifactVersion {
  versionId: string
  stagedPath: string
}

export interface ResolvedShotGenerationAssets {
  inputImagePath: string
  lastFramePath: string | null
  characterIds: string[]
  referenceImagePaths: string[]
  references: GenerationReferenceEntry[]
  resolvedReferences: ResolvedArtifactReference[]
  droppedReferences: ResolvedArtifactReference[]
}

interface RecordArtifactVersionInput {
  descriptor: ArtifactDescriptor
  stagedPath: string
  createdAt?: string
  baseVersionId: string | null
  generationId: string | null
  seed: number | null
  editInstruction: string | null
  approvedActionSummary: string | null
  references: ResolvedArtifactReference[]
  autoSelect?: boolean
  cwd?: string
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function toArtifactKey(descriptor: ArtifactDescriptor) {
  return `${descriptor.artifactType}:${descriptor.artifactId}`
}

export function getArtifactKey(descriptor: ArtifactDescriptor) {
  return toArtifactKey(descriptor)
}

async function fileExists(filePath: string) {
  try {
    await access(filePath)
    return true
  } catch {
    return false
  }
}

function buildArtifactHistory(
  descriptor: ArtifactDescriptor,
  versions: ArtifactHistoryVersionSummary[] = [],
): ArtifactHistory {
  return {
    artifactId: descriptor.artifactId,
    artifactType: descriptor.artifactType,
    publicPath: descriptor.publicPath,
    latestVersionId: versions.at(-1)?.versionId ?? null,
    selectedVersionId: versions.at(-1)?.versionId ?? null,
    versions,
  }
}

function parseArtifactHistory(value: unknown, descriptor: ArtifactDescriptor): ArtifactHistory {
  if (!isObject(value)) {
    throw new Error(`Invalid artifact history for ${descriptor.displayName}.`)
  }

  const versions = Array.isArray(value.versions)
    ? value.versions
        .map((entry) => {
          if (
            !isObject(entry) ||
            typeof entry.versionId !== 'string' ||
            typeof entry.path !== 'string'
          ) {
            return null
          }

          return {
            versionId: entry.versionId,
            path: normalizeRepoRelativePath(entry.path, `${descriptor.displayName} version path`),
            metadataPath: normalizeRepoRelativePath(
              typeof entry.metadataPath === 'string'
                ? entry.metadataPath
                : `${descriptor.historyDir}/${entry.versionId}.json`,
              `${descriptor.displayName} version metadata path`,
            ),
            createdAt:
              typeof entry.createdAt === 'string' ? entry.createdAt : new Date(0).toISOString(),
            baseVersionId: typeof entry.baseVersionId === 'string' ? entry.baseVersionId : null,
            generationId: typeof entry.generationId === 'string' ? entry.generationId : null,
            editInstruction:
              typeof entry.editInstruction === 'string' ? entry.editInstruction : null,
          } satisfies ArtifactHistoryVersionSummary
        })
        .filter((entry): entry is ArtifactHistoryVersionSummary => entry !== null)
    : []

  return {
    artifactId:
      typeof value.artifactId === 'string' && value.artifactId.length > 0
        ? value.artifactId
        : descriptor.artifactId,
    artifactType:
      value.artifactType === descriptor.artifactType
        ? descriptor.artifactType
        : descriptor.artifactType,
    publicPath:
      typeof value.publicPath === 'string'
        ? normalizeRepoRelativePath(value.publicPath)
        : descriptor.publicPath,
    latestVersionId:
      typeof value.latestVersionId === 'string'
        ? value.latestVersionId
        : (versions.at(-1)?.versionId ?? null),
    selectedVersionId:
      typeof value.selectedVersionId === 'string'
        ? value.selectedVersionId
        : (versions.at(-1)?.versionId ?? null),
    versions,
  }
}

function parseArtifactVersionMetadata(
  value: unknown,
  descriptor: ArtifactDescriptor,
  versionId: string,
): ArtifactVersionMetadata {
  if (!isObject(value)) {
    throw new Error(`Invalid metadata for ${descriptor.displayName} ${versionId}.`)
  }

  const references = Array.isArray(value.references)
    ? value.references.reduce<ResolvedArtifactReference[]>((accumulator, entry) => {
        if (!isObject(entry) || typeof entry.path !== 'string') {
          return accumulator
        }

        accumulator.push({
          path: normalizeRepoRelativePath(entry.path, `${descriptor.displayName} reference path`),
          source: entry.source === 'user' ? 'user' : 'system',
          kind:
            typeof entry.kind === 'string' ? (entry.kind as GenerationReferenceKind) : undefined,
          label: typeof entry.label === 'string' ? entry.label : undefined,
          role: typeof entry.role === 'string' ? entry.role : undefined,
          notes: typeof entry.notes === 'string' ? entry.notes : undefined,
        })

        return accumulator
      }, [])
    : []

  return {
    versionId,
    createdAt: typeof value.createdAt === 'string' ? value.createdAt : new Date(0).toISOString(),
    sourceArtifactId:
      typeof value.sourceArtifactId === 'string' ? value.sourceArtifactId : descriptor.artifactId,
    baseVersionId: typeof value.baseVersionId === 'string' ? value.baseVersionId : null,
    generationId: typeof value.generationId === 'string' ? value.generationId : null,
    seed: typeof value.seed === 'number' && Number.isInteger(value.seed) ? value.seed : null,
    autoSelected: value.autoSelected !== false,
    editInstruction: typeof value.editInstruction === 'string' ? value.editInstruction : null,
    approvedActionSummary:
      typeof value.approvedActionSummary === 'string' ? value.approvedActionSummary : null,
    references,
  }
}

function buildVersionSummary(
  descriptor: ArtifactDescriptor,
  metadata: ArtifactVersionMetadata,
): ArtifactHistoryVersionSummary {
  return {
    versionId: metadata.versionId,
    path: getArtifactVersionMediaPath(descriptor, metadata.versionId),
    metadataPath: getArtifactVersionMetadataPath(descriptor, metadata.versionId),
    createdAt: metadata.createdAt,
    baseVersionId: metadata.baseVersionId,
    generationId: metadata.generationId,
    editInstruction: metadata.editInstruction,
  }
}

function compareVersionIds(left: string, right: string) {
  const leftMatch = /^v(\d+)$/.exec(left)
  const rightMatch = /^v(\d+)$/.exec(right)

  if (!leftMatch || !rightMatch) {
    return left.localeCompare(right)
  }

  return Number(leftMatch[1]) - Number(rightMatch[1])
}

export function getVersionSeed(versionId: string): number | null {
  const match = /^v(\d+)$/.exec(versionId)

  if (!match) {
    return null
  }

  return Number(match[1])
}

function getNextVersionId(history: ArtifactHistory | null) {
  if (!history || history.versions.length === 0) {
    return 'v1'
  }

  const highestVersion = history.versions
    .map((entry) => /^v(\d+)$/.exec(entry.versionId))
    .filter((entry): entry is RegExpExecArray => entry !== null)
    .reduce((highest, match) => Math.max(highest, Number(match[1])), 0)

  return `v${highestVersion + 1}`
}

async function readJsonFile(filePath: string) {
  return JSON.parse(await readFile(filePath, 'utf8'))
}

async function writeJsonFile(filePath: string, value: unknown) {
  await mkdir(path.dirname(filePath), { recursive: true })
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

async function loadGenerationLogEntries(cwd = process.cwd()) {
  const logPath = path.resolve(cwd, 'workspace', 'GENERATION-LOG.jsonl')
  const raw = await readFile(logPath, 'utf8').catch(() => null)

  if (!raw) {
    return [] as GenerationLogEntry[]
  }

  const entries: GenerationLogEntry[] = []

  for (const line of raw.split('\n')) {
    const trimmedLine = line.trim()

    if (trimmedLine.length === 0) {
      continue
    }

    try {
      entries.push(JSON.parse(trimmedLine) as GenerationLogEntry)
    } catch {
      continue
    }
  }

  return entries
}

function findMatchingGenerationLogEntry(
  descriptor: ArtifactDescriptor,
  entries: GenerationLogEntry[],
  cwd: string,
) {
  const publicAbsolutePath = resolveRepoPath(descriptor.publicPath, cwd)

  return [...entries].reverse().find((entry) => {
    if (entry.status !== 'success') {
      return false
    }

    if (
      entry.artifactType === descriptor.artifactType &&
      entry.artifactId === descriptor.artifactId
    ) {
      return true
    }

    if (descriptor.artifactType === 'keyframe' && entry.keyframeId === descriptor.artifactId) {
      return true
    }

    if (descriptor.artifactType === 'shot' && entry.shotId === descriptor.artifactId) {
      return true
    }

    return (entry.outputPaths ?? []).some(
      (outputPath) => path.resolve(outputPath) === publicAbsolutePath,
    )
  })
}

function createSystemReference(
  kind: GenerationReferenceKind,
  pathValue: string,
  overrides: Partial<ResolvedArtifactReference> = {},
): ResolvedArtifactReference {
  return {
    path: normalizeRepoRelativePath(pathValue),
    source: 'system',
    kind,
    ...overrides,
  }
}

function createUserReferences(references: readonly ArtifactReferenceEntry[] = []) {
  return references.map<ResolvedArtifactReference>((reference) => ({
    path: normalizeRepoRelativePath(reference.path),
    source: 'user',
    kind: 'user-reference',
    label: reference.label,
    role: reference.role,
    notes: reference.notes,
  }))
}

export function toGenerationReferences(
  references: readonly ResolvedArtifactReference[],
): GenerationReferenceEntry[] {
  return references.map((reference) => ({
    kind: reference.kind ?? (reference.source === 'user' ? 'user-reference' : 'user-reference'),
    path: reference.path,
  }))
}

export async function assertResolvedReferencesExist(
  references: readonly Pick<ResolvedArtifactReference, 'path'>[],
  cwd = process.cwd(),
) {
  for (const reference of references) {
    const absolutePath = resolveRepoPath(reference.path, cwd)

    if (await fileExists(absolutePath)) {
      continue
    }

    throw new Error(`Required reference is missing at ${reference.path}.`)
  }
}

export function getStoryboardArtifactDescriptor(): ArtifactDescriptor {
  const historyDir = path.posix.join('workspace', HISTORY_FOLDER_NAME, STORYBOARD_ARTIFACT_ID)

  return {
    artifactType: 'storyboard',
    artifactId: STORYBOARD_ARTIFACT_ID,
    displayName: 'Storyboard',
    publicPath: getStoryboardImagePath(),
    sidecarPath: getStoryboardSidecarPath(),
    historyDir,
    artifactControlPath: path.posix.join(historyDir, 'artifact.json'),
    mediaExtension: '.png',
    shotId: null,
  }
}

export function getCharacterArtifactDescriptor(characterId: string): ArtifactDescriptor {
  const historyDir = path.posix.join('workspace', 'CHARACTERS', HISTORY_FOLDER_NAME, characterId)

  return {
    artifactType: 'character',
    artifactId: characterId,
    displayName: `Character ${characterId}`,
    publicPath: getCharacterSheetImagePath(characterId),
    sidecarPath: path.posix.join('workspace', 'CHARACTERS', `${characterId}.json`),
    historyDir,
    artifactControlPath: path.posix.join(historyDir, 'artifact.json'),
    mediaExtension: '.png',
    shotId: null,
  }
}

export function getKeyframeArtifactDescriptor(
  keyframe: Pick<KeyframeEntry, 'keyframeId' | 'shotId'>,
) {
  const historyDir = path.posix.join(
    'workspace',
    'KEYFRAMES',
    keyframe.shotId,
    HISTORY_FOLDER_NAME,
    keyframe.keyframeId,
  )

  return {
    artifactType: 'keyframe',
    artifactId: keyframe.keyframeId,
    displayName: `Keyframe ${keyframe.keyframeId}`,
    publicPath: getKeyframeImagePath(keyframe),
    sidecarPath: path.posix.join(
      'workspace',
      'KEYFRAMES',
      keyframe.shotId,
      `${keyframe.keyframeId}.json`,
    ),
    historyDir,
    artifactControlPath: path.posix.join(historyDir, 'artifact.json'),
    mediaExtension: '.png',
    shotId: keyframe.shotId,
  } satisfies ArtifactDescriptor
}

export function getShotArtifactDescriptor(shotId: string): ArtifactDescriptor {
  const historyDir = path.posix.join('workspace', 'SHOTS', HISTORY_FOLDER_NAME, shotId)

  return {
    artifactType: 'shot',
    artifactId: shotId,
    displayName: `Shot ${shotId}`,
    publicPath: getShotVideoPath({ shotId }),
    sidecarPath: path.posix.join('workspace', 'SHOTS', `${shotId}.json`),
    historyDir,
    artifactControlPath: path.posix.join(historyDir, 'artifact.json'),
    mediaExtension: '.mp4',
    shotId,
  }
}

export function getArtifactVersionMediaPath(descriptor: ArtifactDescriptor, versionId: string) {
  return path.posix.join(descriptor.historyDir, `${versionId}${descriptor.mediaExtension}`)
}

export function getArtifactVersionMetadataPath(descriptor: ArtifactDescriptor, versionId: string) {
  return path.posix.join(descriptor.historyDir, `${versionId}.json`)
}

export function buildApprovedActionSummary(input: {
  descriptor: ArtifactDescriptor
  baseVersionId: string | null
  editInstruction: string | null
  references: readonly ResolvedArtifactReference[]
}) {
  const baseLabel = input.baseVersionId ?? 'no prior version'
  const instructionLabel = input.editInstruction
    ? `edit "${input.editInstruction}"`
    : 'initial generation'
  return `${input.descriptor.displayName} from ${baseLabel} with ${input.references.length} reference${input.references.length === 1 ? '' : 's'} (${instructionLabel})`
}

async function writeArtifactHistory(
  descriptor: ArtifactDescriptor,
  history: ArtifactHistory,
  cwd: string,
) {
  await writeJsonFile(resolveRepoPath(descriptor.artifactControlPath, cwd), history)
}

export async function loadArtifactHistory(
  descriptor: ArtifactDescriptor,
  cwd = process.cwd(),
  options: {
    bootstrap?: boolean
  } = {},
): Promise<ArtifactHistory | null> {
  const { bootstrap = true } = options

  if (bootstrap) {
    await ensureArtifactHistoryInitialized(descriptor, cwd)
  }

  const controlPath = resolveRepoPath(descriptor.artifactControlPath, cwd)

  if (!(await fileExists(controlPath))) {
    return null
  }

  return parseArtifactHistory(await readJsonFile(controlPath), descriptor)
}

export async function loadArtifactVersionMetadata(
  descriptor: ArtifactDescriptor,
  versionId: string,
  cwd = process.cwd(),
) {
  const metadataPath = resolveRepoPath(getArtifactVersionMetadataPath(descriptor, versionId), cwd)

  if (!(await fileExists(metadataPath))) {
    return null
  }

  return parseArtifactVersionMetadata(await readJsonFile(metadataPath), descriptor, versionId)
}

export async function loadArtifactHistoryState(
  descriptor: ArtifactDescriptor,
  cwd = process.cwd(),
  options: {
    activeVersionId?: string | null
    bootstrap?: boolean
  } = {},
): Promise<ArtifactHistoryState> {
  const history = await loadArtifactHistory(descriptor, cwd, { bootstrap: options.bootstrap })
  const activeVersionId =
    options.activeVersionId ?? history?.selectedVersionId ?? history?.latestVersionId ?? null
  const versions = history
    ? (
        await Promise.all(
          [...history.versions]
            .sort((left, right) => compareVersionIds(right.versionId, left.versionId))
            .map((entry) => loadArtifactVersionMetadata(descriptor, entry.versionId, cwd)),
        )
      ).filter((entry): entry is ArtifactVersionMetadata => entry !== null)
    : []

  return {
    descriptor,
    history,
    activeVersionId,
    activeVersion: versions.find((entry) => entry.versionId === activeVersionId) ?? null,
    versions,
  }
}

export async function ensureArtifactHistoryInitialized(
  descriptor: ArtifactDescriptor,
  cwd = process.cwd(),
) {
  const existingHistory = await loadArtifactHistory(descriptor, cwd, { bootstrap: false })

  if (existingHistory) {
    return existingHistory
  }

  const publicAbsolutePath = resolveRepoPath(descriptor.publicPath, cwd)

  if (!(await fileExists(publicAbsolutePath))) {
    return null
  }

  const matchedLogEntry = findMatchingGenerationLogEntry(
    descriptor,
    await loadGenerationLogEntries(cwd),
    cwd,
  )
  const publicStats = await stat(publicAbsolutePath)
  const createdAt = matchedLogEntry?.completedAt ?? publicStats.mtime.toISOString()
  const references =
    matchedLogEntry?.references.map<ResolvedArtifactReference>((reference) => ({
      path: normalizeRepoRelativePath(reference.path),
      source: 'system',
      kind: reference.kind,
    })) ?? []
  const versionMetadata: ArtifactVersionMetadata = {
    versionId: 'v1',
    createdAt,
    sourceArtifactId: descriptor.artifactId,
    baseVersionId: null,
    generationId: matchedLogEntry?.generationId ?? null,
    seed:
      typeof matchedLogEntry?.settings.seed === 'number' &&
      Number.isInteger(matchedLogEntry.settings.seed)
        ? matchedLogEntry.settings.seed
        : getVersionSeed('v1'),
    autoSelected: true,
    editInstruction: null,
    approvedActionSummary: null,
    references,
  }
  const versionSummary = buildVersionSummary(descriptor, versionMetadata)
  const history: ArtifactHistory = {
    ...buildArtifactHistory(descriptor, [versionSummary]),
    latestVersionId: 'v1',
    selectedVersionId: 'v1',
  }

  await mkdir(path.dirname(resolveRepoPath(descriptor.artifactControlPath, cwd)), {
    recursive: true,
  })
  await copyFile(publicAbsolutePath, resolveRepoPath(versionSummary.path, cwd))
  await writeJsonFile(resolveRepoPath(versionSummary.metadataPath, cwd), versionMetadata)
  await writeArtifactHistory(descriptor, history, cwd)

  return history
}

export async function prepareStagedArtifactVersion(
  descriptor: ArtifactDescriptor,
  cwd = process.cwd(),
) {
  const history = await loadArtifactHistory(descriptor, cwd, { bootstrap: true })
  const versionId = getNextVersionId(history)
  const stagedPath = path.posix.join(
    descriptor.historyDir,
    `.staged-${versionId}${descriptor.mediaExtension}`,
  )

  await mkdir(path.dirname(resolveRepoPath(stagedPath, cwd)), { recursive: true })

  return {
    versionId,
    stagedPath,
  } satisfies StagedArtifactVersion
}

async function syncSelectedArtifactToPublic(
  descriptor: ArtifactDescriptor,
  versionId: string,
  cwd: string,
) {
  const versionPath = resolveRepoPath(getArtifactVersionMediaPath(descriptor, versionId), cwd)
  const publicPath = resolveRepoPath(descriptor.publicPath, cwd)

  await mkdir(path.dirname(publicPath), { recursive: true })
  await copyFile(versionPath, publicPath)
}

export async function recordArtifactVersionFromStage(input: RecordArtifactVersionInput) {
  const cwd = input.cwd ?? process.cwd()
  const history = await loadArtifactHistory(input.descriptor, cwd, { bootstrap: true })
  const versionId = path.posix
    .basename(input.stagedPath, input.descriptor.mediaExtension)
    .replace(/^\.staged-/, '')
  const createdAt = input.createdAt ?? new Date().toISOString()
  const autoSelect = input.autoSelect !== false
  const versionMetadata: ArtifactVersionMetadata = {
    versionId,
    createdAt,
    sourceArtifactId: input.descriptor.artifactId,
    baseVersionId: input.baseVersionId,
    generationId: input.generationId,
    seed: input.seed,
    autoSelected: autoSelect,
    editInstruction: input.editInstruction,
    approvedActionSummary: input.approvedActionSummary,
    references: [...input.references],
  }
  const versionSummary = buildVersionSummary(input.descriptor, versionMetadata)
  const nextHistory: ArtifactHistory = history ?? buildArtifactHistory(input.descriptor)
  const existingVersions = nextHistory.versions.filter((entry) => entry.versionId !== versionId)

  existingVersions.push(versionSummary)
  existingVersions.sort((left, right) => compareVersionIds(left.versionId, right.versionId))
  nextHistory.versions = existingVersions
  nextHistory.latestVersionId = versionId

  if (autoSelect) {
    nextHistory.selectedVersionId = versionId
  }

  await mkdir(path.dirname(resolveRepoPath(input.descriptor.artifactControlPath, cwd)), {
    recursive: true,
  })
  await copyFile(resolveRepoPath(input.stagedPath, cwd), resolveRepoPath(versionSummary.path, cwd))
  await rm(resolveRepoPath(input.stagedPath, cwd), { force: true })
  await writeJsonFile(resolveRepoPath(versionSummary.metadataPath, cwd), versionMetadata)
  await writeArtifactHistory(input.descriptor, nextHistory, cwd)

  if (autoSelect) {
    await syncSelectedArtifactToPublic(input.descriptor, versionId, cwd)
  }

  return {
    history: nextHistory,
    version: versionMetadata,
  }
}

export async function promoteArtifactVersion(
  descriptor: ArtifactDescriptor,
  versionId: string,
  cwd = process.cwd(),
) {
  const history = await loadArtifactHistory(descriptor, cwd, { bootstrap: true })

  if (!history) {
    throw new Error(`${descriptor.displayName} has no retained history yet.`)
  }

  if (!history.versions.some((entry) => entry.versionId === versionId)) {
    throw new Error(`${descriptor.displayName} is missing retained version ${versionId}.`)
  }

  history.selectedVersionId = versionId
  await writeArtifactHistory(descriptor, history, cwd)
  await syncSelectedArtifactToPublic(descriptor, versionId, cwd)

  return history
}

export function resolveStoryboardGenerationReferences(
  userReferences: readonly ArtifactReferenceEntry[] = [],
) {
  const resolvedReferences = [
    createSystemReference('storyboard-template', 'templates/STORYBOARD.template.png', {
      label: 'Storyboard template',
      notes: 'System template reference for board layout and framing.',
    }),
    ...createUserReferences(userReferences),
  ]

  return {
    resolvedReferences,
    references: toGenerationReferences(resolvedReferences),
  }
}

export function resolveCharacterGenerationReferences(options: {
  selectedVersionPath?: string | null
  userReferences?: readonly ArtifactReferenceEntry[]
}) {
  const resolvedReferences: ResolvedArtifactReference[] = []

  if (options.selectedVersionPath) {
    resolvedReferences.push(
      createSystemReference('selected-image', options.selectedVersionPath, {
        label: 'Active selected version',
        notes: 'Current selected artifact version used as the edit baseline.',
      }),
    )
  }

  resolvedReferences.push(...createUserReferences(options.userReferences))

  return {
    resolvedReferences,
    references: toGenerationReferences(resolvedReferences),
  }
}

function getPreviousShot(shots: ShotEntry[], shotId: string) {
  const shotIndex = shots.findIndex((entry) => entry.shotId === shotId)

  if (shotIndex === -1) {
    throw new Error(`Cannot find shot "${shotId}" in workspace/SHOTS.json.`)
  }

  return shotIndex === 0 ? null : shots[shotIndex - 1]!
}

export function resolveKeyframeGenerationReferences(
  generation: Pick<KeyframeEntry, 'keyframeId' | 'shotId' | 'frameType'> & {
    characterIds: readonly string[]
    incomingTransition: ShotIncomingTransitionEntry
  },
  keyframes: KeyframeEntry[],
  shots: ShotEntry[],
  options: {
    selectedVersionPath?: string | null
    userReferences?: readonly ArtifactReferenceEntry[]
  } = {},
) {
  const resolvedReferences: ResolvedArtifactReference[] = []

  if (options.selectedVersionPath) {
    resolvedReferences.push(
      createSystemReference('selected-image', options.selectedVersionPath, {
        label: 'Active selected version',
        notes: 'Current selected artifact version used as the edit baseline.',
      }),
    )
  }

  if (generation.frameType !== 'end' && generation.incomingTransition.type === 'continuity') {
    const previousShot = getPreviousShot(shots, generation.shotId)

    if (!previousShot) {
      throw new Error(
        `Cannot generate ${generation.keyframeId}; continuity requires a previous shot before "${generation.shotId}".`,
      )
    }

    const previousEndKeyframe = keyframes.find(
      (entry) => entry.shotId === previousShot.shotId && entry.frameType === 'end',
    )

    if (!previousEndKeyframe) {
      throw new Error(
        `Cannot generate ${generation.keyframeId}; previous shot "${previousShot.shotId}" is missing an end keyframe.`,
      )
    }

    resolvedReferences.push(
      createSystemReference('previous-shot-end-frame', previousEndKeyframe.imagePath, {
        label: `Previous shot end frame (${previousShot.shotId})`,
      }),
    )
  }

  if (generation.frameType === 'end') {
    const startKeyframe = keyframes.find(
      (entry) => entry.shotId === generation.shotId && entry.frameType === 'start',
    )

    if (!startKeyframe) {
      throw new Error(
        `Cannot generate ${generation.keyframeId}; shot "${generation.shotId}" is missing a start keyframe.`,
      )
    }

    resolvedReferences.push(
      createSystemReference('start-frame', startKeyframe.imagePath, {
        label: `Start frame (${generation.shotId})`,
      }),
    )
  }

  resolvedReferences.push(...createUserReferences(options.userReferences))
  resolvedReferences.push(
    createSystemReference('storyboard', getStoryboardImagePath(), {
      label: 'Storyboard board',
    }),
  )
  resolvedReferences.push(
    ...generation.characterIds.map((characterId) =>
      createSystemReference('character-sheet', getCharacterSheetImagePath(characterId), {
        label: `Character sheet (${characterId})`,
      }),
    ),
  )

  return {
    resolvedReferences,
    references: toGenerationReferences(resolvedReferences),
  }
}

function getShotAnchorKeyframes(
  generation: Pick<ShotEntry, 'shotId' | 'keyframeIds'>,
  keyframes: KeyframeEntry[],
) {
  const keyframeById = new Map(keyframes.map((entry) => [entry.keyframeId, entry]))
  const anchors = generation.keyframeIds.map((keyframeId) => {
    const anchor = keyframeById.get(keyframeId)

    if (!anchor) {
      throw new Error(`Shot "${generation.shotId}" references missing keyframe "${keyframeId}".`)
    }

    return anchor
  })

  if (anchors.some((anchor) => anchor.shotId !== generation.shotId)) {
    throw new Error(`Shot "${generation.shotId}" must only reference same-shot keyframes.`)
  }

  if (anchors.length === 1) {
    if (anchors[0]?.frameType !== 'single') {
      throw new Error(
        `Shot "${generation.shotId}" references one keyframe, so it must use frameType "single".`,
      )
    }

    return {
      startOrSingle: anchors[0],
      end: null,
      anchors,
    }
  }

  const start = anchors.find((anchor) => anchor.frameType === 'start')
  const end = anchors.find((anchor) => anchor.frameType === 'end')

  if (!start || !end || anchors.some((anchor) => anchor.frameType === 'single')) {
    throw new Error(
      `Shot "${generation.shotId}" must reference one "start" and one "end" keyframe.`,
    )
  }

  return {
    startOrSingle: start,
    end,
    anchors,
  }
}

export function resolveShotGenerationAssets(
  generation: Pick<ShotEntry, 'shotId' | 'keyframeIds'>,
  keyframes: KeyframeEntry[],
  options: {
    userReferences?: readonly ArtifactReferenceEntry[]
  } = {},
): ResolvedShotGenerationAssets {
  const { startOrSingle, end, anchors } = getShotAnchorKeyframes(generation, keyframes)
  const characterIds: string[] = []
  const seenCharacterIds = new Set<string>()

  for (const anchor of anchors) {
    for (const characterId of anchor.characterIds) {
      if (seenCharacterIds.has(characterId)) {
        continue
      }

      seenCharacterIds.add(characterId)
      characterIds.push(characterId)
    }
  }

  const explicitUserReferences = createUserReferences(options.userReferences)
  const derivedCharacterReferences = characterIds.map((characterId) =>
    createSystemReference('character-sheet', getCharacterSheetImagePath(characterId), {
      label: `Character sheet (${characterId})`,
    }),
  )
  const referenceImageCandidates = [...explicitUserReferences, ...derivedCharacterReferences]
  const chosenReferenceImages = referenceImageCandidates.slice(0, 3)
  const droppedReferences = referenceImageCandidates.slice(3)
  const resolvedReferences: ResolvedArtifactReference[] = [
    createSystemReference('start-frame', startOrSingle.imagePath, {
      label: `Start frame (${generation.shotId})`,
    }),
    ...(end
      ? [
          createSystemReference('end-frame', end.imagePath, {
            label: `End frame (${generation.shotId})`,
          }),
        ]
      : []),
    ...chosenReferenceImages,
  ]

  return {
    inputImagePath: startOrSingle.imagePath,
    lastFramePath: end?.imagePath ?? null,
    characterIds,
    referenceImagePaths: chosenReferenceImages.map((reference) => reference.path),
    references: toGenerationReferences(resolvedReferences),
    resolvedReferences,
    droppedReferences,
  }
}

export function summarizeReference(reference: ResolvedArtifactReference) {
  const primaryLabel = reference.label ?? reference.role ?? reference.kind ?? 'reference'

  return {
    title: primaryLabel,
    subtitle: reference.path,
    detail:
      reference.notes ??
      (reference.source === 'user' ? 'User-authored reference' : 'System-derived reference'),
  }
}
