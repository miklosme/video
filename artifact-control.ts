import { access, copyFile, mkdir, readdir, rm, stat } from 'node:fs/promises'
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
  mediaExtension: '.png' | '.mp4'
  shotId: string | null
}

export interface ArtifactHistoryVersionSummary {
  versionId: string
  path: string
  createdAt: string
}

export interface ArtifactHistory {
  artifactId: string
  artifactType: ArtifactType
  publicPath: string
  versions: ArtifactHistoryVersionSummary[]
}

export interface ArtifactHistoryState {
  descriptor: ArtifactDescriptor
  history: ArtifactHistory
  activeVersionId: string | null
  activeVersion: ArtifactHistoryVersionSummary | null
  versions: ArtifactHistoryVersionSummary[]
  currentExists: boolean
  isViewingCurrent: boolean
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
  autoSelect?: boolean
  cwd?: string
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

function getNextVersionId(versions: readonly Pick<ArtifactHistoryVersionSummary, 'versionId'>[]) {
  if (versions.length === 0) {
    return 'v1'
  }

  const highestVersion = versions
    .map((entry) => /^v(\d+)$/.exec(entry.versionId))
    .filter((entry): entry is RegExpExecArray => entry !== null)
    .reduce((highest, match) => Math.max(highest, Number(match[1])), 0)

  return `v${highestVersion + 1}`
}

async function listArtifactHistoryVersions(descriptor: ArtifactDescriptor, cwd: string) {
  const historyAbsolutePath = resolveRepoPath(descriptor.historyDir, cwd)
  const entries = await readdir(historyAbsolutePath, { withFileTypes: true }).catch(() => [])
  const versions: ArtifactHistoryVersionSummary[] = []

  for (const entry of [...entries].sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isFile() || !entry.name.endsWith(descriptor.mediaExtension)) {
      continue
    }

    const versionId = path.posix.basename(entry.name, descriptor.mediaExtension)

    if (!/^v\d+$/.test(versionId)) {
      continue
    }

    const absolutePath = path.join(historyAbsolutePath, entry.name)
    const entryStats = await stat(absolutePath).catch(() => null)

    versions.push({
      versionId,
      path: getArtifactVersionMediaPath(descriptor, versionId),
      createdAt: entryStats?.mtime.toISOString() ?? new Date(0).toISOString(),
    })
  }

  versions.sort((left, right) => compareVersionIds(left.versionId, right.versionId))

  return versions
}

async function archiveStagedArtifactVersion(
  descriptor: ArtifactDescriptor,
  stagedPath: string,
  versionId: string,
  cwd: string,
) {
  const versionAbsolutePath = resolveRepoPath(
    getArtifactVersionMediaPath(descriptor, versionId),
    cwd,
  )

  await mkdir(path.dirname(versionAbsolutePath), { recursive: true })
  await copyFile(resolveRepoPath(stagedPath, cwd), versionAbsolutePath)
  await rm(resolveRepoPath(stagedPath, cwd), { force: true })
}

async function archiveCurrentPublicArtifact(
  descriptor: ArtifactDescriptor,
  versionId: string,
  cwd: string,
) {
  const publicAbsolutePath = resolveRepoPath(descriptor.publicPath, cwd)
  const versionAbsolutePath = resolveRepoPath(
    getArtifactVersionMediaPath(descriptor, versionId),
    cwd,
  )

  await mkdir(path.dirname(versionAbsolutePath), { recursive: true })
  await copyFile(publicAbsolutePath, versionAbsolutePath)
}

async function promoteStagedArtifactToPublic(
  descriptor: ArtifactDescriptor,
  stagedPath: string,
  cwd: string,
) {
  const publicAbsolutePath = resolveRepoPath(descriptor.publicPath, cwd)

  await mkdir(path.dirname(publicAbsolutePath), { recursive: true })
  await copyFile(resolveRepoPath(stagedPath, cwd), publicAbsolutePath)
  await rm(resolveRepoPath(stagedPath, cwd), { force: true })
}

async function syncHistoryVersionToPublic(
  descriptor: ArtifactDescriptor,
  versionId: string,
  cwd: string,
) {
  const publicAbsolutePath = resolveRepoPath(descriptor.publicPath, cwd)
  const versionAbsolutePath = resolveRepoPath(
    getArtifactVersionMediaPath(descriptor, versionId),
    cwd,
  )

  await mkdir(path.dirname(publicAbsolutePath), { recursive: true })
  await copyFile(versionAbsolutePath, publicAbsolutePath)
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
    mediaExtension: '.mp4',
    shotId,
  }
}

export function getArtifactVersionMediaPath(descriptor: ArtifactDescriptor, versionId: string) {
  return path.posix.join(descriptor.historyDir, `${versionId}${descriptor.mediaExtension}`)
}

function getArtifactVersionMetadataPath(descriptor: ArtifactDescriptor, versionId: string) {
  return path.posix.join(descriptor.historyDir, `${versionId}.json`)
}

export async function loadArtifactHistory(
  descriptor: ArtifactDescriptor,
  cwd = process.cwd(),
): Promise<ArtifactHistory> {
  return {
    artifactId: descriptor.artifactId,
    artifactType: descriptor.artifactType,
    publicPath: descriptor.publicPath,
    versions: await listArtifactHistoryVersions(descriptor, cwd),
  }
}

export async function loadArtifactHistoryState(
  descriptor: ArtifactDescriptor,
  cwd = process.cwd(),
  options: {
    activeVersionId?: string | null
  } = {},
): Promise<ArtifactHistoryState> {
  const history = await loadArtifactHistory(descriptor, cwd)
  const activeVersionId =
    options.activeVersionId &&
    history.versions.some((entry) => entry.versionId === options.activeVersionId)
      ? options.activeVersionId
      : null

  return {
    descriptor,
    history,
    activeVersionId,
    activeVersion: history.versions.find((entry) => entry.versionId === activeVersionId) ?? null,
    versions: [...history.versions].sort((left, right) =>
      compareVersionIds(right.versionId, left.versionId),
    ),
    currentExists: await fileExists(resolveRepoPath(descriptor.publicPath, cwd)),
    isViewingCurrent: activeVersionId === null,
  }
}

export async function prepareStagedArtifactVersion(
  descriptor: ArtifactDescriptor,
  cwd = process.cwd(),
) {
  const history = await loadArtifactHistory(descriptor, cwd)
  const versionId = getNextVersionId(history.versions)
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

export async function recordArtifactVersionFromStage(input: RecordArtifactVersionInput) {
  const cwd = input.cwd ?? process.cwd()
  const autoSelect = input.autoSelect !== false
  const versionId = path.posix
    .basename(input.stagedPath, input.descriptor.mediaExtension)
    .replace(/^\.staged-/, '')

  if (!autoSelect) {
    await archiveStagedArtifactVersion(input.descriptor, input.stagedPath, versionId, cwd)
    return {
      versionId,
    }
  }

  const publicAbsolutePath = resolveRepoPath(input.descriptor.publicPath, cwd)
  const retainedVersionId = (await fileExists(publicAbsolutePath)) ? versionId : null

  if (retainedVersionId) {
    await archiveCurrentPublicArtifact(input.descriptor, retainedVersionId, cwd)
  }

  await promoteStagedArtifactToPublic(input.descriptor, input.stagedPath, cwd)

  return {
    versionId: retainedVersionId,
  }
}

export async function promoteArtifactVersion(
  descriptor: ArtifactDescriptor,
  versionId: string,
  cwd = process.cwd(),
) {
  const history = await loadArtifactHistory(descriptor, cwd)

  if (!history.versions.some((entry) => entry.versionId === versionId)) {
    throw new Error(`${descriptor.displayName} is missing retained version ${versionId}.`)
  }

  const publicAbsolutePath = resolveRepoPath(descriptor.publicPath, cwd)
  let archivedVersionId: string | null = null

  if (await fileExists(publicAbsolutePath)) {
    archivedVersionId = getNextVersionId(history.versions)
    await archiveCurrentPublicArtifact(descriptor, archivedVersionId, cwd)
  }

  await syncHistoryVersionToPublic(descriptor, versionId, cwd)

  return {
    versionId,
    archivedVersionId,
  }
}

export async function deleteArtifactVersion(
  descriptor: ArtifactDescriptor,
  versionId: string,
  cwd = process.cwd(),
) {
  const history = await loadArtifactHistory(descriptor, cwd)

  if (!history.versions.some((entry) => entry.versionId === versionId)) {
    throw new Error(`${descriptor.displayName} is missing retained version ${versionId}.`)
  }

  await rm(resolveRepoPath(getArtifactVersionMediaPath(descriptor, versionId), cwd), {
    force: true,
  })
  await rm(resolveRepoPath(getArtifactVersionMetadataPath(descriptor, versionId), cwd), {
    force: true,
  })

  return {
    versionId,
  }
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
    kind: reference.kind,
    label: reference.label,
    notes: reference.notes,
  }))
}

export function toGenerationReferences(
  references: readonly ResolvedArtifactReference[],
): GenerationReferenceEntry[] {
  return references.map((reference) => ({
    kind: reference.kind,
    path: reference.path,
  }))
}

export function resolveStoryboardGenerationReferences(
  userReferences: readonly ArtifactReferenceEntry[] = [],
) {
  const resolvedReferences = createUserReferences(userReferences)

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
        label: 'Base artifact',
        notes: 'Artifact used as the edit baseline for this generation.',
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
        label: 'Base artifact',
        notes: 'Artifact used as the edit baseline for this generation.',
      }),
    )
  }

  resolvedReferences.push(...createUserReferences(options.userReferences))

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
  const missingKeyframeIds = generation.keyframeIds.filter(
    (keyframeId) => !keyframeById.has(keyframeId),
  )
  const anchors = generation.keyframeIds.flatMap((keyframeId) => {
    const anchor = keyframeById.get(keyframeId)

    return anchor ? [anchor] : []
  })

  if (generation.keyframeIds.length === 0) {
    throw new Error(`Shot "${generation.shotId}" must reference at least one keyframe.`)
  }

  if (anchors.length === 0) {
    throw new Error(
      `Shot "${generation.shotId}" cannot be generated because all referenced keyframes are missing from workspace/KEYFRAMES.json.`,
    )
  }

  if (missingKeyframeIds.length > 0) {
    throw new Error(
      `Shot "${generation.shotId}" references missing keyframe${missingKeyframeIds.length === 1 ? '' : 's'} ${missingKeyframeIds.map((keyframeId) => `"${keyframeId}"`).join(', ')}.`,
    )
  }

  if (anchors.some((anchor) => anchor.shotId !== generation.shotId)) {
    throw new Error(`Shot "${generation.shotId}" must only reference same-shot keyframes.`)
  }

  if (anchors.length === 1) {
    if (anchors[0]?.frameType !== 'start' && anchors[0]?.frameType !== 'end') {
      throw new Error(
        `Shot "${generation.shotId}" references one keyframe, so it must use frameType "start" or "end".`,
      )
    }

    return {
      inputAnchor: anchors[0],
      end: null,
      anchors,
    }
  }

  if (anchors.length > 2) {
    throw new Error(`Shot "${generation.shotId}" must not reference more than two keyframes.`)
  }

  const start = anchors.find((anchor) => anchor.frameType === 'start')
  const end = anchors.find((anchor) => anchor.frameType === 'end')

  if (!start || !end) {
    throw new Error(
      `Shot "${generation.shotId}" must reference one "start" and one "end" keyframe.`,
    )
  }

  return {
    inputAnchor: start,
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
  const { inputAnchor, end, anchors } = getShotAnchorKeyframes(generation, keyframes)
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
    createSystemReference(
      inputAnchor.frameType === 'start' ? 'start-frame' : 'end-frame',
      inputAnchor.imagePath,
      {
        label: `${inputAnchor.frameType === 'start' ? 'Start' : 'End'} frame (${generation.shotId})`,
      },
    ),
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
    inputImagePath: inputAnchor.imagePath,
    lastFramePath: end?.imagePath ?? null,
    characterIds,
    referenceImagePaths: chosenReferenceImages.map((reference) => reference.path),
    references: toGenerationReferences(resolvedReferences),
    resolvedReferences,
    droppedReferences,
  }
}

export function summarizeReference(reference: ResolvedArtifactReference) {
  const primaryLabel = reference.label ?? reference.kind ?? 'reference'

  return {
    title: primaryLabel,
    subtitle: reference.path,
    detail:
      reference.notes ??
      (reference.source === 'user' ? 'Sidecar-authored reference' : 'System-derived reference'),
  }
}
