import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'

import {
  deleteArtifactVersion,
  getArtifactKey,
  getArtifactVersionMediaPath,
  getCharacterArtifactDescriptor,
  getKeyframeArtifactDescriptor,
  getShotArtifactDescriptor,
  getStoryboardArtifactDescriptor,
  loadArtifactHistoryState,
  promoteArtifactVersion,
  summarizeReference,
  type ArtifactDescriptor,
  type ArtifactHistoryState,
} from './artifact-control'
import {
  CAMERA_FIELD_CATEGORIES,
  CAMERA_FIELD_LABELS,
  humanizeCameraValue,
  KEYFRAME_CAMERA_FIELDS,
  resolveKeyframeCameraSpec,
  resolveShotCameraSpec,
  SHOT_CAMERA_FIELDS,
  type CameraFieldKey,
} from './camera-utils'
import {
  regenerateCharacterSheetArtifactVersion,
  selectPendingCharacterSheetGenerations,
  type PendingCharacterSheetGeneration,
} from './generate-character-sheets'
import type {
  GenerateImagenOptionsInput,
  GenerateImagenOptionsResult,
} from './generate-imagen-options'
import {
  generateKeyframeArtifactVersion,
  regenerateKeyframeArtifactVersion,
  selectPendingKeyframeGenerations,
  type PendingKeyframeGeneration,
} from './generate-keyframes'
import {
  regenerateShotArtifactVersion,
  selectPendingShotGenerations,
  type PendingShotGeneration,
  type ShotVideoGenerator,
} from './generate-shots'
import {
  buildStoryboardPrompt,
  ensureStoryboardImagePaths,
  generateStoryboardArtifactVersion,
  regenerateStoryboardArtifactVersion,
  selectPendingStoryboardGenerations,
  type PendingStoryboardGeneration,
} from './generate-storyboard'
import {
  buildStoryboardDerivedImages,
  buildStoryboardShotSlots,
  createStoryboardImageEntry,
  findStoryboardDerivedImageByArtifactId,
  findStoryboardDerivedImageBySelectionId,
  findStoryboardImageForShotIndex,
  getStoryboardSelectionId,
  parseStoryboardSelectionId,
  STORYBOARD_NEW_SELECTION_ID,
  type StoryboardDerivedImageEntry,
} from './storyboard-utils'
import { renderTimelineContent } from './timeline-component'
import {
  AUTHORED_REFERENCE_KINDS,
  getCharacterSheetImagePath,
  getKeyframeArtifactJsonPath,
  getKeyframeImagePath,
  getLegacyStoryboardImagePath,
  getShotVideoPath,
  loadCameraVocabulary,
  loadCharacterSheets,
  loadConfig,
  loadKeyframeArtifacts,
  loadKeyframes,
  loadShotArtifacts,
  loadShotPrompts,
  loadStoryboardSidecar,
  normalizeRepoRelativePath,
  resolveRepoPath,
  resolveWorkflowPath,
  WORKFLOW_FILES,
  type ArtifactReferenceEntry,
  type CameraVocabularyData,
  type CameraVocabularyEntry,
  type CharacterSheetEntry,
  type FrameType,
  type KeyframeCameraSpec,
  type KeyframeEntry,
  type ResolvedArtifactReference,
  type ShotCameraSpec,
  type ShotEntry,
  type StoryboardImageEntry,
  type StoryboardSidecar,
} from './workflow-data'

const FRAME_ORDER: Record<FrameType, number> = {
  start: 0,
  end: 1,
}

const HTML_HEADERS = {
  'content-type': 'text/html; charset=utf-8',
  'cache-control': 'no-store',
}

const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
}

const CURRENT_BASE_VERSION_ID = 'current'

type Tab = 'idea' | 'story' | 'characters' | 'storyboard' | 'timeline'

type ArtifactJobStatus = 'running' | 'success' | 'error'

interface ArtifactJobState {
  status: ArtifactJobStatus
  startedAt: string
  completedAt: string | null
  message: string
  versionId: string | null
}

type PlaceholderVariant = 'missing' | 'omitted'

type ImageGenerator = (input: GenerateImagenOptionsInput) => Promise<GenerateImagenOptionsResult>

interface RegenerateActionOptions {
  imageGenerator?: ImageGenerator
  shotVideoGenerator?: ShotVideoGenerator
  cameraOverrides?: Partial<ShotCameraSpec> | null
}

interface CharacterReviewCard {
  characterId: string
  displayName: string
  prompt: string
  status: string
  imageUrl: string
  imageExists: boolean
}

interface StoryboardReviewCard {
  selectionId: string
  storyboardImageId: string
  shotId: string
  frameType: FrameType
  goal: string
  imageUrl: string | null
  imageExists: boolean
}

interface StoryboardGridTile {
  selectionId: string
  storyboardImageId: string
  shotId: string
  frameType: FrameType
  goal: string
  imageUrl: string | null
  imageExists: boolean
  isSelected: boolean
}

interface StoryboardGridSlot {
  shotId: string
  tiles: StoryboardGridTile[]
  isPaired: boolean
}

interface StoryboardSelectionState {
  selectedImageId: string
  selectedEntry: StoryboardDerivedImageEntry | null
  isNewSelection: boolean
}

interface VersionRailItem {
  versionId: string
  label: string
  href: string
  mediaUrl: string | null
  mediaExists: boolean
  isActive: boolean
  isCurrent: boolean
}

interface ArtifactPrimaryAction {
  kind: 'regenerate' | 'create-keyframe' | 'generate'
  actionUrl: string
  enabled: boolean
}

interface AnchorPlanningAction {
  kind: 'remove-keyframe' | 'bridge-keyframe' | 'unbridge-keyframe'
  actionUrl: string
  enabled: boolean
  buttonLabel: string
  buttonTone: 'danger' | 'secondary'
  helpText: string
  confirmMessage?: string
}

interface ArtifactDetailContext {
  descriptor: ArtifactDescriptor
  activeTab: Tab
  title: string
  subtitle: string
  summaryHref: string
  summaryLabel: string
  mediaType: 'image' | 'video'
  mediaUrl: string | null
  mediaExists: boolean
  mediaPlaceholder: string
  mediaPlaceholderVariant: PlaceholderVariant
  sourceReferences: ArtifactReferenceEntry[]
  sourcePrompt: string | null
  sourceModel: string | null
  sourceStatus: string | null
  historyState: ArtifactHistoryState
  notesHtml: string
  canEdit: boolean
  canEditReferences: boolean
  primaryAction: ArtifactPrimaryAction | null
  cameraControl: CameraOverrideControl | null
  anchorPlanningAction: AnchorPlanningAction | null
  extraSideHtml?: string
}

interface CameraOverrideOption {
  value: string
  label: string
  description: string
}

interface CameraOverrideField {
  field: CameraFieldKey
  label: string
  inputName: string
  currentValue: string
  currentLabel: string
  options: CameraOverrideOption[]
}

interface CameraOverrideControl {
  artifactType: 'keyframe' | 'shot'
  fields: CameraOverrideField[]
}

const KEYFRAME_SIDECAR_FIELD_ORDER = [
  'keyframeId',
  'shotId',
  'frameType',
  'camera',
  'prompt',
  'status',
  'references',
] as const

const SHOT_SIDECAR_FIELD_ORDER = ['shotId', 'camera', 'prompt', 'status', 'references'] as const

export interface ArtifactReviewServer {
  port: number
  url: string
  stop: () => Promise<void>
}

function appendSearchParams(
  href: string,
  entries: Record<string, string | null | undefined | boolean>,
) {
  const url = new URL(href, 'http://artifact-review.local')

  for (const [key, value] of Object.entries(entries)) {
    if (value === undefined || value === null || value === false) {
      url.searchParams.delete(key)
      continue
    }

    url.searchParams.set(key, value === true ? '1' : String(value))
  }

  return `${url.pathname}${url.search}`
}

function isEmbeddedRequestUrl(url: URL) {
  return url.searchParams.get('embed') === '1'
}

function getEmbeddedActionHref(href: string, embedded?: boolean) {
  return embedded ? appendSearchParams(href, { embed: true }) : href
}

function getEmbeddedRefreshDetailUrl(url: URL) {
  if (!isEmbeddedRequestUrl(url) || url.searchParams.get('updated') !== '1') {
    return null
  }

  return appendSearchParams(`${url.pathname}${url.search}`, { updated: null })
}

function buildPostActionRedirectLocation(
  location: string,
  request: Request,
  options: { updated?: boolean } = {},
) {
  const url = new URL(request.url)
  const embedded = isEmbeddedRequestUrl(url)

  return appendSearchParams(location, {
    embed: embedded,
    updated: embedded && (options.updated ?? false),
  })
}

function escapeHtml(value: string) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

function encodeAssetUrl(assetPath: string) {
  return assetPath
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/')
}

async function fileExists(filePath: string) {
  try {
    await access(filePath)
    return true
  } catch {
    return false
  }
}

function frameTypeLabel(frameType: FrameType) {
  return frameType === 'start' ? 'Start' : 'End'
}

function getCanonicalKeyframeId(shotId: string, frameType: FrameType) {
  return `${shotId}-${frameType.toUpperCase()}`
}

function parseCanonicalKeyframeId(keyframeId: string): {
  shotId: string
  frameType: FrameType
} | null {
  if (keyframeId.endsWith('-START')) {
    return {
      shotId: keyframeId.slice(0, -'-START'.length),
      frameType: 'start',
    }
  }

  if (keyframeId.endsWith('-END')) {
    return {
      shotId: keyframeId.slice(0, -'-END'.length),
      frameType: 'end',
    }
  }

  return null
}

function getShotIndex(shots: ShotEntry[], shotId: string) {
  return shots.findIndex((entry) => entry.shotId === shotId)
}

function getAdjacentShots(shots: ShotEntry[], shotId: string) {
  const index = getShotIndex(shots, shotId)

  return {
    index,
    previousShot: index > 0 ? (shots[index - 1] ?? null) : null,
    nextShot: index >= 0 ? (shots[index + 1] ?? null) : null,
  }
}

function getPlannedShotKeyframe(shot: ShotEntry, frameType: FrameType) {
  return (shot.keyframes ?? []).find((entry) => entry.frameType === frameType) ?? null
}

function getBridgeSourceShot(shots: ShotEntry[], shotId: string) {
  const { previousShot } = getAdjacentShots(shots, shotId)

  if (!previousShot || previousShot.endFrameMode !== 'bridge') {
    return null
  }

  return previousShot
}

function getBridgedEndSharedStartKeyframeId(shots: ShotEntry[], keyframeId: string) {
  const match = getShotByCanonicalKeyframeId(shots, keyframeId)

  if (
    !match ||
    match.frameType !== 'end' ||
    match.shot.keyframeIds.includes(keyframeId) ||
    match.shot.endFrameMode !== 'bridge'
  ) {
    return null
  }

  const { nextShot } = getAdjacentShots(shots, match.shotId)

  return nextShot ? (getPlannedShotKeyframe(nextShot, 'start')?.keyframeId ?? null) : null
}

function sortShotKeyframes(
  keyframes: ReadonlyArray<Pick<KeyframeEntry, 'frameType' | 'keyframeId' | 'imagePath'>>,
) {
  return [...keyframes].sort(
    (left, right) =>
      FRAME_ORDER[left.frameType] - FRAME_ORDER[right.frameType] ||
      left.keyframeId.localeCompare(right.keyframeId),
  )
}

async function loadCharacterSheetsOrEmpty(cwd: string) {
  try {
    return await loadCharacterSheets(cwd)
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
      return []
    }

    throw error
  }
}

async function loadKeyframesOrEmpty(cwd: string) {
  try {
    return await loadKeyframes(cwd)
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
      return []
    }

    throw error
  }
}

async function loadKeyframeArtifactsOrEmpty(cwd: string) {
  try {
    return await loadKeyframeArtifacts(cwd)
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
      return []
    }

    throw error
  }
}

async function loadShotPromptsOrEmpty(cwd: string) {
  try {
    return await loadShotPrompts(cwd)
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
      return []
    }

    throw error
  }
}

async function loadStoryboardOrEmpty(cwd: string) {
  try {
    return await loadStoryboardSidecar(cwd)
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
      return null
    }

    throw error
  }
}

function findStoryboardImage(
  storyboard: { images: StoryboardImageEntry[] } | null,
  selectionId: string,
) {
  if (!storyboard) {
    return null
  }

  return findStoryboardDerivedImageBySelectionId(storyboard.images, selectionId)
}

function findStoryboardImageByArtifactId(
  storyboard: { images: StoryboardImageEntry[] } | null,
  artifactId: string,
) {
  if (!storyboard) {
    return null
  }

  return findStoryboardDerivedImageByArtifactId(storyboard.images, artifactId)
}

function getStoryboardSelectionState(
  storyboard: { images: StoryboardImageEntry[] } | null,
  requestedImageId: string | null,
): StoryboardSelectionState {
  const selectedEntry = requestedImageId ? findStoryboardImage(storyboard, requestedImageId) : null
  const fallbackEntry = storyboard
    ? (buildStoryboardDerivedImages(storyboard.images)[0] ?? null)
    : null

  if (selectedEntry) {
    return {
      selectedImageId: getStoryboardSelectionId(selectedEntry.imageIndex),
      selectedEntry,
      isNewSelection: false,
    }
  }

  if (requestedImageId === STORYBOARD_NEW_SELECTION_ID || !fallbackEntry) {
    return {
      selectedImageId: STORYBOARD_NEW_SELECTION_ID,
      selectedEntry: null,
      isNewSelection: true,
    }
  }

  return {
    selectedImageId: getStoryboardSelectionId(fallbackEntry.imageIndex),
    selectedEntry: fallbackEntry,
    isNewSelection: false,
  }
}

function getStoryboardImageIndex(
  storyboard: { images: StoryboardImageEntry[] } | null,
  selectionId: string,
) {
  if (!storyboard) {
    return -1
  }

  const imageIndex = parseStoryboardSelectionId(selectionId)
  return imageIndex !== null && imageIndex < storyboard.images.length ? imageIndex : -1
}

function getStoryboardPairedEnd(
  storyboard: { images: StoryboardImageEntry[] } | null,
  selectionId: string,
) {
  const index = getStoryboardImageIndex(storyboard, selectionId)

  if (index < 0) {
    return null
  }

  const slotIndex = buildStoryboardShotSlots(storyboard?.images ?? []).findIndex((slot) =>
    slot.items.some((item) => item.imageIndex === index),
  )
  const slot = slotIndex >= 0 ? buildStoryboardShotSlots(storyboard?.images ?? [])[slotIndex] : null

  return slot?.items.find((item) => item.entry.frameType === 'end') ?? null
}

function canInsertStoryboardEnd(
  storyboard: { images: StoryboardImageEntry[] } | null,
  selectionId: string,
) {
  const current = findStoryboardImage(storyboard, selectionId)

  if (!current || current.entry.frameType !== 'start') {
    return false
  }

  return getStoryboardPairedEnd(storyboard, selectionId) === null
}

async function loadCameraVocabularyOrNull(cwd: string) {
  try {
    return await loadCameraVocabulary(cwd)
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
      return null
    }

    throw error
  }
}

function serializeShotEntry(shot: ShotEntry) {
  return {
    shotId: shot.shotId,
    status: shot.status,
    videoPath: shot.videoPath,
    ...(shot.endFrameMode ? { endFrameMode: shot.endFrameMode } : {}),
    durationSeconds: shot.durationSeconds,
    keyframes: sortShotKeyframes(shot.keyframes ?? []).map((entry) => ({
      keyframeId: entry.keyframeId,
      frameType: entry.frameType,
      imagePath: entry.imagePath,
    })),
  }
}

async function writeShotPromptsFile(shots: ShotEntry[], cwd: string) {
  const outputPath = resolveWorkflowPath(WORKFLOW_FILES.shotPrompts, cwd)
  const serialized = shots.map((shot) => serializeShotEntry(shot))

  await writeFile(outputPath, `${JSON.stringify(serialized, null, 2)}\n`, 'utf8')
}

function buildEmbeddedKeyframeDetailUrl(keyframeId: string) {
  return `/keyframes/${encodeURIComponent(keyframeId)}?embed=1`
}

function buildEmbeddedShotDetailUrl(shotId: string) {
  return `/shots/${encodeURIComponent(shotId)}?embed=1`
}

async function buildTimelineData(shots: ShotEntry[], cwd: string) {
  if (shots.length === 0) {
    return {
      pointers: [],
      sections: [],
      keyframeGroups: [],
      saveUrl: '/timeline/update',
    }
  }

  let position = 0
  const pointers: Array<{
    id: string
    position: number
    canDrag: boolean
    left: {
      keyframeId: string
      detailUrl: string
      omitted: boolean
    } | null
    right: {
      keyframeId: string
      detailUrl: string
      omitted: boolean
    } | null
  }> = [
    {
      id: 'pointer-0',
      position: 0,
      canDrag: false,
      left: null,
      right: {
        keyframeId: getCanonicalKeyframeId(shots[0]!.shotId, 'start'),
        detailUrl: buildEmbeddedKeyframeDetailUrl(
          getCanonicalKeyframeId(shots[0]!.shotId, 'start'),
        ),
        omitted: !shots[0]!.keyframeIds.includes(getCanonicalKeyframeId(shots[0]!.shotId, 'start')),
      },
    },
  ]
  const sections = shots.map((shot) => ({
    shotId: shot.shotId,
    detailUrl: buildEmbeddedShotDetailUrl(shot.shotId),
  }))

  for (let index = 0; index < shots.length; index += 1) {
    const currentShot = shots[index]!
    const nextShot = shots[index + 1] ?? null
    const currentEndId = getCanonicalKeyframeId(currentShot.shotId, 'end')
    position += currentShot.durationSeconds

    const pointer =
      currentShot.endFrameMode === 'bridge' && nextShot
        ? {
            id: `pointer-${index + 1}`,
            position,
            canDrag: true,
            left: null,
            right: {
              keyframeId: getCanonicalKeyframeId(nextShot.shotId, 'start'),
              detailUrl: buildEmbeddedKeyframeDetailUrl(
                getCanonicalKeyframeId(nextShot.shotId, 'start'),
              ),
              omitted: !nextShot.keyframeIds.includes(
                getCanonicalKeyframeId(nextShot.shotId, 'start'),
              ),
            },
          }
        : {
            id: `pointer-${index + 1}`,
            position,
            canDrag: true,
            left: {
              keyframeId: currentEndId,
              detailUrl: buildEmbeddedKeyframeDetailUrl(currentEndId),
              omitted: !currentShot.keyframeIds.includes(currentEndId),
            },
            right: nextShot
              ? {
                  keyframeId: getCanonicalKeyframeId(nextShot.shotId, 'start'),
                  detailUrl: buildEmbeddedKeyframeDetailUrl(
                    getCanonicalKeyframeId(nextShot.shotId, 'start'),
                  ),
                  omitted: !nextShot.keyframeIds.includes(
                    getCanonicalKeyframeId(nextShot.shotId, 'start'),
                  ),
                }
              : null,
          }

    pointers.push(pointer)
  }

  const keyframeGroups = (
    await Promise.all(
      shots.map(async (shot, index) => {
        const plannedEntriesById = new Map(
          (shot.keyframes ?? []).map((entry) => [entry.keyframeId, entry]),
        )
        const items = await Promise.all(
          (['start', 'end'] as const)
            .filter((frameType) =>
              shot.keyframeIds.includes(getCanonicalKeyframeId(shot.shotId, frameType)),
            )
            .map(async (frameType) => {
              const keyframeId = getCanonicalKeyframeId(shot.shotId, frameType)
              const plannedEntry = plannedEntriesById.get(keyframeId)
              const imagePath =
                plannedEntry?.imagePath ?? getKeyframeImagePath({ shotId: shot.shotId, keyframeId })

              return {
                keyframeId,
                shotId: shot.shotId,
                frameType,
                pointerId: frameType === 'start' ? `pointer-${index}` : `pointer-${index + 1}`,
                side: frameType === 'start' ? 'right' : 'left',
                detailUrl: buildEmbeddedKeyframeDetailUrl(keyframeId),
                imageUrl: `/${encodeAssetUrl(imagePath)}`,
                imageExists: await fileExists(resolveRepoPath(imagePath, cwd)),
              } as const
            }),
        )

        return items.length > 0
          ? {
              shotId: shot.shotId,
              items,
            }
          : null
      }),
    )
  ).filter((group): group is NonNullable<typeof group> => group !== null)

  return {
    pointers,
    sections,
    keyframeGroups,
    saveUrl: '/timeline/update',
  }
}

function getShotByCanonicalKeyframeId(shots: ShotEntry[], keyframeId: string) {
  const parsed = parseCanonicalKeyframeId(keyframeId)

  if (!parsed) {
    return null
  }

  const shot = shots.find((entry) => entry.shotId === parsed.shotId)

  if (!shot) {
    return null
  }

  return {
    shot,
    frameType: parsed.frameType,
    shotId: parsed.shotId,
  }
}

async function createOmittedKeyframe(
  keyframeId: string,
  prompt: string,
  cwd: string,
): Promise<ArtifactDescriptor> {
  const trimmedPrompt = prompt.trim()

  if (trimmedPrompt.length === 0) {
    throw new Error('A prompt is required to create a keyframe.')
  }

  const shots = await loadShotPrompts(cwd)
  const match = getShotByCanonicalKeyframeId(shots, keyframeId)

  if (!match) {
    throw new Error(`Keyframe "${keyframeId}" does not map to an existing shot.`)
  }

  const { shot, frameType, shotId } = match

  if (shot.keyframeIds.includes(keyframeId)) {
    throw new Error(`Keyframe "${keyframeId}" is already planned.`)
  }

  if (frameType === 'end' && shot.endFrameMode === 'bridge') {
    throw new Error(
      `Keyframe "${keyframeId}" is currently bridged to the next shot start. Unbridge it before creating a distinct end keyframe.`,
    )
  }

  const nextKeyframes = sortShotKeyframes([
    ...(shot.keyframes ?? []),
    {
      keyframeId,
      frameType,
      imagePath: getKeyframeImagePath({ shotId, keyframeId }),
    },
  ])

  const nextShots = shots.map((entry) =>
    entry.shotId === shotId
      ? {
          ...entry,
          keyframes: nextKeyframes,
          keyframeIds: nextKeyframes.map((item) => item.keyframeId),
        }
      : entry,
  )
  const descriptor = getKeyframeArtifactDescriptor({ keyframeId, shotId })
  const sidecarAbsolutePath = resolveRepoPath(
    getKeyframeArtifactJsonPath({ shotId, keyframeId }),
    cwd,
  )

  await writeShotPromptsFile(nextShots, cwd)
  await mkdir(path.dirname(sidecarAbsolutePath), { recursive: true })
  await writeFile(
    sidecarAbsolutePath,
    `${JSON.stringify(
      {
        keyframeId,
        shotId,
        frameType,
        prompt: trimmedPrompt,
        status: 'draft',
      },
      null,
      2,
    )}\n`,
    'utf8',
  )

  return descriptor
}

async function removePlannedKeyframe(keyframeId: string, cwd: string): Promise<ArtifactDescriptor> {
  const shots = await loadShotPrompts(cwd)
  const shot = shots.find((entry) => entry.keyframeIds.includes(keyframeId))

  if (!shot) {
    throw new Error(`Keyframe "${keyframeId}" is not planned in workspace/SHOTS.json.`)
  }

  if (shot.keyframeIds.length <= 1) {
    throw new Error(`Shot "${shot.shotId}" must keep at least one planned anchor.`)
  }

  const parsedKeyframeId = parseCanonicalKeyframeId(keyframeId)

  if (parsedKeyframeId?.frameType === 'start') {
    const bridgeSourceShot = getBridgeSourceShot(shots, shot.shotId)

    if (bridgeSourceShot) {
      throw new Error(
        `Keyframe "${keyframeId}" is currently reused as the bridge frame for "${bridgeSourceShot.shotId}" and cannot be removed while that bridge is active.`,
      )
    }
  }

  const nextKeyframes = (shot.keyframes ?? []).filter((entry) => entry.keyframeId !== keyframeId)

  if (nextKeyframes.length === (shot.keyframes ?? []).length) {
    throw new Error(`Keyframe "${keyframeId}" is missing from shot "${shot.shotId}".`)
  }

  const nextShots = shots.map((entry) =>
    entry.shotId === shot.shotId
      ? {
          ...entry,
          keyframes: nextKeyframes,
          keyframeIds: nextKeyframes.map((item) => item.keyframeId),
        }
      : entry,
  )
  const descriptor = getKeyframeArtifactDescriptor({
    keyframeId,
    shotId: shot.shotId,
  })

  await writeShotPromptsFile(nextShots, cwd)
  if (!descriptor.sidecarPath) {
    throw new Error(`Keyframe "${keyframeId}" is missing its source sidecar path.`)
  }

  await rm(resolveRepoPath(descriptor.sidecarPath, cwd), { force: true })
  await rm(resolveRepoPath(descriptor.publicPath, cwd), { force: true })
  await rm(resolveRepoPath(descriptor.historyDir, cwd), { recursive: true, force: true })

  return descriptor
}

async function bridgeOmittedEndKeyframe(
  keyframeId: string,
  cwd: string,
): Promise<ArtifactDescriptor> {
  const shots = await loadShotPrompts(cwd)
  const match = getShotByCanonicalKeyframeId(shots, keyframeId)

  if (!match) {
    throw new Error(`Keyframe "${keyframeId}" does not map to an existing shot.`)
  }

  const { shot, frameType, shotId } = match

  if (frameType !== 'end') {
    throw new Error(`Only omitted end keyframes can be turned into bridge frames.`)
  }

  if (shot.keyframeIds.includes(keyframeId)) {
    throw new Error(`Keyframe "${keyframeId}" is already planned.`)
  }

  if (shot.endFrameMode === 'bridge') {
    throw new Error(`Keyframe "${keyframeId}" is already using a bridge frame.`)
  }

  const { nextShot } = getAdjacentShots(shots, shotId)

  if (!nextShot) {
    throw new Error(`Shot "${shotId}" has no next shot to bridge to.`)
  }

  const nextShotStart = getPlannedShotKeyframe(nextShot, 'start')

  if (!nextShotStart) {
    throw new Error(
      `Shot "${shotId}" cannot bridge because next shot "${nextShot.shotId}" has no planned start keyframe.`,
    )
  }

  const nextShots = shots.map((entry) =>
    entry.shotId === shotId
      ? {
          ...entry,
          endFrameMode: 'bridge' as const,
        }
      : entry,
  )

  await writeShotPromptsFile(nextShots, cwd)

  return getKeyframeArtifactDescriptor({ keyframeId, shotId })
}

async function unbridgeOmittedEndKeyframe(
  keyframeId: string,
  cwd: string,
): Promise<ArtifactDescriptor> {
  const shots = await loadShotPrompts(cwd)
  const match = getShotByCanonicalKeyframeId(shots, keyframeId)

  if (!match) {
    throw new Error(`Keyframe "${keyframeId}" does not map to an existing shot.`)
  }

  const { shot, frameType, shotId } = match

  if (frameType !== 'end') {
    throw new Error(`Only bridged end keyframes can be unbridged.`)
  }

  if (shot.endFrameMode !== 'bridge') {
    throw new Error(`Keyframe "${keyframeId}" is not currently using a bridge frame.`)
  }

  const nextShots = shots.map((entry) =>
    entry.shotId === shotId
      ? {
          ...entry,
          endFrameMode: undefined,
        }
      : entry,
  )

  await writeShotPromptsFile(nextShots, cwd)

  return getKeyframeArtifactDescriptor({ keyframeId, shotId })
}

async function loadShotArtifactsOrEmpty(cwd: string) {
  try {
    return await loadShotArtifacts(cwd)
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
      return []
    }

    throw error
  }
}

function renderTabs(activeTab: Tab) {
  const tabs: { id: Tab; label: string; href: string }[] = [
    { id: 'idea', label: 'Idea', href: '/idea' },
    { id: 'story', label: 'Story', href: '/story' },
    { id: 'characters', label: 'Characters', href: '/' },
    { id: 'storyboard', label: 'Storyboard', href: '/storyboard' },
    { id: 'timeline', label: 'Timeline', href: '/timeline' },
  ]

  return `
    <nav class="tabs">
      ${tabs
        .map(
          (tab) =>
            `<a class="tab${tab.id === activeTab ? ' tab-active' : ''}" href="${tab.href}">${escapeHtml(tab.label)}</a>`,
        )
        .join('')}
    </nav>
  `
}

function renderPage(
  activeTab: Tab,
  content: string,
  options: {
    autoRefresh?: boolean
    embedded?: boolean
    refreshParentDetailUrl?: string | null
  } = {},
) {
  const refreshTag = options.autoRefresh ? '<meta http-equiv="refresh" content="2">' : ''
  const bodyClass = options.embedded ? 'page-embedded' : ''
  const boardClass = options.embedded ? 'board board-embedded' : 'board'
  const refreshParentScript =
    options.embedded && options.refreshParentDetailUrl
      ? `
    <script>
      window.addEventListener('load', function () {
        if (window.parent === window) {
          return;
        }

        window.parent.postMessage(
          {
            type: 'artifact-review-refresh',
            detailUrl: ${JSON.stringify(options.refreshParentDetailUrl)},
          },
          window.location.origin,
        );
      });
    </script>`
      : ''

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    ${refreshTag}
    <title>Artifact Review</title>
    <style>
      :root {
        --bg: #090b0f;
        --panel: #11151d;
        --panel-strong: #171c26;
        --line: rgba(255,255,255,0.08);
        --text: #e7eef7;
        --muted: #94a4ba;
        --soft: #6c7c92;
        --accent: #9fe870;
        --accent-2: #7dd3fc;
        --warn: #f8c44f;
        --error: #f87373;
      }

      * { box-sizing: border-box; margin: 0; padding: 0; }

      body {
        min-height: 100vh;
        background:
          radial-gradient(circle at top left, rgba(125,211,252,0.14), transparent 35%),
          radial-gradient(circle at top right, rgba(159,232,112,0.09), transparent 32%),
          linear-gradient(180deg, #0b0f15 0%, #090b0f 100%);
        color: var(--text);
        font-family: "Helvetica Neue", Helvetica, sans-serif;
        -webkit-font-smoothing: antialiased;
      }

      body.page-embedded {
        min-height: auto;
        background: transparent;
      }

      a { color: inherit; }

      .board {
        max-width: 1320px;
        margin: 0 auto;
        padding: 28px 20px 36px;
        display: flex;
        flex-direction: column;
        gap: 20px;
      }

      .board-embedded {
        max-width: none;
        margin: 0;
        padding: 0;
      }

      .tabs {
        display: flex;
        gap: 6px;
        padding: 6px;
        border: 1px solid var(--line);
        border-radius: 999px;
        background: rgba(255,255,255,0.02);
        width: fit-content;
      }

      .tab {
        padding: 10px 16px;
        font-size: 12px;
        font-weight: 700;
        letter-spacing: 0.08em;
        text-transform: uppercase;
        text-decoration: none;
        color: var(--soft);
        border-radius: 999px;
      }

      .tab:hover { color: var(--text); }

      .tab-active {
        background: rgba(159,232,112,0.12);
        color: var(--accent);
      }

      .stack {
        display: flex;
        flex-direction: column;
        gap: 18px;
      }

      .hero {
        display: flex;
        justify-content: space-between;
        align-items: flex-start;
        gap: 16px;
        padding: 20px;
        border: 1px solid var(--line);
        border-radius: 18px;
        background:
          linear-gradient(180deg, rgba(255,255,255,0.04), rgba(255,255,255,0.01)),
          var(--panel);
      }

      .hero-copy {
        display: flex;
        flex-direction: column;
        gap: 8px;
      }

      .hero-label {
        font-size: 11px;
        letter-spacing: 0.12em;
        text-transform: uppercase;
        color: var(--soft);
      }

      .hero-title {
        font-size: clamp(24px, 3vw, 34px);
        line-height: 1.05;
        letter-spacing: -0.04em;
      }

      .hero-subtitle {
        max-width: 760px;
        color: var(--muted);
        font-size: 14px;
        line-height: 1.55;
      }

      .summary-grid {
        display: grid;
        gap: 18px;
      }

      .character-grid {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
        gap: 18px;
      }

      .shot-review-grid {
        display: flex;
        flex-direction: column;
        gap: 18px;
      }

      .character-card,
      .shot-review-card,
      .summary-card,
      .detail-layout,
      .panel,
      .storyboard-panel,
      .job-banner {
        border: 1px solid var(--line);
        border-radius: 18px;
        background:
          linear-gradient(180deg, rgba(255,255,255,0.03), rgba(255,255,255,0.01)),
          var(--panel);
        overflow: hidden;
      }

      .detail-layout {
        display: grid;
        grid-template-columns: minmax(0, 1.45fr) minmax(320px, 0.85fr);
      }

      .panel,
      .summary-card,
      .job-banner {
        padding: 18px;
      }

      .character-card {
        text-decoration: none;
        display: flex;
        flex-direction: column;
      }

      .character-visual,
      .detail-visual,
      .storyboard-visual,
      .shot-review-visual,
      .slot-visual {
        position: relative;
        background: var(--panel-strong);
        border: 1px solid rgba(255,255,255,0.05);
        overflow: hidden;
      }

      .character-visual { aspect-ratio: 1; margin: 14px 14px 0; border-radius: 14px; }
      .detail-visual,
      .storyboard-visual,
      .shot-review-visual,
      .slot-visual { aspect-ratio: 16 / 9; border-radius: 16px; }

      .detail-main {
        padding: 18px;
        display: flex;
        flex-direction: column;
        gap: 18px;
        min-width: 0;
      }

      .detail-side {
        padding: 18px;
        border-left: 1px solid var(--line);
        display: flex;
        flex-direction: column;
        gap: 18px;
      }

      img,
      video {
        display: block;
        width: 100%;
        height: 100%;
      }

      img { object-fit: cover; }

      .storyboard-visual img,
      .detail-visual img,
      .shot-review-visual video { object-fit: contain; background: #080a0d; }

      .placeholder {
        width: 100%;
        height: 100%;
        display: grid;
        place-items: center;
        padding: 18px;
        text-align: center;
        color: var(--soft);
        font-size: 13px;
        background-color: #0d1116;
      }

      .placeholder-missing {
        color: rgba(215, 227, 241, 0.84);
        background:
          linear-gradient(135deg, rgba(159,232,112,0.12), transparent 38%),
          repeating-linear-gradient(
            -45deg,
            rgba(255,255,255,0.05),
            rgba(255,255,255,0.05) 10px,
            transparent 10px,
            transparent 20px
          ),
          linear-gradient(180deg, rgba(12,15,20,0.98), rgba(9,12,16,0.98));
        box-shadow:
          inset 0 0 0 1px rgba(159,232,112,0.14),
          inset 0 24px 40px rgba(255,255,255,0.02);
      }

      .placeholder-omitted {
        color: rgba(168, 181, 165, 0.72);
        background:
          radial-gradient(circle at 22% 20%, rgba(126, 146, 120, 0.08), transparent 0 24%),
          radial-gradient(circle at 78% 78%, rgba(98, 116, 96, 0.06), transparent 0 22%),
          linear-gradient(180deg, rgba(11,14,15,0.97), rgba(9,11,12,0.97));
        box-shadow: inset 0 0 0 1px rgba(168, 181, 165, 0.05);
      }

      .card-copy,
      .meta-stack,
      .storyboard-copy {
        display: flex;
        flex-direction: column;
        gap: 10px;
      }

      .card-copy {
        padding: 14px;
      }

      .eyebrow {
        font-size: 11px;
        font-weight: 700;
        letter-spacing: 0.1em;
        text-transform: uppercase;
        color: var(--soft);
      }

      .title {
        font-size: 16px;
        font-weight: 700;
        line-height: 1.2;
      }

      .muted {
        color: var(--muted);
        font-size: 13px;
        line-height: 1.55;
      }

      .small {
        color: var(--soft);
        font-size: 12px;
        line-height: 1.45;
      }

      .pill-row {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
      }

      .pill {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        padding: 7px 10px;
        border-radius: 999px;
        border: 1px solid var(--line);
        background: rgba(255,255,255,0.03);
        font-size: 11px;
        font-weight: 700;
        letter-spacing: 0.08em;
        text-transform: uppercase;
        color: var(--muted);
      }

      .pill-accent { color: var(--accent); background: rgba(159,232,112,0.1); }
      .pill-info { color: var(--accent-2); background: rgba(125,211,252,0.1); }
      .pill-warn { color: var(--warn); background: rgba(248,196,79,0.12); }
      .pill-error { color: var(--error); background: rgba(248,115,115,0.12); }

      .summary-actions,
      .form-actions,
      .version-actions {
        display: flex;
        flex-wrap: wrap;
        gap: 10px;
      }

      .button,
      button {
        appearance: none;
        border: 1px solid var(--line);
        background: rgba(255,255,255,0.03);
        color: var(--text);
        font: inherit;
        font-size: 12px;
        font-weight: 700;
        letter-spacing: 0.08em;
        text-transform: uppercase;
        padding: 11px 14px;
        border-radius: 999px;
        text-decoration: none;
        cursor: pointer;
      }

      .button-primary,
      button.button-primary {
        background: rgba(159,232,112,0.12);
        color: var(--accent);
      }

      .button-secondary,
      button.button-secondary {
        background: rgba(125,211,252,0.11);
        color: var(--accent-2);
      }

      .button-danger,
      button.button-danger {
        background: rgba(248,115,115,0.12);
        color: var(--error);
      }

      button:disabled { opacity: 0.45; cursor: not-allowed; }

      .storyboard-panel {
        display: grid;
        grid-template-columns: minmax(0, 1.25fr) minmax(300px, 0.9fr);
      }

      .storyboard-editor-layout {
        display: grid;
        grid-template-columns: minmax(0, 1fr) minmax(320px, 380px);
        gap: 18px;
        align-items: start;
      }

      .storyboard-editor-pane {
        display: flex;
        flex-direction: column;
        gap: 18px;
      }

      .storyboard-grid-panel {
        padding: 18px;
        display: flex;
        flex-direction: column;
        gap: 14px;
        min-width: 0;
      }

      .storyboard-grid {
        display: grid;
        grid-template-columns: repeat(3, minmax(0, 1fr));
        gap: 12px;
        align-items: start;
      }

      .storyboard-slot {
        display: grid;
        gap: 8px;
        min-width: 0;
      }

      .storyboard-slot-single {
        grid-column: span 1;
        grid-template-columns: minmax(0, 1fr);
      }

      .storyboard-slot-paired {
        grid-column: span 2;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        padding: 6px;
        border: 1px solid rgba(255,255,255,0.06);
        border-radius: 20px;
        background:
          linear-gradient(180deg, rgba(255,255,255,0.03), rgba(255,255,255,0.015)),
          rgba(255,255,255,0.02);
      }

      .storyboard-thumb {
        display: block;
        min-width: 0;
        border-radius: 18px;
        border: 1px solid rgba(255,255,255,0.06);
        background: rgba(255,255,255,0.02);
        text-decoration: none;
        overflow: hidden;
      }

      .storyboard-thumb:hover {
        border-color: rgba(125,211,252,0.34);
      }

      .storyboard-thumb-active {
        border-color: rgba(159,232,112,0.42);
        box-shadow:
          inset 0 0 0 1px rgba(159,232,112,0.14),
          0 8px 18px rgba(10, 15, 10, 0.28);
      }

      .storyboard-thumb-empty {
        border-style: dashed;
      }

      .storyboard-thumb-media {
        position: relative;
        aspect-ratio: 16 / 9;
        border-radius: 14px;
        background: var(--panel-strong);
        overflow: hidden;
      }

      .storyboard-thumb-add {
        display: grid;
        place-items: center;
        padding: 18px;
        border: 1px dashed rgba(255,255,255,0.12);
      }

      .storyboard-thumb-add-icon {
        display: grid;
        place-items: center;
        width: 44px;
        height: 44px;
        border-radius: 999px;
        border: 1px solid rgba(255,255,255,0.14);
        background: rgba(255,255,255,0.03);
        color: var(--soft);
        font-size: 26px;
        line-height: 1;
      }

      .storyboard-visual,
      .storyboard-copy {
        padding: 18px;
      }

      .storyboard-markdown {
        min-height: 280px;
        border-radius: 14px;
        border: 1px solid rgba(255,255,255,0.05);
        background: rgba(255,255,255,0.02);
        padding: 14px;
        font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
        white-space: pre-wrap;
        overflow-wrap: anywhere;
        color: var(--muted);
        font-size: 12px;
        line-height: 1.6;
      }

      .artifact-meta-bar {
        padding: 14px 16px;
        border: 1px solid rgba(255,255,255,0.05);
        border-radius: 16px;
        background:
          linear-gradient(180deg, rgba(255,255,255,0.04), rgba(255,255,255,0.02)),
          rgba(255,255,255,0.015);
      }

      .version-rail-shell {
        padding: 12px;
      }

      .version-rail {
        display: flex;
        gap: 12px;
        overflow-x: auto;
        overscroll-behavior-x: contain;
        padding-bottom: 2px;
        scrollbar-width: thin;
      }

      .version-tile {
        flex: 0 0 196px;
        display: block;
        padding: 0;
        border-radius: 16px;
        border: 1px solid rgba(255,255,255,0.06);
        background:
          linear-gradient(180deg, rgba(255,255,255,0.04), rgba(255,255,255,0.02)),
          rgba(255,255,255,0.02);
        text-decoration: none;
        transition:
          transform 120ms ease,
          border-color 120ms ease,
          background-color 120ms ease;
      }

      .version-tile:hover {
        border-color: rgba(125,211,252,0.34);
      }

      .version-tile-active {
        border-color: rgba(159,232,112,0.42);
        background:
          linear-gradient(180deg, rgba(159,232,112,0.14), rgba(255,255,255,0.02)),
          rgba(255,255,255,0.025);
      }

      .version-tile-current {
        box-shadow: inset 0 0 0 1px rgba(125,211,252,0.12);
      }

      .version-visual {
        position: relative;
        aspect-ratio: 16 / 9;
        border-radius: 15px;
        background: var(--panel-strong);
        overflow: hidden;
      }

      .version-media {
        object-fit: contain;
        background: #080a0d;
      }

      .version-badges {
        position: absolute;
        top: 10px;
        right: 10px;
        display: flex;
        flex-direction: column;
        align-items: flex-end;
        gap: 6px;
        z-index: 1;
      }

      .version-badges .pill {
        padding: 6px 8px;
        font-size: 10px;
        background: rgba(17,21,29,0.78);
        backdrop-filter: blur(8px);
      }

      .detail-side-nav {
        display: flex;
        flex-wrap: wrap;
        gap: 10px;
      }

      .shot {
        display: grid;
        grid-template-columns: 90px 1fr;
        gap: 16px;
      }

      .shot-id {
        padding-top: 8px;
        color: var(--soft);
        font-size: 11px;
        font-weight: 700;
        letter-spacing: 0.1em;
        text-transform: uppercase;
        text-align: right;
      }

      .shot-frames {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(230px, 1fr));
        gap: 14px;
      }

      .slot {
        display: flex;
        flex-direction: column;
        gap: 8px;
      }

      .slot-link,
      .card-link {
        text-decoration: none;
      }

      .shot-review-layout {
        display: grid;
        grid-template-columns: minmax(0, 1.2fr) minmax(260px, 0.9fr);
        gap: 18px;
        padding: 18px;
      }

      .shot-review-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        gap: 12px;
        padding: 16px 18px 0;
      }

      .shot-meta-grid {
        display: grid;
        gap: 10px;
      }

      .shot-meta-item {
        display: flex;
        justify-content: space-between;
        gap: 12px;
        padding-bottom: 10px;
        border-bottom: 1px solid rgba(255,255,255,0.06);
      }

      .section-title {
        font-size: 13px;
        font-weight: 700;
        letter-spacing: 0.08em;
        text-transform: uppercase;
        color: var(--soft);
      }

      .reference-list {
        display: flex;
        flex-direction: column;
        gap: 10px;
      }

      .reference-item {
        padding: 14px;
        border-radius: 14px;
        border: 1px solid rgba(255,255,255,0.05);
        background: rgba(255,255,255,0.02);
      }

      .reference-item-title {
        font-size: 13px;
        font-weight: 700;
        color: var(--text);
      }

      .reference-item-path {
        color: var(--accent-2);
        font-size: 12px;
        word-break: break-word;
      }

      form {
        display: flex;
        flex-direction: column;
        gap: 12px;
      }

      textarea,
      input[type="text"],
      select {
        width: 100%;
        border: 1px solid rgba(255,255,255,0.08);
        border-radius: 14px;
        background: rgba(255,255,255,0.02);
        color: var(--text);
        font: inherit;
        padding: 14px;
      }

      select {
        appearance: none;
      }

      textarea {
        min-height: 150px;
        resize: vertical;
        line-height: 1.55;
      }

      .form-grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
        gap: 12px;
      }

      .form-field {
        display: grid;
        grid-template-columns: auto minmax(0, 1fr);
        align-items: center;
        gap: 12px;
      }

      .field-label {
        font-size: 12px;
        font-weight: 700;
        color: var(--text);
        white-space: nowrap;
      }

      .camera-override-shell {
        display: flex;
        flex-direction: column;
        gap: 12px;
      }

      .job-banner {
        display: flex;
        flex-direction: column;
        gap: 14px;
      }

      .empty-state {
        padding: 20px;
        border: 1px dashed rgba(255,255,255,0.12);
        border-radius: 14px;
        color: var(--soft);
        background: rgba(255,255,255,0.015);
      }

      .form-note {
        color: var(--soft);
        font-size: 12px;
        line-height: 1.45;
      }

      .spacer {
        height: 4px;
      }

      @media (max-width: 980px) {
        .detail-layout,
        .storyboard-panel,
        .shot-review-layout,
        .storyboard-editor-layout {
          grid-template-columns: 1fr;
        }

        .detail-side {
          border-left: none;
          border-top: 1px solid var(--line);
        }

        .artifact-meta-bar { padding: 14px; }
        .storyboard-grid {
          grid-template-columns: repeat(2, minmax(0, 1fr));
        }
      }

      @media (max-width: 720px) {
        .board { padding: 16px; }
        .hero { flex-direction: column; }
        .shot { grid-template-columns: 1fr; }
        .shot-id { text-align: left; }
        .character-grid { grid-template-columns: 1fr 1fr; }
        .version-tile { flex-basis: 170px; }
        .storyboard-grid { grid-template-columns: 1fr; }
        .storyboard-slot-paired { grid-column: span 1; }
      }
    </style>
  </head>
  <body class="${bodyClass}">
    <div class="${boardClass}">
      ${options.embedded ? '' : renderTabs(activeTab)}
      ${content}
    </div>
    ${refreshParentScript}
  </body>
</html>`
}

function redirectTo(location: string, status = 303) {
  return new Response(null, {
    status,
    headers: {
      location,
    },
  })
}

function renderHero(title: string, subtitle: string, eyebrow: string, actions = '') {
  return `
    <section class="hero">
      <div class="hero-copy">
        <p class="hero-label">${escapeHtml(eyebrow)}</p>
        <h1 class="hero-title">${escapeHtml(title)}</h1>
        <p class="hero-subtitle">${escapeHtml(subtitle)}</p>
      </div>
      ${actions}
    </section>
  `
}

function renderErrorPage(activeTab: Tab, title: string, message: string, backHref: string) {
  return new Response(
    renderPage(
      activeTab,
      `<div class="stack">
        ${renderHero(title, message, 'Review Error', `<div class="summary-actions"><a class="button button-secondary" href="${backHref}">Back</a></div>`)}
      </div>`,
    ),
    {
      status: 404,
      headers: HTML_HEADERS,
    },
  )
}

function formatDurationSeconds(durationSeconds: number) {
  return Number.isInteger(durationSeconds)
    ? `${durationSeconds}s`
    : `${durationSeconds.toFixed(1)}s`
}

function renderPlaceholder(label: string, variant: PlaceholderVariant = 'missing') {
  return `<div class="placeholder placeholder-${variant}">${escapeHtml(label)}</div>`
}

function renderMediaBlock(options: {
  mediaType: 'image' | 'video'
  mediaUrl: string | null
  mediaExists: boolean
  alt: string
  placeholder: string
  placeholderVariant?: PlaceholderVariant
  className: string
}) {
  if (!options.mediaUrl || !options.mediaExists) {
    return renderPlaceholder(options.placeholder, options.placeholderVariant)
  }

  if (options.mediaType === 'video') {
    return `<video class="${options.className}" src="${options.mediaUrl}" controls preload="metadata" playsinline></video>`
  }

  return `<img class="${options.className}" src="${options.mediaUrl}" alt="${escapeHtml(options.alt)}" loading="lazy">`
}

function buildReferenceEditorValue(references: ArtifactReferenceEntry[]) {
  return `${JSON.stringify(references, null, 2)}`
}

function buildVersionRailItems(context: ArtifactDetailContext): VersionRailItem[] {
  return [
    {
      versionId: CURRENT_BASE_VERSION_ID,
      label: 'Current',
      href: getArtifactDetailPath(context.descriptor),
      mediaUrl: getCanonicalMediaUrl(context.descriptor),
      mediaExists: context.historyState.currentExists,
      isActive: context.historyState.isViewingCurrent,
      isCurrent: true,
    },
    ...context.historyState.versions.map((version) => ({
      versionId: version.versionId,
      label: version.versionId.toUpperCase(),
      href: `${getArtifactDetailPath(context.descriptor)}?version=${encodeURIComponent(version.versionId)}`,
      mediaUrl: getArtifactVersionMediaUrl(context.descriptor, version.versionId),
      mediaExists: true,
      isActive: context.historyState.activeVersionId === version.versionId,
      isCurrent: false,
    })),
  ]
}

function renderVersionRailMedia(context: ArtifactDetailContext, item: VersionRailItem) {
  if (!item.mediaUrl || !item.mediaExists) {
    return renderPlaceholder(context.mediaPlaceholder, context.mediaPlaceholderVariant)
  }

  if (context.mediaType === 'video') {
    return `<video class="version-media" src="${item.mediaUrl}" muted autoplay loop playsinline preload="metadata"></video>`
  }

  return `<img class="version-media" src="${item.mediaUrl}" alt="${escapeHtml(`${context.title} ${item.label}`)}" loading="lazy">`
}

function renderVersionRail(context: ArtifactDetailContext, options: { embedded?: boolean } = {}) {
  const items = buildVersionRailItems(context)

  return `
    <section class="panel version-rail-shell">
      <div class="version-rail">
        ${items
          .map((item) => {
            const tileClass = [
              'version-tile',
              item.isActive ? 'version-tile-active' : '',
              item.isCurrent ? 'version-tile-current' : '',
            ]
              .filter(Boolean)
              .join(' ')

            return `
              <a
                class="${tileClass}"
                href="${getEmbeddedActionHref(item.href, options.embedded)}"
                data-version-id="${escapeHtml(item.versionId)}"
              >
                <div class="version-visual">
                  <div class="version-badges">
                    <span class="pill ${item.isCurrent ? 'pill-info' : ''}">${escapeHtml(item.label)}</span>
                    ${item.isActive ? '<span class="pill pill-accent">Viewing</span>' : ''}
                  </div>
                  ${renderVersionRailMedia(context, item)}
                </div>
              </a>
            `
          })
          .join('')}
      </div>
    </section>
  `
}

function renderReferenceList(references: readonly ResolvedArtifactReference[]) {
  if (references.length === 0) {
    return '<div class="empty-state">No retained references recorded for this version yet.</div>'
  }

  return `
    <div class="reference-list">
      ${references
        .map((reference) => {
          const summary = summarizeReference(reference)
          const toneClass = reference.source === 'user' ? 'pill-info' : 'pill'

          return `
            <div class="reference-item">
              <div class="pill-row">
                <span class="pill ${toneClass}">${escapeHtml(reference.source)}</span>
                ${reference.kind ? `<span class="pill">${escapeHtml(reference.kind)}</span>` : ''}
              </div>
              <div class="spacer"></div>
              <p class="reference-item-title">${escapeHtml(summary.title)}</p>
              <p class="reference-item-path">${escapeHtml(summary.subtitle)}</p>
              <p class="small">${escapeHtml(summary.detail)}</p>
            </div>
          `
        })
        .join('')}
    </div>
  `
}

function renderReferenceEditor(
  actionUrl: string,
  references: ArtifactReferenceEntry[],
  editable: boolean,
  helpText: string,
) {
  return `
    <section class="panel">
      <p class="section-title">Source References</p>
      <p class="form-note">${escapeHtml(helpText)}</p>
      <form method="post" action="${actionUrl}">
        <textarea name="referencesJson" spellcheck="false" ${editable ? '' : 'disabled'}>${escapeHtml(buildReferenceEditorValue(references))}</textarea>
        <div class="form-actions">
          <button class="button-primary" type="submit" ${editable ? '' : 'disabled'}>Save references</button>
        </div>
      </form>
    </section>
  `
}

function renderArtifactMeta(context: ArtifactDetailContext) {
  if (context.cameraControl) {
    return `
      <section class="artifact-meta-bar">
        <p class="section-title">Current Camera Plan</p>
        <div class="pill-row">
          ${context.cameraControl.fields
            .map(
              (field) =>
                `<span class="pill">${escapeHtml(field.label)}: ${escapeHtml(field.currentLabel)}</span>`,
            )
            .join('')}
        </div>
      </section>
    `
  }

  return `
    <section class="artifact-meta-bar">
      <p class="muted">${escapeHtml(context.subtitle)}</p>
    </section>
  `
}

function renderDetailSideNav(context: ArtifactDetailContext, options: { embedded?: boolean } = {}) {
  if (options.embedded) {
    return ''
  }

  if (context.summaryHref === getArtifactDetailPath(context.descriptor)) {
    return ''
  }

  return `
    <div class="detail-side-nav">
      <a class="button button-secondary" href="${context.summaryHref}">${escapeHtml(context.summaryLabel)}</a>
    </div>
  `
}

function renderJobBanner(job: ArtifactJobState | null) {
  if (!job) {
    return ''
  }

  const toneClass =
    job.status === 'running' ? 'pill-info' : job.status === 'success' ? 'pill-accent' : 'pill-error'

  return `
    <section class="job-banner">
      <div class="pill-row">
        <span class="pill ${toneClass}">${escapeHtml(job.status)}</span>
        ${job.versionId ? `<span class="pill">${escapeHtml(job.versionId)}</span>` : ''}
      </div>
      <p class="muted">${escapeHtml(job.message)}</p>
      <p class="small">Started ${escapeHtml(job.startedAt)}${job.completedAt ? ` • Finished ${escapeHtml(job.completedAt)}` : ''}</p>
    </section>
  `
}

function renderHistoricalVersionActions(
  context: ArtifactDetailContext,
  options: { embedded?: boolean } = {},
) {
  const activeVersion = context.historyState.activeVersion

  if (!activeVersion || context.historyState.isViewingCurrent) {
    return ''
  }

  const deleteMessage = `Delete retained version ${activeVersion.versionId}? This cannot be undone.`

  return `
    <section class="panel">
      <p class="section-title">Historical Version</p>
      <p class="form-note">You are viewing retained ${escapeHtml(activeVersion.versionId)} from ${escapeHtml(activeVersion.createdAt)}. Promote it to the public artifact, return to the current selection, or delete this retained version.</p>
      <div class="version-actions">
        <form method="post" action="${getEmbeddedActionHref(getArtifactSelectActionPath(context.descriptor), options.embedded)}">
          <input type="hidden" name="versionId" value="${escapeHtml(activeVersion.versionId)}">
          <button class="button-primary" type="submit">Make current</button>
        </form>
        <a class="button button-secondary" href="${getEmbeddedActionHref(getArtifactDetailPath(context.descriptor), options.embedded)}">Go to current</a>
        <form method="post" action="${getEmbeddedActionHref(getArtifactDeleteActionPath(context.descriptor), options.embedded)}" onsubmit="return window.confirm(${escapeHtml(JSON.stringify(deleteMessage))})">
          <input type="hidden" name="versionId" value="${escapeHtml(activeVersion.versionId)}">
          <button class="button-danger" type="submit">Delete</button>
        </form>
      </div>
    </section>
  `
}

function renderEditComposer(context: ArtifactDetailContext, options: { embedded?: boolean } = {}) {
  if (!context.primaryAction) {
    return ''
  }

  if (context.primaryAction.kind === 'generate') {
    return `
      <section class="panel">
        <p class="section-title">Render</p>
        <p class="form-note">Render the currently planned storyboard image with the configured fast storyboard model.</p>
        <form method="post" action="${getEmbeddedActionHref(context.primaryAction.actionUrl, options.embedded)}">
          <div class="form-actions">
            <button class="button-primary" type="submit" ${context.primaryAction.enabled ? '' : 'disabled'}>Render image</button>
          </div>
        </form>
      </section>
    `
  }

  if (context.primaryAction.kind === 'create-keyframe') {
    return `
      <section class="panel">
        <p class="section-title">Create Keyframe</p>
        <p class="form-note">Add this omitted anchor by writing a full fresh prompt. The prompt is saved to the new sidecar before generation starts.</p>
        <form method="post" action="${getEmbeddedActionHref(context.primaryAction.actionUrl, options.embedded)}">
          <textarea name="prompt" placeholder="Write the full prompt for this new keyframe." required></textarea>
          <div class="form-actions">
            <button class="button-primary" type="submit">Create keyframe</button>
          </div>
        </form>
      </section>
    `
  }

  if (!context.primaryAction.enabled) {
    return `
      <section class="panel">
        <p class="section-title">Regenerate</p>
        <div class="empty-state">A current or retained artifact is required before regeneration can start.</div>
      </section>
    `
  }

  const requestRequired = context.cameraControl ? '' : 'required'
  return `
    <section class="panel">
      <p class="section-title">Regenerate</p>
      <form method="post" action="${getEmbeddedActionHref(context.primaryAction.actionUrl, options.embedded)}">
        <input type="hidden" name="baseVersionId" value="${escapeHtml(context.historyState.activeVersionId ?? CURRENT_BASE_VERSION_ID)}">
        <textarea name="regenerateRequest" placeholder="Describe the precise change you want from the version you are viewing." ${requestRequired}></textarea>
        ${context.cameraControl ? renderCameraOverrideControls(context.cameraControl) : ''}
        <div class="form-actions">
          <button class="button-primary" type="submit">Regenerate</button>
        </div>
      </form>
    </section>
  `
}

function renderAnchorPlanningAction(
  context: ArtifactDetailContext,
  options: { embedded?: boolean } = {},
) {
  if (!context.anchorPlanningAction) {
    return ''
  }

  const buttonClass =
    context.anchorPlanningAction.buttonTone === 'danger' ? 'button-danger' : 'button-secondary'

  return `
    <section class="panel">
      <p class="section-title">Anchor Planning</p>
      <p class="form-note">${escapeHtml(context.anchorPlanningAction.helpText)}</p>
      <form
        method="post"
        action="${getEmbeddedActionHref(context.anchorPlanningAction.actionUrl, options.embedded)}"
        ${context.anchorPlanningAction.confirmMessage ? `onsubmit="return window.confirm(${escapeHtml(JSON.stringify(context.anchorPlanningAction.confirmMessage))})"` : ''}
      >
        <button class="${buttonClass}" type="submit" ${context.anchorPlanningAction.enabled ? '' : 'disabled'}>${escapeHtml(context.anchorPlanningAction.buttonLabel)}</button>
      </form>
    </section>
  `
}

function renderDetailPage(
  context: ArtifactDetailContext,
  job: ArtifactJobState | null,
  options: { embedded?: boolean; refreshParentDetailUrl?: string | null } = {},
) {
  const content = `
    <div class="stack">
      ${renderVersionRail(context, options)}
      ${renderJobBanner(job)}
      <section class="detail-layout">
        <div class="detail-main">
          <div class="detail-visual">
            ${renderMediaBlock({
              mediaType: context.mediaType,
              mediaUrl: context.mediaUrl,
              mediaExists: context.mediaExists,
              alt: context.title,
              placeholder: context.mediaPlaceholder,
              placeholderVariant: context.mediaPlaceholderVariant,
              className: '',
            })}
          </div>
          ${renderArtifactMeta(context)}
          <section class="panel">
            <p class="section-title">Source Prompt</p>
            <div class="meta-stack">
              <p class="muted">${escapeHtml(context.sourcePrompt ?? 'No source prompt available for this artifact.')}</p>
              ${context.sourceModel ? `<p class="small">Model: ${escapeHtml(context.sourceModel)}</p>` : ''}
            </div>
          </section>
          ${context.notesHtml}
        </div>
        <div class="detail-side">
          ${renderDetailSideNav(context, options)}
          ${renderHistoricalVersionActions(context, options)}
          ${renderEditComposer(context, options)}
          ${renderAnchorPlanningAction(context, options)}
          ${context.extraSideHtml ?? ''}
          ${renderReferenceEditor(
            getEmbeddedActionHref(
              getArtifactReferencesActionPath(context.descriptor),
              options.embedded,
            ),
            context.sourceReferences,
            context.canEditReferences,
            'Edit the source sidecar references as JSON. Use repo-relative paths, required kind, and optional label and notes fields.',
          )}
        </div>
      </section>
    </div>
  `

  return new Response(
    renderPage(context.activeTab, content, {
      autoRefresh: job?.status === 'running',
      embedded: options.embedded,
      refreshParentDetailUrl: options.refreshParentDetailUrl,
    }),
    {
      headers: HTML_HEADERS,
    },
  )
}

function renderCharacterCard(card: CharacterReviewCard) {
  return `
    <a class="character-card" href="/characters/${encodeURIComponent(card.characterId)}">
      <div class="character-visual">
        ${renderMediaBlock({
          mediaType: 'image',
          mediaUrl: card.imageUrl,
          mediaExists: card.imageExists,
          alt: card.displayName,
          placeholder: 'No image',
          className: '',
        })}
      </div>
      <div class="card-copy">
        <p class="eyebrow">${escapeHtml(card.status)}</p>
        <p class="title">${escapeHtml(card.displayName)}</p>
        <p class="muted">${escapeHtml(card.prompt)}</p>
      </div>
    </a>
  `
}

function renderCharactersSummary(cards: CharacterReviewCard[]) {
  return new Response(
    renderPage(
      'characters',
      `<div class="stack">
        ${renderHero('Characters', 'Open a character to inspect the current image, retained history, and source references.', 'Review Surface')}
        ${
          cards.length === 0
            ? '<div class="empty-state">No characters yet.</div>'
            : `<div class="character-grid">${cards.map(renderCharacterCard).join('')}</div>`
        }
      </div>`,
    ),
    {
      headers: HTML_HEADERS,
    },
  )
}

function renderStoryboardGridTile(tile: StoryboardGridTile) {
  const label = `${tile.storyboardImageId} (${frameTypeLabel(tile.frameType)} frame)`

  return `
    <a
      class="${['storyboard-thumb', tile.isSelected ? 'storyboard-thumb-active' : ''].filter(Boolean).join(' ')}"
      href="${appendSearchParams('/storyboard', { image: tile.selectionId })}"
      aria-label="${escapeHtml(label)}"
      title="${escapeHtml(label)}"
    >
      <div class="storyboard-thumb-media">
        ${renderMediaBlock({
          mediaType: 'image',
          mediaUrl: tile.imageUrl,
          mediaExists: tile.imageExists,
          alt: tile.storyboardImageId,
          placeholder: '',
          className: 'version-media',
        })}
      </div>
    </a>
  `
}

function renderStoryboardGridSlot(slot: StoryboardGridSlot) {
  return `
    <div class="${['storyboard-slot', slot.isPaired ? 'storyboard-slot-paired' : 'storyboard-slot-single'].join(' ')}">
      ${slot.tiles.map(renderStoryboardGridTile).join('')}
    </div>
  `
}

function renderStoryboardAddTile(isSelected: boolean) {
  return `
    <a
      class="${['storyboard-thumb', 'storyboard-thumb-empty', isSelected ? 'storyboard-thumb-active' : ''].filter(Boolean).join(' ')}"
      href="${appendSearchParams('/storyboard', { image: STORYBOARD_NEW_SELECTION_ID })}"
      aria-label="Add storyboard frame"
      title="Add storyboard frame"
    >
      <div class="storyboard-thumb-media storyboard-thumb-add">
        <span class="storyboard-thumb-add-icon" aria-hidden="true">+</span>
      </div>
    </a>
  `
}

function renderStoryboardSummary(options: {
  storyboard: { images: StoryboardImageEntry[] } | null
  config: { fastImageModel: string } | null
  slots: StoryboardGridSlot[]
  selected: StoryboardSelectionState
  selectedCard: StoryboardReviewCard | null
  job: ArtifactJobState | null
}) {
  const selectedEntry = options.selected.selectedEntry
  const references = selectedEntry?.entry.references ?? []
  const pairedEnd = selectedEntry
    ? getStoryboardPairedEnd(options.storyboard, options.selected.selectedImageId)
    : null
  const canInsertEnd = selectedEntry
    ? canInsertStoryboardEnd(options.storyboard, options.selected.selectedImageId)
    : false
  const primaryButtonLabel = options.selected.isNewSelection
    ? 'Add thumbnail'
    : options.selectedCard?.imageExists
      ? 'Regenerate thumbnail'
      : 'Generate thumbnail'
  const saveButtonLabel = options.selected.isNewSelection ? 'Add draft' : 'Save goal'
  const selectionLabel = selectedEntry
    ? `${selectedEntry.shotId} • ${frameTypeLabel(selectedEntry.entry.frameType)} Frame`
    : 'New storyboard start frame'
  const selectionHelp = selectedEntry
    ? selectedEntry.entry.frameType === 'end'
      ? 'This is the optional closing frame for the previous storyboard thumbnail.'
      : pairedEnd
        ? `This start frame is paired with ${pairedEnd.storyboardImageId}.`
        : 'This start frame currently stands on its own.'
    : 'The extra tile stays at the end of the board so you can append a new planned frame.'

  return new Response(
    renderPage(
      'storyboard',
      `<section class="storyboard-editor-layout">
        <div class="panel storyboard-grid-panel">
          <p class="section-title">Board</p>
          <div class="storyboard-grid">
            ${options.slots.map(renderStoryboardGridSlot).join('')}
            ${renderStoryboardAddTile(options.selected.isNewSelection)}
          </div>
        </div>
        <div class="storyboard-editor-pane">
          ${renderJobBanner(options.job)}
          <section class="panel">
            <div class="meta-stack">
              <p class="section-title">${escapeHtml(selectionLabel)}</p>
              <p class="form-note">${escapeHtml(selectionHelp)}</p>
              <p class="small">Each render creates one minimal sketch-style storyboard frame with ${escapeHtml(options.config?.fastImageModel ?? 'the configured fast image model')}.</p>
            </div>
            <form method="post" action="/storyboard/save">
              <input type="hidden" name="selectedImageId" value="${escapeHtml(options.selected.selectedImageId)}">
              <label class="field-label" for="storyboard-goal">Goal</label>
              <textarea id="storyboard-goal" name="goal" required>${escapeHtml(selectedEntry?.entry.goal ?? '')}</textarea>
              <label class="field-label" for="storyboard-references">Source References</label>
              <textarea id="storyboard-references" name="referencesJson" spellcheck="false">${escapeHtml(buildReferenceEditorValue(references))}</textarea>
              ${
                options.selectedCard?.imageExists
                  ? `<label class="field-label" for="storyboard-direction">Direction</label>
              <textarea id="storyboard-direction" name="regenerateRequest" placeholder="Optional. Describe what should change in the existing image."></textarea>`
                  : ''
              }
              <div class="form-actions">
                <button class="button-secondary" type="submit" formaction="/storyboard/save">${escapeHtml(saveButtonLabel)}</button>
                <button class="button-primary" type="submit" formaction="/storyboard/render">${escapeHtml(primaryButtonLabel)}</button>
                <button class="button-secondary" type="submit" formaction="/storyboard/insert-end" ${canInsertEnd ? '' : 'disabled'}>Insert end frame</button>
              </div>
            </form>
          </section>
          ${
            selectedEntry
              ? `
                <section class="panel">
                  <p class="section-title">Delete</p>
                  <p class="form-note">${escapeHtml(
                    selectedEntry.entry.frameType === 'start' && pairedEnd
                      ? 'Deleting this start frame also removes its paired end frame.'
                      : 'Delete the selected storyboard thumbnail from the plan.',
                  )}</p>
                  <form method="post" action="/storyboard/delete" onsubmit="return window.confirm(${escapeHtml(
                    JSON.stringify(
                      selectedEntry.entry.frameType === 'start' && pairedEnd
                        ? `Delete ${selectedEntry.storyboardImageId} and ${pairedEnd.storyboardImageId}?`
                        : `Delete ${selectedEntry.storyboardImageId}?`,
                    ),
                  )})">
                    <input type="hidden" name="selectedImageId" value="${escapeHtml(options.selected.selectedImageId)}">
                    <button class="button-danger" type="submit">Delete thumbnail</button>
                  </form>
                </section>
              `
              : ''
          }
        </div>
      </section>`,
      {
        autoRefresh: options.job?.status === 'running',
      },
    ),
    {
      headers: HTML_HEADERS,
    },
  )
}

async function loadWorkspaceMarkdownDocument(fileName: string, cwd: string) {
  try {
    return await readFile(resolveWorkflowPath(fileName, cwd), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
      return null
    }

    throw error
  }
}

function renderWorkspaceMarkdownDocumentPage(options: {
  activeTab: Tab
  title: string
  eyebrow: string
  subtitle: string
  sectionTitle: string
  markdown: string | null
  emptyState: string
}) {
  return new Response(
    renderPage(
      options.activeTab,
      `<div class="stack">
        ${renderHero(options.title, options.subtitle, options.eyebrow)}
        <section class="panel">
          <p class="section-title">${escapeHtml(options.sectionTitle)}</p>
          ${
            options.markdown
              ? `<pre class="storyboard-markdown">${escapeHtml(options.markdown.trim())}</pre>`
              : `<div class="empty-state">${escapeHtml(options.emptyState)}</div>`
          }
        </section>
      </div>`,
    ),
    {
      headers: HTML_HEADERS,
    },
  )
}

function getArtifactDetailPath(descriptor: ArtifactDescriptor) {
  switch (descriptor.artifactType) {
    case 'storyboard':
      return `/storyboard/images/${encodeURIComponent(descriptor.artifactId)}`
    case 'character':
      return `/characters/${encodeURIComponent(descriptor.artifactId)}`
    case 'keyframe':
      return `/keyframes/${encodeURIComponent(descriptor.artifactId)}`
    case 'shot':
      return `/shots/${encodeURIComponent(descriptor.artifactId)}`
  }
}

function getArtifactReferencesActionPath(descriptor: ArtifactDescriptor) {
  return `${getArtifactDetailPath(descriptor)}/references`
}

function getArtifactRegenerateActionPath(descriptor: ArtifactDescriptor) {
  return `${getArtifactDetailPath(descriptor)}/regenerate`
}

function getArtifactGenerateActionPath(descriptor: ArtifactDescriptor) {
  return `${getArtifactDetailPath(descriptor)}/generate`
}

function getArtifactCreateActionPath(descriptor: ArtifactDescriptor) {
  return `${getArtifactDetailPath(descriptor)}/create`
}

function getArtifactSelectActionPath(descriptor: ArtifactDescriptor) {
  return `${getArtifactDetailPath(descriptor)}/select`
}

function getArtifactDeleteActionPath(descriptor: ArtifactDescriptor) {
  return `${getArtifactDetailPath(descriptor)}/delete`
}

function getArtifactAssignmentActionPath(descriptor: ArtifactDescriptor) {
  return `${getArtifactDetailPath(descriptor)}/assignment`
}

function getStoryboardImageRemoveActionPath(descriptor: ArtifactDescriptor) {
  return `${getArtifactDetailPath(descriptor)}/remove-image`
}

function getArtifactRemoveActionPath(descriptor: ArtifactDescriptor) {
  return `${getArtifactDetailPath(descriptor)}/remove`
}

function getArtifactBridgeActionPath(descriptor: ArtifactDescriptor) {
  return `${getArtifactDetailPath(descriptor)}/bridge`
}

function getArtifactUnbridgeActionPath(descriptor: ArtifactDescriptor) {
  return `${getArtifactDetailPath(descriptor)}/unbridge`
}

function getArtifactVersionMediaUrl(descriptor: ArtifactDescriptor, versionId: string) {
  return `${getArtifactDetailPath(descriptor)}/versions/${encodeURIComponent(versionId)}/media`
}

function getCanonicalMediaUrl(descriptor: ArtifactDescriptor) {
  return `/${encodeAssetUrl(descriptor.publicPath)}`
}

function isCurrentBaseVersionId(versionId: string) {
  return versionId === CURRENT_BASE_VERSION_ID
}

function getBaseVersionMediaPath(descriptor: ArtifactDescriptor, versionId: string) {
  return isCurrentBaseVersionId(versionId)
    ? descriptor.publicPath
    : getArtifactVersionMediaPath(descriptor, versionId)
}

function getCameraOverrideInputName(field: CameraFieldKey) {
  return `cameraOverride${field[0]!.toUpperCase()}${field.slice(1)}`
}

function getCameraOptionLabel(entry: CameraVocabularyEntry) {
  return entry.name
}

function buildCameraOverrideFields<T extends KeyframeCameraSpec | ShotCameraSpec>(
  artifactType: 'keyframe' | 'shot',
  camera: T,
  fields: readonly (keyof T & CameraFieldKey)[],
  vocabulary: CameraVocabularyData,
) {
  return fields.map((field) => {
    const options = vocabulary.entries
      .filter(
        (entry) =>
          entry.category === CAMERA_FIELD_CATEGORIES[field] &&
          (artifactType === 'keyframe' ? entry.appliesToKeyframe : entry.appliesToShot),
      )
      .map<CameraOverrideOption>((entry) => ({
        value: entry.id,
        label: getCameraOptionLabel(entry),
        description: entry.description,
      }))
    const currentValue = String(camera[field])
    const currentLabel =
      options.find((option) => option.value === currentValue)?.label ??
      humanizeCameraValue(currentValue)

    return {
      field,
      label: CAMERA_FIELD_LABELS[field],
      inputName: getCameraOverrideInputName(field),
      currentValue,
      currentLabel,
      options,
    } satisfies CameraOverrideField
  })
}

function buildCameraOverrideControl(
  artifactType: 'keyframe' | 'shot',
  camera: KeyframeCameraSpec | ShotCameraSpec | undefined,
  vocabulary: CameraVocabularyData | null,
): CameraOverrideControl | null {
  if (!vocabulary) {
    return null
  }

  if (artifactType === 'keyframe') {
    const currentCamera = resolveKeyframeCameraSpec(camera as KeyframeCameraSpec | undefined)
    const fields = buildCameraOverrideFields(
      artifactType,
      currentCamera,
      KEYFRAME_CAMERA_FIELDS,
      vocabulary,
    )

    return {
      artifactType,
      fields,
    }
  }

  const currentCamera = resolveShotCameraSpec(camera as ShotCameraSpec | undefined)
  const fields = buildCameraOverrideFields(
    artifactType,
    currentCamera,
    SHOT_CAMERA_FIELDS,
    vocabulary,
  )

  return {
    artifactType,
    fields,
  }
}

function renderCameraOverrideControls(cameraControl: CameraOverrideControl) {
  return `
    <div class="camera-override-shell">
      <p class="section-title">Camera Overrides</p>
      <div class="form-grid">
        ${cameraControl.fields
          .map(
            (field) => `
              <label class="form-field">
                <span class="field-label">${escapeHtml(field.label)}</span>
                <select name="${escapeHtml(field.inputName)}">
                  <option value="">${escapeHtml(`Keep current (${field.currentLabel})`)}</option>
                  ${field.options
                    .map(
                      (option) =>
                        `<option value="${escapeHtml(option.value)}">${escapeHtml(option.label)}</option>`,
                    )
                    .join('')}
                </select>
              </label>
            `,
          )
          .join('')}
      </div>
    </div>
  `
}

function parseCameraOverrideInput(
  formData: FormData,
  cameraControl: CameraOverrideControl | null,
): Partial<ShotCameraSpec> | null {
  if (!cameraControl) {
    return null
  }

  const overrides: Partial<ShotCameraSpec> = {}

  for (const field of cameraControl.fields) {
    const rawValue = String(formData.get(field.inputName) ?? '').trim()

    if (rawValue.length === 0) {
      continue
    }

    if (!field.options.some((option) => option.value === rawValue)) {
      throw new Error(`${field.label} must use a value from CAMERA_VOCABULARY.json.`)
    }

    overrides[field.field] = rawValue
  }

  return Object.keys(overrides).length > 0 ? overrides : null
}

function getCurrentKeyframeCameraFromControl(cameraControl: CameraOverrideControl | null) {
  return resolveKeyframeCameraSpec({
    shotSize: cameraControl?.fields.find((field) => field.field === 'shotSize')?.currentValue,
    cameraPosition: cameraControl?.fields.find((field) => field.field === 'cameraPosition')
      ?.currentValue,
    cameraAngle: cameraControl?.fields.find((field) => field.field === 'cameraAngle')?.currentValue,
  })
}

function getCurrentShotCameraFromControl(cameraControl: CameraOverrideControl | null) {
  return resolveShotCameraSpec({
    shotSize: cameraControl?.fields.find((field) => field.field === 'shotSize')?.currentValue,
    cameraPosition: cameraControl?.fields.find((field) => field.field === 'cameraPosition')
      ?.currentValue,
    cameraAngle: cameraControl?.fields.find((field) => field.field === 'cameraAngle')?.currentValue,
    cameraMovement: cameraControl?.fields.find((field) => field.field === 'cameraMovement')
      ?.currentValue,
  })
}

function orderSidecarFields(
  existing: Record<string, unknown>,
  orderedKeys: readonly string[],
  overrides: Record<string, unknown>,
) {
  const next = {
    ...existing,
    ...overrides,
  }
  const ordered: Record<string, unknown> = {}

  for (const key of orderedKeys) {
    if (next[key] !== undefined) {
      ordered[key] = next[key]
    }
  }

  for (const [key, value] of Object.entries(next)) {
    if (!(key in ordered)) {
      ordered[key] = value
    }
  }

  return ordered
}

function resolveEffectiveKeyframeCamera(
  camera: KeyframeCameraSpec | undefined,
  overrides: Partial<ShotCameraSpec> | null | undefined,
) {
  const resolvedCamera = resolveKeyframeCameraSpec(camera)

  return resolveKeyframeCameraSpec({
    shotSize: overrides?.shotSize ?? resolvedCamera.shotSize,
    cameraPosition: overrides?.cameraPosition ?? resolvedCamera.cameraPosition,
    cameraAngle: overrides?.cameraAngle ?? resolvedCamera.cameraAngle,
  })
}

function resolveEffectiveShotCamera(
  camera: ShotCameraSpec | undefined,
  overrides: Partial<ShotCameraSpec> | null | undefined,
) {
  const resolvedCamera = resolveShotCameraSpec(camera)

  return resolveShotCameraSpec({
    shotSize: overrides?.shotSize ?? resolvedCamera.shotSize,
    cameraPosition: overrides?.cameraPosition ?? resolvedCamera.cameraPosition,
    cameraAngle: overrides?.cameraAngle ?? resolvedCamera.cameraAngle,
    cameraMovement: overrides?.cameraMovement ?? resolvedCamera.cameraMovement,
  })
}

function parseReferenceEditorInput(rawValue: string) {
  const parsed = JSON.parse(rawValue) as unknown

  if (!Array.isArray(parsed)) {
    throw new Error('Reference editor input must be a JSON array.')
  }

  return parsed.map((entry, index) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new Error(`Reference ${index + 1} must be an object.`)
    }

    const object = entry as Record<string, unknown>

    if (typeof object.path !== 'string' || object.path.trim().length === 0) {
      throw new Error(`Reference ${index + 1} must include a non-empty path.`)
    }

    if (typeof object.kind !== 'string' || !AUTHORED_REFERENCE_KINDS.includes(object.kind as any)) {
      throw new Error(
        `Reference ${index + 1} must include a kind from: ${AUTHORED_REFERENCE_KINDS.join(', ')}.`,
      )
    }

    return {
      path: normalizeRepoRelativePath(object.path, `Reference ${index + 1} path`),
      kind: object.kind as ArtifactReferenceEntry['kind'],
      label: typeof object.label === 'string' ? object.label : undefined,
      notes: typeof object.notes === 'string' ? object.notes : undefined,
    } satisfies ArtifactReferenceEntry
  })
}

async function writeArtifactSidecarReferences(
  descriptor: ArtifactDescriptor,
  references: ArtifactReferenceEntry[],
  cwd: string,
) {
  if (!descriptor.sidecarPath) {
    throw new Error(`${descriptor.displayName} does not expose a writable sidecar.`)
  }

  const sidecarAbsolutePath = resolveRepoPath(descriptor.sidecarPath, cwd)
  const raw = await readFile(sidecarAbsolutePath, 'utf8').catch(() => null)

  if (descriptor.artifactType !== 'storyboard' && raw === null) {
    throw new Error(`${descriptor.displayName} is missing its source sidecar.`)
  }

  if (descriptor.artifactType === 'storyboard') {
    const storyboard = await loadStoryboardOrEmpty(cwd)

    if (!storyboard) {
      throw new Error('workspace/STORYBOARD.json is missing.')
    }

    const current = findStoryboardImageByArtifactId(storyboard, descriptor.artifactId)

    if (!current) {
      throw new Error(`${descriptor.displayName} is missing from workspace/STORYBOARD.json.`)
    }

    const nextStoryboard = {
      images: storyboard.images.map((entry, index) =>
        index === current.imageIndex
          ? {
              ...entry,
              references: references.length === 0 ? undefined : references,
            }
          : entry,
      ),
    }

    await writeFile(sidecarAbsolutePath, `${JSON.stringify(nextStoryboard, null, 2)}\n`, 'utf8')
    return
  }

  const existing = raw ? (JSON.parse(raw) as Record<string, unknown>) : {}

  if (references.length === 0) {
    delete existing.references
  } else {
    existing.references = references
  }

  await writeFile(sidecarAbsolutePath, `${JSON.stringify(existing, null, 2)}\n`, 'utf8')
}

async function writeArtifactSidecarCamera(
  descriptor: ArtifactDescriptor,
  camera: KeyframeCameraSpec | ShotCameraSpec,
  cwd: string,
) {
  if (!descriptor.sidecarPath) {
    throw new Error(`${descriptor.displayName} does not expose a writable sidecar.`)
  }

  if (descriptor.artifactType !== 'keyframe' && descriptor.artifactType !== 'shot') {
    throw new Error(`${descriptor.displayName} does not support camera settings.`)
  }

  const sidecarAbsolutePath = resolveRepoPath(descriptor.sidecarPath, cwd)
  const raw = await readFile(sidecarAbsolutePath, 'utf8').catch(() => null)

  if (raw === null) {
    throw new Error(`${descriptor.displayName} is missing its source sidecar.`)
  }

  const existing = JSON.parse(raw) as Record<string, unknown>
  const ordered =
    descriptor.artifactType === 'keyframe'
      ? orderSidecarFields(existing, KEYFRAME_SIDECAR_FIELD_ORDER, {
          camera: resolveKeyframeCameraSpec(camera as KeyframeCameraSpec),
        })
      : orderSidecarFields(existing, SHOT_SIDECAR_FIELD_ORDER, {
          camera: resolveShotCameraSpec(camera as ShotCameraSpec),
        })

  await writeFile(sidecarAbsolutePath, `${JSON.stringify(ordered, null, 2)}\n`, 'utf8')
}

async function buildCharacterCards(cwd: string) {
  const characters = await loadCharacterSheetsOrEmpty(cwd)

  return Promise.all(
    characters.map(async (entry) => {
      const imagePath = getCharacterSheetImagePath(entry.characterId)

      return {
        characterId: entry.characterId,
        displayName: entry.displayName,
        prompt: entry.prompt,
        status: entry.status,
        imageUrl: `/${encodeAssetUrl(imagePath)}`,
        imageExists: await fileExists(resolveRepoPath(imagePath, cwd)),
      } satisfies CharacterReviewCard
    }),
  )
}

async function buildStoryboardCards(cwd: string) {
  const storyboard = await loadStoryboardOrEmpty(cwd)

  if (!storyboard) {
    return []
  }

  return Promise.all(
    buildStoryboardDerivedImages(storyboard.images).map(async (entry) => ({
      selectionId: getStoryboardSelectionId(entry.imageIndex),
      storyboardImageId: entry.storyboardImageId,
      shotId: entry.shotId,
      frameType: entry.entry.frameType,
      goal: entry.entry.goal,
      imageUrl: entry.entry.imagePath ? `/${encodeAssetUrl(entry.entry.imagePath)}` : null,
      imageExists:
        entry.entry.imagePath === null
          ? false
          : await fileExists(resolveRepoPath(entry.entry.imagePath, cwd)),
    })),
  ) satisfies Promise<StoryboardReviewCard[]>
}

async function buildStoryboardGridSlots(
  storyboard: { images: StoryboardImageEntry[] } | null,
  selectedImageId: string,
  cwd: string,
) {
  if (!storyboard) {
    return [] satisfies StoryboardGridSlot[]
  }

  const cards = await buildStoryboardCards(cwd)
  const cardBySelectionId = new Map(cards.map((card) => [card.selectionId, card]))

  return buildStoryboardShotSlots(storyboard.images).map((slot) => ({
    shotId: slot.shotId,
    isPaired: slot.items.length > 1,
    tiles: slot.items.map((item) => {
      const selectionId = getStoryboardSelectionId(item.imageIndex)
      const card = cardBySelectionId.get(selectionId)

      return {
        selectionId,
        storyboardImageId: item.storyboardImageId,
        shotId: item.shotId,
        frameType: item.entry.frameType,
        goal: item.entry.goal,
        imageUrl:
          card?.imageUrl ??
          (item.entry.imagePath ? `/${encodeAssetUrl(item.entry.imagePath)}` : null),
        imageExists: card?.imageExists ?? false,
        isSelected: selectionId === selectedImageId,
      } satisfies StoryboardGridTile
    }),
  }))
}

async function findStoryboardImageDependents(storyboardImagePath: string, cwd: string) {
  const [keyframeArtifacts, shotArtifacts] = await Promise.all([
    loadKeyframeArtifactsOrEmpty(cwd),
    loadShotArtifactsOrEmpty(cwd),
  ])
  const dependents: string[] = []

  for (const artifact of keyframeArtifacts) {
    if ((artifact.references ?? []).some((reference) => reference.path === storyboardImagePath)) {
      dependents.push(artifact.keyframeId)
    }
  }

  for (const artifact of shotArtifacts) {
    if ((artifact.references ?? []).some((reference) => reference.path === storyboardImagePath)) {
      dependents.push(artifact.shotId)
    }
  }

  return dependents.sort()
}

async function loadCharacterDetail(
  characterId: string,
  cwd: string,
  requestedVersionId?: string | null,
) {
  const [config, characters] = await Promise.all([
    loadConfig(cwd).catch(() => null),
    loadCharacterSheetsOrEmpty(cwd),
  ])
  const character = characters.find((entry) => entry.characterId === characterId)

  if (!character) {
    return null
  }

  const descriptor = getCharacterArtifactDescriptor(characterId)
  const historyState = await loadArtifactHistoryState(descriptor, cwd, {
    activeVersionId: requestedVersionId,
  })
  const activeVersionId = historyState.activeVersionId

  return {
    descriptor,
    activeTab: 'characters' as const,
    title: character.displayName,
    subtitle:
      'Review the current artifact, browse retained versions, update the source reference stack, and request targeted edits.',
    summaryHref: '/',
    summaryLabel: 'Back to characters',
    mediaType: 'image' as const,
    mediaUrl: activeVersionId
      ? getArtifactVersionMediaUrl(descriptor, activeVersionId)
      : getCanonicalMediaUrl(descriptor),
    mediaExists: activeVersionId !== null ? true : historyState.currentExists,
    mediaPlaceholder: 'No character image yet',
    mediaPlaceholderVariant: 'missing',
    sourceReferences: character.references ?? [],
    sourcePrompt: character.prompt,
    sourceModel: config?.imageModel ?? null,
    sourceStatus: character.status,
    historyState,
    notesHtml: `<section class="panel"><p class="section-title">Current Prompt</p><p class="muted">${escapeHtml(character.prompt)}</p></section>`,
    canEdit: historyState.currentExists || historyState.activeVersionId !== null,
    canEditReferences: true,
    primaryAction: {
      kind: 'regenerate',
      actionUrl: getArtifactRegenerateActionPath(descriptor),
      enabled: historyState.currentExists || historyState.activeVersionId !== null,
    },
    cameraControl: null,
    anchorPlanningAction: null,
  } satisfies ArtifactDetailContext
}

async function loadKeyframeDetail(
  keyframeId: string,
  cwd: string,
  requestedVersionId?: string | null,
) {
  const [config, keyframes, artifacts, shots, cameraVocabulary] = await Promise.all([
    loadConfig(cwd).catch(() => null),
    loadKeyframesOrEmpty(cwd),
    loadKeyframeArtifactsOrEmpty(cwd),
    loadShotPromptsOrEmpty(cwd),
    loadCameraVocabularyOrNull(cwd),
  ])
  const keyframe = keyframes.find((entry) => entry.keyframeId === keyframeId)

  if (!keyframe) {
    return null
  }

  const artifact = artifacts.find((entry) => entry.keyframeId === keyframeId)
  const descriptor = getKeyframeArtifactDescriptor(keyframe)
  const historyState = await loadArtifactHistoryState(descriptor, cwd, {
    activeVersionId: requestedVersionId,
  })
  const activeVersionId = historyState.activeVersionId
  const shot = shots.find((entry) => entry.shotId === keyframe.shotId) ?? null
  const bridgeSourceShot =
    keyframe.frameType === 'start' ? getBridgeSourceShot(shots, keyframe.shotId) : null
  const canRemoveAnchor = (shot?.keyframeIds.length ?? 0) > 1 && !bridgeSourceShot
  const bridgeSourceEndKeyframeId = bridgeSourceShot
    ? getCanonicalKeyframeId(bridgeSourceShot.shotId, 'end')
    : null
  const keyframePlanNotes = [
    `<section class="panel"><p class="section-title">Keyframe Plan</p><p class="muted">Shot: ${escapeHtml(keyframe.shotId)}</p><p class="small">Frame type: ${escapeHtml(keyframe.frameType)}</p>`,
    bridgeSourceShot
      ? `<p class="small">Shared boundary: ${escapeHtml(bridgeSourceShot.shotId)} end reuses this start frame.</p>`
      : '',
    '</section>',
  ].join('')

  return {
    descriptor,
    activeTab: 'timeline' as const,
    title: keyframe.keyframeId,
    subtitle:
      'Use the current artifact, retained versions, and explicit references to iterate on a single keyframe without manual file copying.',
    summaryHref: '/timeline',
    summaryLabel: 'Back to timeline',
    mediaType: 'image' as const,
    mediaUrl: activeVersionId
      ? getArtifactVersionMediaUrl(descriptor, activeVersionId)
      : getCanonicalMediaUrl(descriptor),
    mediaExists: activeVersionId !== null ? true : historyState.currentExists,
    mediaPlaceholder: 'No keyframe image yet',
    mediaPlaceholderVariant: 'missing',
    sourceReferences: artifact?.references ?? [],
    sourcePrompt: artifact?.prompt ?? null,
    sourceModel: config?.imageModel ?? null,
    sourceStatus: artifact?.status ?? 'planned',
    historyState,
    notesHtml: keyframePlanNotes,
    canEdit:
      (historyState.currentExists || historyState.activeVersionId !== null) &&
      artifact !== undefined,
    canEditReferences: artifact !== undefined,
    primaryAction: {
      kind: 'regenerate',
      actionUrl: getArtifactRegenerateActionPath(descriptor),
      enabled:
        (historyState.currentExists || historyState.activeVersionId !== null) &&
        artifact !== undefined,
    },
    cameraControl: buildCameraOverrideControl('keyframe', artifact?.camera, cameraVocabulary),
    anchorPlanningAction:
      bridgeSourceShot && bridgeSourceEndKeyframeId
        ? {
            kind: 'unbridge-keyframe',
            actionUrl: getArtifactUnbridgeActionPath(
              getKeyframeArtifactDescriptor({
                keyframeId: bridgeSourceEndKeyframeId,
                shotId: bridgeSourceShot.shotId,
              }),
            ),
            enabled: true,
            buttonLabel: 'Use distinct end frame',
            buttonTone: 'secondary',
            helpText: `${bridgeSourceShot.shotId} currently reuses this start frame as its ending bridge frame. Switch back to restore a normal two-head boundary.`,
          }
        : {
            kind: 'remove-keyframe',
            actionUrl: getArtifactRemoveActionPath(descriptor),
            enabled: canRemoveAnchor,
            buttonLabel: 'Remove keyframe',
            buttonTone: 'danger',
            helpText: canRemoveAnchor
              ? `Remove this ${frameTypeLabel(keyframe.frameType).toLowerCase()} anchor and collapse the shot back to its remaining planned keyframe.`
              : 'This is the only planned anchor for the shot, so it cannot be removed.',
            confirmMessage: canRemoveAnchor
              ? `Remove planned keyframe ${keyframe.keyframeId} and delete its sidecar, current image, and retained history?`
              : undefined,
          },
  } satisfies ArtifactDetailContext
}

async function loadOmittedKeyframeDetail(
  keyframeId: string,
  cwd: string,
  requestedVersionId?: string | null,
) {
  const [config, shots] = await Promise.all([
    loadConfig(cwd).catch(() => null),
    loadShotPromptsOrEmpty(cwd),
  ])
  const match = getShotByCanonicalKeyframeId(shots, keyframeId)

  if (!match || match.shot.keyframeIds.includes(keyframeId)) {
    return null
  }

  const { nextShot } = getAdjacentShots(shots, match.shotId)
  const nextShotStart = nextShot ? getPlannedShotKeyframe(nextShot, 'start') : null
  const isBridgedEnd = match.frameType === 'end' && match.shot.endFrameMode === 'bridge'
  const bridgeTargetLabel =
    nextShotStart?.keyframeId ?? (nextShot ? `${nextShot.shotId} start` : null)

  const descriptor = getKeyframeArtifactDescriptor({
    keyframeId,
    shotId: match.shotId,
  })
  const historyState = await loadArtifactHistoryState(descriptor, cwd, {
    activeVersionId: requestedVersionId,
  })

  return {
    descriptor,
    activeTab: 'timeline' as const,
    title: keyframeId,
    subtitle: isBridgedEnd
      ? `This boundary is currently bridged from ${bridgeTargetLabel ?? 'the next shot start frame'}. Switch back only when this shot needs its own distinct end frame.`
      : 'This anchor is currently omitted from the shot plan. Create it only when the shot needs a distinct extra start or end frame.',
    summaryHref: '/timeline',
    summaryLabel: 'Back to timeline',
    mediaType: 'image' as const,
    mediaUrl: null,
    mediaExists: false,
    mediaPlaceholder: isBridgedEnd
      ? `Bridge frame uses ${bridgeTargetLabel ?? 'next shot start'}`
      : `No ${match.frameType} keyframe planned`,
    mediaPlaceholderVariant: 'omitted',
    sourceReferences: [],
    sourcePrompt: null,
    sourceModel: config?.imageModel ?? null,
    sourceStatus: isBridgedEnd ? 'bridged' : 'omitted',
    historyState,
    notesHtml: [
      `<section class="panel"><p class="section-title">Keyframe Plan</p><p class="muted">Shot: ${escapeHtml(match.shotId)}</p><p class="small">Frame type: ${escapeHtml(match.frameType)}</p><p class="small">Current planned anchors: ${escapeHtml(match.shot.keyframeIds.join(' -> '))}</p>`,
      isBridgedEnd && bridgeTargetLabel
        ? `<p class="small">Bridge source: ${escapeHtml(bridgeTargetLabel)}</p>`
        : '',
      '</section>',
    ].join(''),
    canEdit: false,
    canEditReferences: false,
    primaryAction: isBridgedEnd
      ? null
      : {
          kind: 'create-keyframe',
          actionUrl: getArtifactCreateActionPath(descriptor),
          enabled: true,
        },
    cameraControl: null,
    anchorPlanningAction:
      match.frameType === 'end' && isBridgedEnd
        ? {
            kind: 'unbridge-keyframe',
            actionUrl: getArtifactUnbridgeActionPath(descriptor),
            enabled: true,
            buttonLabel: 'Use distinct end frame',
            buttonTone: 'secondary',
            helpText: `This boundary currently reuses ${bridgeTargetLabel ?? 'the next shot start frame'} as a single shared bridge frame. Switch back to restore a normal two-head boundary.`,
          }
        : match.frameType === 'end' && nextShotStart
          ? {
              kind: 'bridge-keyframe',
              actionUrl: getArtifactBridgeActionPath(descriptor),
              enabled: true,
              buttonLabel: 'Make bridge frame',
              buttonTone: 'secondary',
              helpText: `Reuse ${nextShotStart.keyframeId} as this shot's ending bridge frame. The boundary pointer will collapse to a single shared head.`,
            }
          : null,
  } satisfies ArtifactDetailContext
}

async function loadShotDetail(shotId: string, cwd: string, requestedVersionId?: string | null) {
  const [config, shots, artifacts, cameraVocabulary] = await Promise.all([
    loadConfig(cwd).catch(() => null),
    loadShotPromptsOrEmpty(cwd),
    loadShotArtifactsOrEmpty(cwd),
    loadCameraVocabularyOrNull(cwd),
  ])
  const shot = shots.find((entry) => entry.shotId === shotId)

  if (!shot) {
    return null
  }

  const artifact = artifacts.find((entry) => entry.shotId === shotId)
  const descriptor = getShotArtifactDescriptor(shotId)
  const historyState = await loadArtifactHistoryState(descriptor, cwd, {
    activeVersionId: requestedVersionId,
  })
  const activeVersionId = historyState.activeVersionId
  const { nextShot } = getAdjacentShots(shots, shotId)
  const incomingBridgeSource = getBridgeSourceShot(shots, shotId)
  const outgoingBridgeTarget =
    shot.endFrameMode === 'bridge' && nextShot ? getPlannedShotKeyframe(nextShot, 'start') : null

  return {
    descriptor,
    activeTab: 'timeline' as const,
    title: shotId,
    subtitle:
      'Review the current motion artifact, edit the source reference stack, and promote any retained version back to the stable public MP4 path.',
    summaryHref: '/timeline',
    summaryLabel: 'Back to timeline',
    mediaType: 'video' as const,
    mediaUrl: activeVersionId
      ? getArtifactVersionMediaUrl(descriptor, activeVersionId)
      : getCanonicalMediaUrl(descriptor),
    mediaExists: activeVersionId !== null ? true : historyState.currentExists,
    mediaPlaceholder: 'No shot video yet',
    mediaPlaceholderVariant: 'missing',
    sourceReferences: artifact?.references ?? [],
    sourcePrompt: artifact?.prompt ?? null,
    sourceModel: config?.videoModel ?? null,
    sourceStatus: artifact?.status ?? shot.status,
    historyState,
    notesHtml: [
      `<section class="panel"><p class="section-title">Shot Plan</p><p class="muted">Anchors: ${escapeHtml(shot.keyframeIds.join(' -> '))}</p><p class="small">Duration: ${escapeHtml(formatDurationSeconds(shot.durationSeconds))}</p>`,
      incomingBridgeSource
        ? `<p class="small">Incoming bridge: ${escapeHtml(incomingBridgeSource.shotId)} end reuses this shot's start frame.</p>`
        : '',
      outgoingBridgeTarget
        ? `<p class="small">Outgoing bridge: this shot reuses ${escapeHtml(outgoingBridgeTarget.keyframeId)} as its ending bridge frame.</p>`
        : '',
      '</section>',
    ].join(''),
    canEdit:
      (historyState.currentExists || historyState.activeVersionId !== null) &&
      artifact !== undefined,
    canEditReferences: artifact !== undefined,
    primaryAction: {
      kind: 'regenerate',
      actionUrl: getArtifactRegenerateActionPath(descriptor),
      enabled:
        (historyState.currentExists || historyState.activeVersionId !== null) &&
        artifact !== undefined,
    },
    cameraControl: buildCameraOverrideControl('shot', artifact?.camera, cameraVocabulary),
    anchorPlanningAction: null,
  } satisfies ArtifactDetailContext
}

async function loadStoryboardDetail(
  storyboardArtifactId: string,
  cwd: string,
  requestedVersionId?: string | null,
) {
  const [config, storyboard] = await Promise.all([
    loadConfig(cwd).catch(() => null),
    loadStoryboardOrEmpty(cwd),
  ])
  const storyboardImage = findStoryboardImageByArtifactId(storyboard, storyboardArtifactId)

  if (!storyboard || !storyboardImage || storyboardImage.entry.imagePath === null) {
    return null
  }

  const descriptor = getStoryboardArtifactDescriptor({
    imagePath: storyboardImage.entry.imagePath,
    shotId: storyboardImage.shotId,
    storyboardImageId: storyboardImage.storyboardImageId,
  })
  const historyState = await loadArtifactHistoryState(descriptor, cwd, {
    activeVersionId: requestedVersionId,
  })
  const activeVersionId = historyState.activeVersionId
  const dependentRefs = await findStoryboardImageDependents(storyboardImage.entry.imagePath, cwd)

  return {
    descriptor,
    activeTab: 'storyboard' as const,
    title: storyboardImage.storyboardImageId,
    subtitle:
      'Review one storyboard image at a time, keep lightweight retained versions, and feed the chosen image into downstream keyframe work.',
    summaryHref: '/storyboard',
    summaryLabel: 'Back to storyboard',
    mediaType: 'image' as const,
    mediaUrl: activeVersionId
      ? getArtifactVersionMediaUrl(descriptor, activeVersionId)
      : getCanonicalMediaUrl(descriptor),
    mediaExists: activeVersionId !== null ? true : historyState.currentExists,
    mediaPlaceholder: 'No storyboard image yet',
    mediaPlaceholderVariant: 'missing',
    sourceReferences: storyboardImage.entry.references ?? [],
    sourcePrompt: buildStoryboardPrompt(storyboard, storyboardImage.imageIndex),
    sourceModel: config?.fastImageModel ?? null,
    sourceStatus: null,
    historyState,
    notesHtml: `<section class="panel"><p class="section-title">Storyboard Plan</p><p class="muted">${escapeHtml(storyboardImage.storyboardImageId)}</p><p class="small">Shot: ${escapeHtml(storyboardImage.shotId)} • Frame: ${escapeHtml(storyboardImage.entry.frameType)}</p><p class="small">${escapeHtml(storyboardImage.entry.goal)}</p></section>`,
    canEdit: historyState.currentExists || historyState.activeVersionId !== null,
    canEditReferences: true,
    primaryAction:
      historyState.currentExists || historyState.activeVersionId !== null
        ? {
            kind: 'regenerate',
            actionUrl: getArtifactRegenerateActionPath(descriptor),
            enabled: true,
          }
        : {
            kind: 'generate',
            actionUrl: getArtifactGenerateActionPath(descriptor),
            enabled: true,
          },
    cameraControl: null,
    anchorPlanningAction: null,
    extraSideHtml:
      dependentRefs.length > 0
        ? `<section class="panel"><p class="section-title">Downstream Usage</p><p class="form-note">${escapeHtml(
            `This storyboard image is already referenced by ${dependentRefs.join(', ')}.`,
          )}</p></section>`
        : undefined,
  } satisfies ArtifactDetailContext
}

async function getDetailContext(pathname: string, cwd: string, requestedVersionId?: string | null) {
  const storyboardMatch = /^\/storyboard\/images\/([^/]+)$/.exec(pathname)

  if (storyboardMatch) {
    return loadStoryboardDetail(decodeURIComponent(storyboardMatch[1]!), cwd, requestedVersionId)
  }

  const characterMatch = /^\/characters\/([^/]+)$/.exec(pathname)

  if (characterMatch) {
    return loadCharacterDetail(decodeURIComponent(characterMatch[1]!), cwd, requestedVersionId)
  }

  const keyframeMatch = /^\/keyframes\/([^/]+)$/.exec(pathname)

  if (keyframeMatch) {
    const keyframeId = decodeURIComponent(keyframeMatch[1]!)

    return (
      (await loadKeyframeDetail(keyframeId, cwd, requestedVersionId)) ??
      (await loadOmittedKeyframeDetail(keyframeId, cwd, requestedVersionId))
    )
  }

  const shotMatch = /^\/shots\/([^/]+)$/.exec(pathname)

  if (shotMatch) {
    return loadShotDetail(decodeURIComponent(shotMatch[1]!), cwd, requestedVersionId)
  }

  return null
}

async function assertBaseVersionExists(
  descriptor: ArtifactDescriptor,
  cwd: string,
  baseVersionId: string,
) {
  const state = await loadArtifactHistoryState(descriptor, cwd, {
    activeVersionId: isCurrentBaseVersionId(baseVersionId) ? null : baseVersionId,
  })

  if (isCurrentBaseVersionId(baseVersionId) ? state.currentExists : state.activeVersion) {
    return
  }

  throw new Error(
    `${descriptor.displayName} is missing the selected base version ${baseVersionId}.`,
  )
}

async function buildCharacterPendingGeneration(
  characterId: string,
  cwd: string,
): Promise<PendingCharacterSheetGeneration | null> {
  const [config, characterSheets] = await Promise.all([
    loadConfig(cwd),
    loadCharacterSheetsOrEmpty(cwd),
  ])
  const generations = selectPendingCharacterSheetGenerations(characterSheets, config.imageModel, {
    characterId,
  })

  return generations[0] ?? null
}

async function buildKeyframePendingGeneration(
  keyframeId: string,
  cwd: string,
): Promise<{
  generation: PendingKeyframeGeneration
  keyframes: KeyframeEntry[]
  shots: ShotEntry[]
} | null> {
  await syncKeyframeStoryboardReference(keyframeId, cwd)

  const [config, keyframes, artifacts, shots] = await Promise.all([
    loadConfig(cwd),
    loadKeyframesOrEmpty(cwd),
    loadKeyframeArtifactsOrEmpty(cwd),
    loadShotPromptsOrEmpty(cwd),
  ])
  const generations = selectPendingKeyframeGenerations(
    keyframes,
    artifacts,
    shots,
    config.imageModel,
    {
      keyframeId,
    },
  )

  return generations[0]
    ? {
        generation: generations[0],
        keyframes,
        shots,
      }
    : null
}

async function buildStoryboardPendingGeneration(
  storyboardArtifactId: string,
  cwd: string,
): Promise<PendingStoryboardGeneration | null> {
  const [config, existingStoryboard] = await Promise.all([
    loadConfig(cwd),
    loadStoryboardOrEmpty(cwd),
  ])

  if (!existingStoryboard) {
    return null
  }

  const entry = findStoryboardImageByArtifactId(existingStoryboard, storyboardArtifactId)

  if (!entry) {
    return null
  }

  const generations = selectPendingStoryboardGenerations(
    existingStoryboard,
    config.fastImageModel,
    {
      storyboardImageId: entry.storyboardImageId,
    },
  )

  return generations[0] ?? null
}

async function buildShotPendingGeneration(
  shotId: string,
  cwd: string,
): Promise<{
  generation: PendingShotGeneration
  keyframes: KeyframeEntry[]
  characterSheets: CharacterSheetEntry[]
} | null> {
  const [config, shots, artifacts, keyframes, characterSheets] = await Promise.all([
    loadConfig(cwd),
    loadShotPromptsOrEmpty(cwd),
    loadShotArtifactsOrEmpty(cwd),
    loadKeyframesOrEmpty(cwd),
    loadCharacterSheetsOrEmpty(cwd),
  ])
  const generations = selectPendingShotGenerations(shots, artifacts, config.videoModel, { shotId })

  return generations[0]
    ? {
        generation: generations[0],
        keyframes,
        characterSheets,
      }
    : null
}

export async function runApprovedRegenerateAction(
  pathname: string,
  cwd: string,
  baseVersionId: string,
  regenerateRequest: string,
  options: RegenerateActionOptions = {},
) {
  const storyboardMatch = /^\/storyboard\/images\/([^/]+)$/.exec(pathname)

  if (storyboardMatch) {
    const storyboardArtifactId = decodeURIComponent(storyboardMatch[1]!)
    const generation = await buildStoryboardPendingGeneration(storyboardArtifactId, cwd)

    if (!generation) {
      throw new Error(`Storyboard image "${storyboardArtifactId}" is missing valid planning data.`)
    }

    const descriptor = getStoryboardArtifactDescriptor({
      imagePath: generation.outputPath,
      shotId: generation.shotId,
      storyboardImageId: generation.storyboardImageId,
    })

    return regenerateStoryboardArtifactVersion(generation, {
      regenerateRequest,
      selectedVersionPath: getBaseVersionMediaPath(descriptor, baseVersionId),
      userReferences: generation.userReferences ?? [],
      cwd,
      generator: options.imageGenerator,
    })
  }

  const characterMatch = /^\/characters\/([^/]+)$/.exec(pathname)

  if (characterMatch) {
    const characterId = decodeURIComponent(characterMatch[1]!)
    const generation = await buildCharacterPendingGeneration(characterId, cwd)

    if (!generation) {
      throw new Error(`Character "${characterId}" is missing a valid generation sidecar.`)
    }

    const descriptor = getCharacterArtifactDescriptor(characterId)

    return regenerateCharacterSheetArtifactVersion(generation, {
      regenerateRequest,
      selectedVersionPath: getBaseVersionMediaPath(descriptor, baseVersionId),
      userReferences: generation.userReferences ?? [],
      cwd,
      generator: options.imageGenerator,
    })
  }

  const keyframeMatch = /^\/keyframes\/([^/]+)$/.exec(pathname)

  if (keyframeMatch) {
    const keyframeId = decodeURIComponent(keyframeMatch[1]!)
    const pending = await buildKeyframePendingGeneration(keyframeId, cwd)

    if (!pending) {
      throw new Error(`Keyframe "${keyframeId}" is missing a valid generation sidecar.`)
    }

    const descriptor = getKeyframeArtifactDescriptor(pending.generation)
    const camera = resolveEffectiveKeyframeCamera(
      pending.generation.camera,
      options.cameraOverrides,
    )

    return regenerateKeyframeArtifactVersion(
      {
        ...pending.generation,
        camera,
      },
      pending.keyframes,
      pending.shots,
      {
        regenerateRequest,
        selectedVersionPath: getBaseVersionMediaPath(descriptor, baseVersionId),
        userReferences: pending.generation.userReferences ?? [],
        cwd,
        generator: options.imageGenerator,
      },
    )
  }

  const shotMatch = /^\/shots\/([^/]+)$/.exec(pathname)

  if (shotMatch) {
    const shotId = decodeURIComponent(shotMatch[1]!)
    const pending = await buildShotPendingGeneration(shotId, cwd)

    if (!pending) {
      throw new Error(`Shot "${shotId}" is missing a valid generation sidecar.`)
    }

    // Shot regeneration still uses the existing image-to-video anchor flow.
    // The current SDK path does not support passing the selected .mp4 back as
    // a true regeneration baseline.
    const camera = resolveEffectiveShotCamera(pending.generation.camera, options.cameraOverrides)

    return regenerateShotArtifactVersion(
      {
        ...pending.generation,
        camera,
      },
      pending.keyframes,
      pending.characterSheets,
      {
        regenerateRequest,
        baseVersionId,
        userReferences: pending.generation.userReferences ?? [],
        cwd,
        regenerationCamera: camera,
        generator: options.shotVideoGenerator,
      },
    )
  }

  throw new Error('Unsupported regenerate route.')
}

async function serveCanonicalCharacterImage(requestPath: string, cwd: string) {
  const decodedPath = decodeURIComponent(requestPath.slice(1))
  const characters = await loadCharacterSheetsOrEmpty(cwd)
  const matchingEntry = characters.find(
    (entry) => getCharacterSheetImagePath(entry.characterId) === decodedPath,
  )

  if (!matchingEntry) {
    return new Response('Not Found', { status: 404 })
  }

  const absolutePath = resolveRepoPath(getCharacterSheetImagePath(matchingEntry.characterId), cwd)

  if (!(await fileExists(absolutePath))) {
    return new Response('Not Found', { status: 404 })
  }

  return new Response(Bun.file(absolutePath))
}

async function serveCanonicalStoryboardImage(requestPath: string, cwd: string) {
  const decodedPath = decodeURIComponent(requestPath.slice(1))
  const storyboard = await loadStoryboardOrEmpty(cwd)
  const matchingEntry = storyboard?.images.find((entry) => entry.imagePath === decodedPath) ?? null
  const legacyPath = getLegacyStoryboardImagePath()

  if (!matchingEntry && decodedPath !== legacyPath) {
    return new Response('Not Found', { status: 404 })
  }

  const absolutePath = resolveRepoPath(matchingEntry?.imagePath ?? legacyPath, cwd)

  if (!(await fileExists(absolutePath))) {
    return new Response('Not Found', { status: 404 })
  }

  return new Response(Bun.file(absolutePath))
}

async function serveCanonicalKeyframeImage(requestPath: string, cwd: string) {
  const decodedPath = decodeURIComponent(requestPath.slice(1))
  const keyframes = await loadKeyframesOrEmpty(cwd)
  const matchingEntry = keyframes.find((entry) => entry.imagePath === decodedPath)

  if (!matchingEntry) {
    return new Response('Not Found', { status: 404 })
  }

  const absolutePath = resolveRepoPath(matchingEntry.imagePath, cwd)

  if (!(await fileExists(absolutePath))) {
    return new Response('Not Found', { status: 404 })
  }

  return new Response(Bun.file(absolutePath))
}

async function serveCanonicalShotVideo(requestPath: string, cwd: string) {
  const decodedPath = decodeURIComponent(requestPath.slice(1))
  const shots = await loadShotPromptsOrEmpty(cwd)
  const matchingEntry = shots.find((entry) => entry.videoPath === decodedPath)

  if (!matchingEntry) {
    return new Response('Not Found', { status: 404 })
  }

  const absolutePath = resolveRepoPath(getShotVideoPath(matchingEntry), cwd)

  if (!(await fileExists(absolutePath))) {
    return new Response('Not Found', { status: 404 })
  }

  return new Response(Bun.file(absolutePath))
}

async function serveArtifactVersionMedia(
  descriptor: ArtifactDescriptor,
  versionId: string,
  cwd: string,
) {
  const absolutePath = resolveRepoPath(getArtifactVersionMediaPath(descriptor, versionId), cwd)

  if (!(await fileExists(absolutePath))) {
    return new Response('Not Found', { status: 404 })
  }

  return new Response(Bun.file(absolutePath))
}

function getJobState(jobs: Map<string, ArtifactJobState>, descriptor: ArtifactDescriptor) {
  return jobs.get(getArtifactKey(descriptor)) ?? null
}

function startArtifactJob(
  jobs: Map<string, ArtifactJobState>,
  descriptor: ArtifactDescriptor,
  run: () => Promise<{ versionId: string | null }>,
) {
  const key = getArtifactKey(descriptor)
  const current = jobs.get(key)

  if (current?.status === 'running') {
    throw new Error(`${descriptor.displayName} already has an active generation job.`)
  }

  jobs.set(key, {
    status: 'running',
    startedAt: new Date().toISOString(),
    completedAt: null,
    message: `Generating a new retained version for ${descriptor.displayName}.`,
    versionId: null,
  })

  void run()
    .then((result) => {
      const message = result.versionId
        ? `Generation completed. Previous current archived as ${result.versionId}.`
        : 'Generation completed.'
      jobs.set(key, {
        status: 'success',
        startedAt: jobs.get(key)?.startedAt ?? new Date().toISOString(),
        completedAt: new Date().toISOString(),
        message,
        versionId: result.versionId,
      })
    })
    .catch((error) => {
      jobs.set(key, {
        status: 'error',
        startedAt: jobs.get(key)?.startedAt ?? new Date().toISOString(),
        completedAt: new Date().toISOString(),
        message: error instanceof Error ? error.message : String(error),
        versionId: null,
      })
    })
}

async function handleReferenceSave(pathname: string, request: Request, cwd: string) {
  const detail = await getDetailContext(pathname, cwd)

  if (!detail) {
    return renderErrorPage('characters', 'Missing Artifact', 'Artifact not found.', '/')
  }

  const formData = await request.formData()
  const referencesJson = String(formData.get('referencesJson') ?? '[]')
  const references = parseReferenceEditorInput(referencesJson)

  await writeArtifactSidecarReferences(detail.descriptor, references, cwd)
  return redirectTo(
    buildPostActionRedirectLocation(getArtifactDetailPath(detail.descriptor), request, {
      updated: true,
    }),
  )
}

async function handleGenerate(
  pathname: string,
  request: Request,
  cwd: string,
  jobs: Map<string, ArtifactJobState>,
  options: RegenerateActionOptions,
) {
  const detail = await getDetailContext(pathname, cwd)

  if (!detail || detail.descriptor.artifactType !== 'storyboard') {
    return renderErrorPage(
      'storyboard',
      'Missing Storyboard Image',
      'Storyboard image not found.',
      '/storyboard',
    )
  }

  const currentJob = getJobState(jobs, detail.descriptor)

  if (currentJob?.status === 'running') {
    throw new Error(`${detail.descriptor.displayName} already has an active generation job.`)
  }

  startArtifactJob(jobs, detail.descriptor, async () => {
    const generation = await buildStoryboardPendingGeneration(detail.descriptor.artifactId, cwd)

    if (!generation) {
      throw new Error(
        `Storyboard image "${detail.descriptor.artifactId}" is missing valid planning data.`,
      )
    }

    const result = await generateStoryboardArtifactVersion(generation, {
      userReferences: generation.userReferences ?? [],
      cwd,
      generator: options.imageGenerator,
    })

    return {
      versionId: result.versionId,
    }
  })

  return redirectTo(
    buildPostActionRedirectLocation(getArtifactDetailPath(detail.descriptor), request, {
      updated: true,
    }),
  )
}

async function handleRegenerate(
  pathname: string,
  request: Request,
  cwd: string,
  jobs: Map<string, ArtifactJobState>,
  options: RegenerateActionOptions,
) {
  const detail = await getDetailContext(pathname, cwd)

  if (!detail) {
    return renderErrorPage('characters', 'Missing Artifact', 'Artifact not found.', '/')
  }

  const formData = await request.formData()
  const baseVersionId = String(formData.get('baseVersionId') ?? '').trim()
  const regenerateRequest = String(formData.get('regenerateRequest') ?? '').trim()
  const cameraOverrides = parseCameraOverrideInput(formData, detail.cameraControl)
  const requiresDirection =
    detail.descriptor.artifactType !== 'storyboard' && cameraOverrides === null

  if (baseVersionId.length === 0 || (requiresDirection && regenerateRequest.length === 0)) {
    throw new Error('Base version and either a regenerate request or camera override are required.')
  }

  await assertBaseVersionExists(detail.descriptor, cwd, baseVersionId)

  const currentJob = getJobState(jobs, detail.descriptor)

  if (currentJob?.status === 'running') {
    throw new Error(`${detail.descriptor.displayName} already has an active generation job.`)
  }

  if (cameraOverrides && detail.descriptor.artifactType === 'keyframe') {
    await writeArtifactSidecarCamera(
      detail.descriptor,
      resolveEffectiveKeyframeCamera(
        getCurrentKeyframeCameraFromControl(detail.cameraControl),
        cameraOverrides,
      ),
      cwd,
    )
  }

  if (cameraOverrides && detail.descriptor.artifactType === 'shot') {
    await writeArtifactSidecarCamera(
      detail.descriptor,
      resolveEffectiveShotCamera(
        getCurrentShotCameraFromControl(detail.cameraControl),
        cameraOverrides,
      ),
      cwd,
    )
  }

  startArtifactJob(jobs, detail.descriptor, async () => {
    const result = await runApprovedRegenerateAction(
      pathname,
      cwd,
      baseVersionId,
      regenerateRequest,
      {
        ...options,
        cameraOverrides,
      },
    )

    return {
      versionId: result.versionId,
    }
  })

  return redirectTo(
    buildPostActionRedirectLocation(getArtifactDetailPath(detail.descriptor), request, {
      updated: true,
    }),
  )
}

async function handleCreate(
  pathname: string,
  request: Request,
  cwd: string,
  jobs: Map<string, ArtifactJobState>,
  options: RegenerateActionOptions,
) {
  const detail = await getDetailContext(pathname, cwd)

  if (!detail) {
    return renderErrorPage('timeline', 'Missing Keyframe', 'Keyframe not found.', '/timeline')
  }

  if (detail.primaryAction?.kind !== 'create-keyframe') {
    throw new Error(`Keyframe "${detail.descriptor.artifactId}" is already planned.`)
  }

  const formData = await request.formData()
  const prompt = String(formData.get('prompt') ?? '').trim()

  if (prompt.length === 0) {
    throw new Error('A prompt is required to create a keyframe.')
  }

  const descriptor = await createOmittedKeyframe(detail.descriptor.artifactId, prompt, cwd)

  startArtifactJob(jobs, descriptor, async () => {
    const pending = await buildKeyframePendingGeneration(descriptor.artifactId, cwd)

    if (!pending) {
      throw new Error(`Keyframe "${descriptor.artifactId}" is missing a valid generation sidecar.`)
    }

    const result = await generateKeyframeArtifactVersion(
      pending.generation,
      pending.keyframes,
      pending.shots,
      {
        cwd,
        generator: options.imageGenerator,
      },
    )

    return {
      versionId: result.versionId,
    }
  })

  return redirectTo(
    buildPostActionRedirectLocation(getArtifactDetailPath(descriptor), request, {
      updated: true,
    }),
  )
}

async function writeStoryboardManifest(
  storyboard: { images: StoryboardImageEntry[] },
  cwd: string,
) {
  await writeFile(
    resolveWorkflowPath(WORKFLOW_FILES.storyboardSidecar, cwd),
    `${JSON.stringify(storyboard, null, 2)}\n`,
    'utf8',
  )
}

interface StoryboardEditorFormInput {
  selectedImageId: string
  goal: string
  references: ArtifactReferenceEntry[]
  regenerateRequest: string
}

async function parseStoryboardEditorForm(request: Request): Promise<StoryboardEditorFormInput> {
  const formData = await request.formData()
  const selectedImageId = String(formData.get('selectedImageId') ?? '').trim()
  const goal = String(formData.get('goal') ?? '').trim()
  const regenerateRequest = String(formData.get('regenerateRequest') ?? '').trim()
  const references = parseReferenceEditorInput(String(formData.get('referencesJson') ?? '[]'))

  if (goal.length === 0) {
    throw new Error('Goal is required.')
  }

  return {
    selectedImageId: selectedImageId.length > 0 ? selectedImageId : STORYBOARD_NEW_SELECTION_ID,
    goal,
    references,
    regenerateRequest,
  }
}

function createStoryboardDraftFromForm(input: StoryboardEditorFormInput, frameType: FrameType) {
  return createStoryboardImageEntry({
    frameType,
    goal: input.goal,
    references: input.references,
  })
}

async function syncKeyframeStoryboardReference(keyframeId: string, cwd: string) {
  const [storyboard, keyframes, shots, artifacts] = await Promise.all([
    loadStoryboardOrEmpty(cwd),
    loadKeyframesOrEmpty(cwd),
    loadShotPromptsOrEmpty(cwd),
    loadKeyframeArtifactsOrEmpty(cwd),
  ])
  const keyframe = keyframes.find((entry) => entry.keyframeId === keyframeId)
  const artifact = artifacts.find((entry) => entry.keyframeId === keyframeId)

  if (!keyframe || !artifact) {
    return
  }

  const shotIndex = shots.findIndex((entry) => entry.shotId === keyframe.shotId)

  if (shotIndex < 0) {
    return
  }

  const storyboardImage = storyboard
    ? findStoryboardImageForShotIndex(storyboard.images, shotIndex, keyframe.frameType)
    : null
  const storyboardPath =
    storyboardImage?.imagePath &&
    (await fileExists(resolveRepoPath(storyboardImage.imagePath, cwd)))
      ? storyboardImage.imagePath
      : null
  const currentReferences = artifact.references ?? []
  const nextReferences = currentReferences.filter((reference) => reference.kind !== 'storyboard')

  if (storyboardPath) {
    const insertAt = nextReferences.findIndex(
      (reference) =>
        reference.kind !== 'previous-shot-end-frame' && reference.kind !== 'start-frame',
    )
    const storyboardReference = {
      kind: 'storyboard',
      path: storyboardPath,
    } satisfies ArtifactReferenceEntry

    if (insertAt === -1) {
      nextReferences.push(storyboardReference)
    } else {
      nextReferences.splice(insertAt, 0, storyboardReference)
    }
  }

  if (JSON.stringify(currentReferences) === JSON.stringify(nextReferences)) {
    return
  }

  const sidecarPath = resolveRepoPath(getKeyframeArtifactJsonPath(artifact), cwd)
  const raw = await readFile(sidecarPath, 'utf8')
  const existing = JSON.parse(raw) as Record<string, unknown>
  const ordered = orderSidecarFields(existing, KEYFRAME_SIDECAR_FIELD_ORDER, {})

  if (nextReferences.length === 0) {
    delete ordered.references
  } else {
    ordered.references = nextReferences
  }

  await writeFile(sidecarPath, `${JSON.stringify(ordered, null, 2)}\n`, 'utf8')
}

async function upsertStoryboardSelection(input: StoryboardEditorFormInput, cwd: string) {
  const existingStoryboard = (await loadStoryboardOrEmpty(cwd)) ?? {
    images: [],
  }

  if (input.selectedImageId === STORYBOARD_NEW_SELECTION_ID) {
    const nextStoryboard = {
      images: [...existingStoryboard.images, createStoryboardDraftFromForm(input, 'start')],
    } satisfies StoryboardSidecar

    await writeStoryboardManifest(nextStoryboard, cwd)

    return {
      storyboard: nextStoryboard,
      entry: buildStoryboardDerivedImages(nextStoryboard.images)[nextStoryboard.images.length - 1]!,
    }
  }

  const current = findStoryboardImage(existingStoryboard, input.selectedImageId)

  if (!current) {
    throw new Error(
      `Storyboard image "${input.selectedImageId}" is missing from workspace/STORYBOARD.json.`,
    )
  }

  const nextEntry = {
    ...current.entry,
    goal: input.goal,
    references: input.references.length > 0 ? input.references : undefined,
  } satisfies StoryboardImageEntry

  const nextStoryboard = {
    images: existingStoryboard.images.map((entry, index) =>
      index === current.imageIndex ? nextEntry : entry,
    ),
  } satisfies StoryboardSidecar

  await writeStoryboardManifest(nextStoryboard, cwd)

  return {
    storyboard: nextStoryboard,
    entry: buildStoryboardDerivedImages(nextStoryboard.images)[current.imageIndex]!,
  }
}

async function handleStoryboardSave(request: Request, cwd: string) {
  const input = await parseStoryboardEditorForm(request)
  const entry = await upsertStoryboardSelection(input, cwd)

  return redirectTo(
    appendSearchParams(buildPostActionRedirectLocation('/storyboard', request, { updated: true }), {
      image: getStoryboardSelectionId(entry.entry.imageIndex),
    }),
  )
}

async function handleStoryboardRender(
  request: Request,
  cwd: string,
  jobs: Map<string, ArtifactJobState>,
  options: RegenerateActionOptions,
) {
  const input = await parseStoryboardEditorForm(request)
  const { storyboard, entry } = await upsertStoryboardSelection(input, cwd)
  const preparedStoryboard = await ensureStoryboardImagePaths(
    storyboard,
    { storyboardImageId: entry.storyboardImageId },
    cwd,
  )
  const preparedEntry = buildStoryboardDerivedImages(preparedStoryboard.images)[entry.imageIndex]!

  if (preparedEntry.entry.imagePath === null) {
    throw new Error(`Storyboard image "${preparedEntry.storyboardImageId}" is missing imagePath.`)
  }

  const descriptor = getStoryboardArtifactDescriptor({
    imagePath: preparedEntry.entry.imagePath,
    shotId: preparedEntry.shotId,
    storyboardImageId: preparedEntry.storyboardImageId,
  })
  const currentJob = getJobState(jobs, descriptor)

  if (currentJob?.status === 'running') {
    throw new Error(`${descriptor.displayName} already has an active generation job.`)
  }

  startArtifactJob(jobs, descriptor, async () => {
    const generation = await buildStoryboardPendingGeneration(descriptor.artifactId, cwd)

    if (!generation) {
      throw new Error(
        `Storyboard image "${preparedEntry.storyboardImageId}" is missing valid planning data.`,
      )
    }

    if (await fileExists(resolveRepoPath(preparedEntry.entry.imagePath!, cwd))) {
      const result = await regenerateStoryboardArtifactVersion(generation, {
        regenerateRequest: input.regenerateRequest,
        selectedVersionPath: getBaseVersionMediaPath(descriptor, CURRENT_BASE_VERSION_ID),
        userReferences: generation.userReferences ?? [],
        cwd,
        generator: options.imageGenerator,
      })

      return {
        versionId: result.versionId,
      }
    }

    const result = await generateStoryboardArtifactVersion(generation, {
      userReferences: generation.userReferences ?? [],
      cwd,
      generator: options.imageGenerator,
    })

    return {
      versionId: result.versionId,
    }
  })

  return redirectTo(
    appendSearchParams(buildPostActionRedirectLocation('/storyboard', request, { updated: true }), {
      image: getStoryboardSelectionId(preparedEntry.imageIndex),
    }),
  )
}

async function handleStoryboardInsertEnd(
  request: Request,
  cwd: string,
  jobs: Map<string, ArtifactJobState>,
  options: RegenerateActionOptions,
) {
  const input = await parseStoryboardEditorForm(request)
  const storyboard = await loadStoryboardOrEmpty(cwd)

  if (!storyboard) {
    throw new Error('workspace/STORYBOARD.json is required before inserting an end frame.')
  }

  if (input.selectedImageId === STORYBOARD_NEW_SELECTION_ID) {
    throw new Error('Select a storyboard start frame before inserting an end frame.')
  }

  const current = findStoryboardImage(storyboard, input.selectedImageId)

  if (!current) {
    throw new Error(
      `Storyboard image "${input.selectedImageId}" is missing from workspace/STORYBOARD.json.`,
    )
  }

  if (current.entry.frameType !== 'start') {
    throw new Error('Only a selected start frame can receive a new end frame.')
  }

  if (getStoryboardPairedEnd(storyboard, input.selectedImageId)) {
    throw new Error(`Storyboard image "${current.storyboardImageId}" already has an end frame.`)
  }

  const insertIndex = getStoryboardImageIndex(storyboard, input.selectedImageId)
  const nextEntry = createStoryboardDraftFromForm(input, 'end')
  const nextStoryboard = {
    images: [
      ...storyboard.images.slice(0, insertIndex + 1),
      nextEntry,
      ...storyboard.images.slice(insertIndex + 1),
    ],
  }

  await writeStoryboardManifest(nextStoryboard, cwd)

  const insertedEntry = buildStoryboardDerivedImages(nextStoryboard.images)[insertIndex + 1]!
  const preparedStoryboard = await ensureStoryboardImagePaths(
    nextStoryboard,
    { storyboardImageId: insertedEntry.storyboardImageId },
    cwd,
  )
  const preparedEntry = buildStoryboardDerivedImages(preparedStoryboard.images)[insertIndex + 1]!

  if (preparedEntry.entry.imagePath === null) {
    throw new Error(`Storyboard image "${preparedEntry.storyboardImageId}" is missing imagePath.`)
  }

  const descriptor = getStoryboardArtifactDescriptor({
    imagePath: preparedEntry.entry.imagePath,
    shotId: preparedEntry.shotId,
    storyboardImageId: preparedEntry.storyboardImageId,
  })
  const currentJob = getJobState(jobs, descriptor)

  if (currentJob?.status === 'running') {
    throw new Error(`${descriptor.displayName} already has an active generation job.`)
  }

  startArtifactJob(jobs, descriptor, async () => {
    const generation = await buildStoryboardPendingGeneration(descriptor.artifactId, cwd)

    if (!generation) {
      throw new Error(
        `Storyboard image "${preparedEntry.storyboardImageId}" is missing valid planning data.`,
      )
    }

    const result = await generateStoryboardArtifactVersion(generation, {
      userReferences: generation.userReferences ?? [],
      cwd,
      generator: options.imageGenerator,
    })

    return {
      versionId: result.versionId,
    }
  })

  return redirectTo(
    appendSearchParams(buildPostActionRedirectLocation('/storyboard', request, { updated: true }), {
      image: getStoryboardSelectionId(preparedEntry.imageIndex),
    }),
  )
}

async function handleStoryboardDelete(request: Request, cwd: string) {
  const formData = await request.formData()
  const selectedImageId = String(formData.get('selectedImageId') ?? '').trim()
  const storyboard = await loadStoryboardOrEmpty(cwd)

  if (!storyboard || selectedImageId.length === 0) {
    throw new Error('Select a storyboard thumbnail before deleting it.')
  }

  const currentIndex = getStoryboardImageIndex(storyboard, selectedImageId)
  const current = findStoryboardImage(storyboard, selectedImageId)

  if (!current || currentIndex < 0) {
    throw new Error(
      `Storyboard image "${selectedImageId}" is missing from workspace/STORYBOARD.json.`,
    )
  }

  const pairedEnd =
    current.entry.frameType === 'start' ? getStoryboardPairedEnd(storyboard, selectedImageId) : null
  const removedEntries = pairedEnd ? [current, pairedEnd] : [current]

  for (const entry of removedEntries) {
    const dependents =
      entry.entry.imagePath === null
        ? []
        : await findStoryboardImageDependents(entry.entry.imagePath, cwd)

    if (dependents.length > 0) {
      throw new Error(
        `Storyboard image "${entry.storyboardImageId}" is already referenced by ${dependents.join(', ')} and cannot be removed safely.`,
      )
    }
  }

  const removedIndices = new Set(removedEntries.map((entry) => entry.imageIndex))
  const nextImages = storyboard.images.filter((_, index) => !removedIndices.has(index))

  await writeStoryboardManifest(
    {
      ...storyboard,
      images: nextImages,
    },
    cwd,
  )

  for (const entry of removedEntries) {
    if (entry.entry.imagePath !== null) {
      await rm(resolveRepoPath(entry.entry.imagePath, cwd), { force: true }).catch(() => undefined)
      await rm(
        resolveRepoPath(
          getStoryboardArtifactDescriptor({
            imagePath: entry.entry.imagePath,
            shotId: entry.shotId,
            storyboardImageId: entry.storyboardImageId,
          }).historyDir,
          cwd,
        ),
        {
          recursive: true,
          force: true,
        },
      ).catch(() => undefined)
    }
  }

  const nextSelection =
    nextImages[currentIndex] !== undefined
      ? getStoryboardSelectionId(currentIndex)
      : nextImages[currentIndex - 1] !== undefined
        ? getStoryboardSelectionId(currentIndex - 1)
        : STORYBOARD_NEW_SELECTION_ID

  return redirectTo(
    appendSearchParams(buildPostActionRedirectLocation('/storyboard', request, { updated: true }), {
      image: nextSelection,
    }),
  )
}

async function handleStoryboardAssignment(pathname: string, request: Request, cwd: string) {
  return renderErrorPage(
    'storyboard',
    'Storyboard Order Locked',
    'Storyboard shot ids are now derived from board order and cannot be reassigned manually.',
    '/storyboard',
  )
}

async function handleStoryboardRemoveImage(pathname: string, request: Request, cwd: string) {
  const detail = await getDetailContext(pathname, cwd)

  if (!detail || detail.descriptor.artifactType !== 'storyboard') {
    return renderErrorPage(
      'storyboard',
      'Missing Storyboard Image',
      'Storyboard image not found.',
      '/storyboard',
    )
  }

  const storyboard = await loadStoryboardOrEmpty(cwd)
  const current = findStoryboardImageByArtifactId(storyboard, detail.descriptor.artifactId)

  if (!storyboard || !current || current.entry.imagePath === null) {
    throw new Error(
      `Storyboard image "${detail.descriptor.artifactId}" is missing from workspace/STORYBOARD.json.`,
    )
  }

  const dependents = await findStoryboardImageDependents(current.entry.imagePath, cwd)

  if (dependents.length > 0) {
    throw new Error(
      `Storyboard image "${current.storyboardImageId}" is already referenced by ${dependents.join(', ')} and cannot be removed safely.`,
    )
  }

  await writeStoryboardManifest(
    {
      images: storyboard.images.map((entry, index) =>
        index === current.imageIndex
          ? {
              ...entry,
              imagePath: null,
            }
          : entry,
      ),
    },
    cwd,
  )
  await rm(resolveRepoPath(current.entry.imagePath, cwd), { force: true }).catch(() => undefined)
  await rm(
    resolveRepoPath(
      getStoryboardArtifactDescriptor({
        imagePath: current.entry.imagePath,
        shotId: current.shotId,
        storyboardImageId: current.storyboardImageId,
      }).historyDir,
      cwd,
    ),
    {
      recursive: true,
      force: true,
    },
  ).catch(() => undefined)

  return redirectTo(
    appendSearchParams(buildPostActionRedirectLocation('/storyboard', request, { updated: true }), {
      image: getStoryboardSelectionId(current.imageIndex),
    }),
  )
}

async function handleSelect(pathname: string, request: Request, cwd: string) {
  const detail = await getDetailContext(pathname, cwd)

  if (!detail) {
    return renderErrorPage('characters', 'Missing Artifact', 'Artifact not found.', '/')
  }

  const formData = await request.formData()
  const versionId = String(formData.get('versionId') ?? '').trim()

  if (versionId.length === 0) {
    throw new Error('A retained versionId is required to reselect a version.')
  }

  await promoteArtifactVersion(detail.descriptor, versionId, cwd)
  return redirectTo(
    buildPostActionRedirectLocation(getArtifactDetailPath(detail.descriptor), request, {
      updated: true,
    }),
  )
}

async function handleDelete(pathname: string, request: Request, cwd: string) {
  const detail = await getDetailContext(pathname, cwd)

  if (!detail) {
    return renderErrorPage('characters', 'Missing Artifact', 'Artifact not found.', '/')
  }

  const formData = await request.formData()
  const versionId = String(formData.get('versionId') ?? '').trim()

  if (versionId.length === 0) {
    throw new Error('A retained versionId is required to delete a version.')
  }

  await deleteArtifactVersion(detail.descriptor, versionId, cwd)
  return redirectTo(
    buildPostActionRedirectLocation(getArtifactDetailPath(detail.descriptor), request, {
      updated: true,
    }),
  )
}

async function handleRemove(pathname: string, request: Request, cwd: string) {
  const detail = await getDetailContext(pathname, cwd)

  if (!detail) {
    return renderErrorPage('timeline', 'Missing Keyframe', 'Keyframe not found.', '/timeline')
  }

  const descriptor = await removePlannedKeyframe(detail.descriptor.artifactId, cwd)
  return redirectTo(
    buildPostActionRedirectLocation(getArtifactDetailPath(descriptor), request, {
      updated: true,
    }),
  )
}

async function handleBridge(pathname: string, request: Request, cwd: string) {
  const detail = await getDetailContext(pathname, cwd)

  if (!detail) {
    return renderErrorPage('timeline', 'Missing Keyframe', 'Keyframe not found.', '/timeline')
  }

  const descriptor = await bridgeOmittedEndKeyframe(detail.descriptor.artifactId, cwd)
  const shots = await loadShotPromptsOrEmpty(cwd)
  const sharedStartKeyframeId = getBridgedEndSharedStartKeyframeId(shots, descriptor.artifactId)
  const location = sharedStartKeyframeId
    ? `/keyframes/${encodeURIComponent(sharedStartKeyframeId)}`
    : getArtifactDetailPath(descriptor)

  return redirectTo(
    buildPostActionRedirectLocation(location, request, {
      updated: true,
    }),
  )
}

async function handleUnbridge(pathname: string, request: Request, cwd: string) {
  const detail = await getDetailContext(pathname, cwd)

  if (!detail) {
    return renderErrorPage('timeline', 'Missing Keyframe', 'Keyframe not found.', '/timeline')
  }

  const descriptor = await unbridgeOmittedEndKeyframe(detail.descriptor.artifactId, cwd)
  return redirectTo(
    buildPostActionRedirectLocation(getArtifactDetailPath(descriptor), request, {
      updated: true,
    }),
  )
}

async function handleTimelineUpdate(request: Request, cwd: string) {
  const payload = (await request.json()) as unknown

  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    throw new Error('Timeline update payload must be an object.')
  }

  const rawShots = (payload as { shots?: unknown }).shots

  if (!Array.isArray(rawShots)) {
    throw new Error('Timeline update payload must include a shots array.')
  }

  const shots = await loadShotPrompts(cwd)

  if (rawShots.length !== shots.length) {
    throw new Error('Timeline update must include exactly one duration for each shot.')
  }

  const nextShots = shots.map((shot, index) => {
    const rawEntry = rawShots[index]

    if (typeof rawEntry !== 'object' || rawEntry === null || Array.isArray(rawEntry)) {
      throw new Error(`Timeline shot ${index + 1} must be an object.`)
    }

    const entry = rawEntry as {
      shotId?: unknown
      durationSeconds?: unknown
    }

    if (entry.shotId !== shot.shotId) {
      throw new Error('Timeline update must preserve shot order and identity.')
    }

    if (
      typeof entry.durationSeconds !== 'number' ||
      !Number.isFinite(entry.durationSeconds) ||
      !Number.isInteger(entry.durationSeconds) ||
      entry.durationSeconds < 1
    ) {
      throw new Error(`Timeline duration for shot "${shot.shotId}" must be a positive integer.`)
    }

    return {
      ...shot,
      durationSeconds: entry.durationSeconds,
    }
  })

  await writeShotPromptsFile(nextShots, cwd)

  return new Response(JSON.stringify({ status: 'ok' }), {
    headers: JSON_HEADERS,
  })
}

export function startArtifactReviewServer(
  options: {
    cwd?: string
    preferredPort?: number
    imageGenerator?: ImageGenerator
    shotVideoGenerator?: ShotVideoGenerator
  } = {},
) {
  const { cwd = process.cwd(), preferredPort = 3000, imageGenerator, shotVideoGenerator } = options
  const activeJobs = new Map<string, ArtifactJobState>()
  const generatorOverrides: RegenerateActionOptions = {
    imageGenerator,
    shotVideoGenerator,
  }

  const createServer = (port: number) =>
    Bun.serve({
      port,
      async fetch(request) {
        const url = new URL(request.url)
        const isEmbedded = url.searchParams.get('embed') === '1'

        if (!['GET', 'HEAD', 'POST'].includes(request.method)) {
          return new Response('Method Not Allowed', {
            status: 405,
            headers: {
              allow: 'GET, HEAD, POST',
            },
          })
        }

        try {
          if ((request.method === 'GET' || request.method === 'HEAD') && url.pathname === '/') {
            return renderCharactersSummary(await buildCharacterCards(cwd))
          }

          if ((request.method === 'GET' || request.method === 'HEAD') && url.pathname === '/idea') {
            return renderWorkspaceMarkdownDocumentPage({
              activeTab: 'idea',
              title: 'Idea',
              eyebrow: 'Creative Brief',
              subtitle:
                'Review the current project idea and brief before moving into story, storyboard, and downstream artifact work.',
              sectionTitle: 'workspace/IDEA.md',
              markdown: await loadWorkspaceMarkdownDocument('IDEA.md', cwd),
              emptyState: 'No idea markdown yet.',
            })
          }

          if (
            (request.method === 'GET' || request.method === 'HEAD') &&
            url.pathname === '/story'
          ) {
            return renderWorkspaceMarkdownDocumentPage({
              activeTab: 'story',
              title: 'Story',
              eyebrow: 'Narrative Draft',
              subtitle:
                'Review the current story draft in its canonical workspace file before locking storyboard and shot planning.',
              sectionTitle: 'workspace/STORY.md',
              markdown: await loadWorkspaceMarkdownDocument('STORY.md', cwd),
              emptyState: 'No story markdown yet.',
            })
          }

          if (
            (request.method === 'GET' || request.method === 'HEAD') &&
            (url.pathname === '/keyframes' || url.pathname === '/shots')
          ) {
            return redirectTo('/timeline', 302)
          }

          if (
            (request.method === 'GET' || request.method === 'HEAD') &&
            url.pathname === '/timeline'
          ) {
            const shots = await loadShotPromptsOrEmpty(cwd)

            return new Response(
              renderPage(
                'timeline',
                `<div class="stack">
                  ${renderTimelineContent(await buildTimelineData(shots, cwd))}
                </div>`,
              ),
              { headers: HTML_HEADERS },
            )
          }

          if (
            (request.method === 'GET' || request.method === 'HEAD') &&
            url.pathname === '/storyboard'
          ) {
            const storyboard = await loadStoryboardOrEmpty(cwd)
            const selected = getStoryboardSelectionState(storyboard, url.searchParams.get('image'))
            const slots = await buildStoryboardGridSlots(storyboard, selected.selectedImageId, cwd)
            const cards = await buildStoryboardCards(cwd)
            const selectedCard = selected.selectedEntry
              ? (cards.find(
                  (card) =>
                    card.selectionId ===
                    getStoryboardSelectionId(selected.selectedEntry!.imageIndex),
                ) ?? null)
              : null
            const selectedJob = selected.selectedEntry
              ? selected.selectedEntry.entry.imagePath
                ? getJobState(
                    activeJobs,
                    getStoryboardArtifactDescriptor({
                      imagePath: selected.selectedEntry.entry.imagePath,
                      shotId: selected.selectedEntry.shotId,
                      storyboardImageId: selected.selectedEntry.storyboardImageId,
                    }),
                  )
                : null
              : null

            return renderStoryboardSummary({
              storyboard,
              config: await loadConfig(cwd).catch(() => null),
              slots,
              selected,
              selectedCard,
              job: selectedJob,
            })
          }

          if (
            (request.method === 'GET' || request.method === 'HEAD') &&
            /^\/storyboard\/images\/[^/]+$/.test(url.pathname)
          ) {
            const storyboard = await loadStoryboardOrEmpty(cwd)
            const storyboardImage = findStoryboardImageByArtifactId(
              storyboard,
              decodeURIComponent(url.pathname.split('/')[3]!),
            )

            return redirectTo(
              appendSearchParams('/storyboard', {
                image: storyboardImage
                  ? getStoryboardSelectionId(storyboardImage.imageIndex)
                  : STORYBOARD_NEW_SELECTION_ID,
              }),
              302,
            )
          }

          if (
            (request.method === 'GET' || request.method === 'HEAD') &&
            /^\/characters\/[^/]+$/.test(url.pathname)
          ) {
            const detail = await loadCharacterDetail(
              decodeURIComponent(url.pathname.split('/')[2]!),
              cwd,
              url.searchParams.get('version'),
            )

            if (!detail) {
              return renderErrorPage('characters', 'Missing Character', 'Character not found.', '/')
            }

            return renderDetailPage(detail, getJobState(activeJobs, detail.descriptor), {
              embedded: isEmbedded,
              refreshParentDetailUrl: getEmbeddedRefreshDetailUrl(url),
            })
          }

          if (
            (request.method === 'GET' || request.method === 'HEAD') &&
            /^\/keyframes\/[^/]+$/.test(url.pathname)
          ) {
            const shots = await loadShotPromptsOrEmpty(cwd)
            const sharedStartKeyframeId = getBridgedEndSharedStartKeyframeId(
              shots,
              decodeURIComponent(url.pathname.split('/')[2]!),
            )

            if (sharedStartKeyframeId) {
              return redirectTo(
                appendSearchParams(`/keyframes/${encodeURIComponent(sharedStartKeyframeId)}`, {
                  embed: isEmbedded,
                  version: url.searchParams.get('version'),
                  updated: url.searchParams.get('updated'),
                }),
                302,
              )
            }

            const detail = await getDetailContext(
              url.pathname,
              cwd,
              url.searchParams.get('version'),
            )

            if (!detail) {
              return renderErrorPage(
                'timeline',
                'Missing Keyframe',
                'Keyframe not found.',
                '/timeline',
              )
            }

            return renderDetailPage(detail, getJobState(activeJobs, detail.descriptor), {
              embedded: isEmbedded,
              refreshParentDetailUrl: getEmbeddedRefreshDetailUrl(url),
            })
          }

          if (
            (request.method === 'GET' || request.method === 'HEAD') &&
            /^\/shots\/[^/]+$/.test(url.pathname)
          ) {
            const detail = await loadShotDetail(
              decodeURIComponent(url.pathname.split('/')[2]!),
              cwd,
              url.searchParams.get('version'),
            )

            if (!detail) {
              return renderErrorPage('timeline', 'Missing Shot', 'Shot not found.', '/timeline')
            }

            return renderDetailPage(detail, getJobState(activeJobs, detail.descriptor), {
              embedded: isEmbedded,
              refreshParentDetailUrl: getEmbeddedRefreshDetailUrl(url),
            })
          }

          if (
            (request.method === 'GET' || request.method === 'HEAD') &&
            /^\/storyboard\/images\/[^/]+\/versions\/[^/]+\/media$/.test(url.pathname)
          ) {
            const storyboard = await loadStoryboardOrEmpty(cwd)
            const storyboardImage = findStoryboardImageByArtifactId(
              storyboard,
              decodeURIComponent(url.pathname.split('/')[3]!),
            )

            if (!storyboardImage || storyboardImage.entry.imagePath === null) {
              return new Response('Not Found', { status: 404 })
            }

            return serveArtifactVersionMedia(
              getStoryboardArtifactDescriptor({
                imagePath: storyboardImage.entry.imagePath,
                shotId: storyboardImage.shotId,
                storyboardImageId: storyboardImage.storyboardImageId,
              }),
              decodeURIComponent(url.pathname.split('/')[5]!),
              cwd,
            )
          }

          if (
            (request.method === 'GET' || request.method === 'HEAD') &&
            /^\/characters\/[^/]+\/versions\/[^/]+\/media$/.test(url.pathname)
          ) {
            return serveArtifactVersionMedia(
              getCharacterArtifactDescriptor(decodeURIComponent(url.pathname.split('/')[2]!)),
              decodeURIComponent(url.pathname.split('/')[4]!),
              cwd,
            )
          }

          if (
            (request.method === 'GET' || request.method === 'HEAD') &&
            /^\/keyframes\/[^/]+\/versions\/[^/]+\/media$/.test(url.pathname)
          ) {
            const keyframeId = decodeURIComponent(url.pathname.split('/')[2]!)
            const keyframe = (await loadKeyframesOrEmpty(cwd)).find(
              (entry) => entry.keyframeId === keyframeId,
            )

            if (!keyframe) {
              return new Response('Not Found', { status: 404 })
            }

            return serveArtifactVersionMedia(
              getKeyframeArtifactDescriptor(keyframe),
              decodeURIComponent(url.pathname.split('/')[4]!),
              cwd,
            )
          }

          if (
            (request.method === 'GET' || request.method === 'HEAD') &&
            /^\/shots\/[^/]+\/versions\/[^/]+\/media$/.test(url.pathname)
          ) {
            return serveArtifactVersionMedia(
              getShotArtifactDescriptor(decodeURIComponent(url.pathname.split('/')[2]!)),
              decodeURIComponent(url.pathname.split('/')[4]!),
              cwd,
            )
          }

          if (request.method === 'POST' && url.pathname === '/timeline/update') {
            try {
              return await handleTimelineUpdate(request, cwd)
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error)

              return new Response(JSON.stringify({ error: message }), {
                status: 400,
                headers: JSON_HEADERS,
              })
            }
          }

          if (request.method === 'POST' && url.pathname === '/storyboard/save') {
            return await handleStoryboardSave(request, cwd)
          }

          if (request.method === 'POST' && url.pathname === '/storyboard/render') {
            return await handleStoryboardRender(request, cwd, activeJobs, generatorOverrides)
          }

          if (request.method === 'POST' && url.pathname === '/storyboard/insert-end') {
            return await handleStoryboardInsertEnd(request, cwd, activeJobs, generatorOverrides)
          }

          if (request.method === 'POST' && url.pathname === '/storyboard/delete') {
            return await handleStoryboardDelete(request, cwd)
          }

          if (request.method === 'POST' && /\/references$/.test(url.pathname)) {
            return await handleReferenceSave(
              url.pathname.replace(/\/references$/, ''),
              request,
              cwd,
            )
          }

          if (request.method === 'POST' && /\/create$/.test(url.pathname)) {
            return await handleCreate(
              url.pathname.replace(/\/create$/, ''),
              request,
              cwd,
              activeJobs,
              generatorOverrides,
            )
          }

          if (request.method === 'POST' && /\/generate$/.test(url.pathname)) {
            return await handleGenerate(
              url.pathname.replace(/\/generate$/, ''),
              request,
              cwd,
              activeJobs,
              generatorOverrides,
            )
          }

          if (request.method === 'POST' && /\/regenerate$/.test(url.pathname)) {
            return await handleRegenerate(
              url.pathname.replace(/\/regenerate$/, ''),
              request,
              cwd,
              activeJobs,
              generatorOverrides,
            )
          }

          if (request.method === 'POST' && /\/bridge$/.test(url.pathname)) {
            return await handleBridge(url.pathname.replace(/\/bridge$/, ''), request, cwd)
          }

          if (request.method === 'POST' && /\/unbridge$/.test(url.pathname)) {
            return await handleUnbridge(url.pathname.replace(/\/unbridge$/, ''), request, cwd)
          }

          if (request.method === 'POST' && /\/select$/.test(url.pathname)) {
            return await handleSelect(url.pathname.replace(/\/select$/, ''), request, cwd)
          }

          if (request.method === 'POST' && /\/delete$/.test(url.pathname)) {
            return await handleDelete(url.pathname.replace(/\/delete$/, ''), request, cwd)
          }

          if (request.method === 'POST' && /\/assignment$/.test(url.pathname)) {
            return await handleStoryboardAssignment(
              url.pathname.replace(/\/assignment$/, ''),
              request,
              cwd,
            )
          }

          if (request.method === 'POST' && /\/remove-image$/.test(url.pathname)) {
            return await handleStoryboardRemoveImage(
              url.pathname.replace(/\/remove-image$/, ''),
              request,
              cwd,
            )
          }

          if (request.method === 'POST' && /\/remove$/.test(url.pathname)) {
            return await handleRemove(url.pathname.replace(/\/remove$/, ''), request, cwd)
          }

          if (
            (request.method === 'GET' || request.method === 'HEAD') &&
            url.pathname.startsWith('/workspace/CHARACTERS/')
          ) {
            return serveCanonicalCharacterImage(url.pathname, cwd)
          }

          if (
            (request.method === 'GET' || request.method === 'HEAD') &&
            (url.pathname.startsWith('/workspace/STORYBOARD/') ||
              url.pathname === `/${getLegacyStoryboardImagePath()}`)
          ) {
            return serveCanonicalStoryboardImage(url.pathname, cwd)
          }

          if (
            (request.method === 'GET' || request.method === 'HEAD') &&
            url.pathname.startsWith('/workspace/KEYFRAMES/')
          ) {
            return serveCanonicalKeyframeImage(url.pathname, cwd)
          }

          if (
            (request.method === 'GET' || request.method === 'HEAD') &&
            url.pathname.startsWith('/workspace/SHOTS/')
          ) {
            return serveCanonicalShotVideo(url.pathname, cwd)
          }

          return new Response('Not Found', { status: 404 })
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          const activeTab: Tab = url.pathname.startsWith('/timeline')
            ? 'timeline'
            : url.pathname.startsWith('/shots') || url.pathname.startsWith('/keyframes')
              ? 'timeline'
              : url.pathname.startsWith('/storyboard')
                ? 'storyboard'
                : url.pathname.startsWith('/story')
                  ? 'story'
                  : url.pathname.startsWith('/idea')
                    ? 'idea'
                    : 'characters'

          return new Response(
            renderPage(
              activeTab,
              `<div class="stack">
                ${renderHero('Artifact Review Error', message, 'Server Error')}
              </div>`,
              { embedded: isEmbedded },
            ),
            {
              status: 400,
              headers: HTML_HEADERS,
            },
          )
        }
      },
    })

  let server: Bun.Server<undefined>

  try {
    server = createServer(preferredPort)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)

    if (!message.toLowerCase().includes('port') && !message.toLowerCase().includes('address')) {
      throw error
    }

    server = createServer(0)
  }

  let stopped = false
  const activePort = server.port

  if (activePort === undefined) {
    throw new Error('Artifact review server started without a bound port.')
  }

  return {
    port: activePort,
    url: server.url.toString(),
    stop: async () => {
      if (stopped) {
        return
      }

      stopped = true
      await server.stop(true)
    },
  } satisfies ArtifactReviewServer
}
