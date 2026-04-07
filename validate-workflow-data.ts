import { access } from 'node:fs/promises'
import path from 'node:path'

import { resolveFinalCutProps, validateFinalCutManifestAgainstShots } from './final-cut'
import { ensureActiveWorkspace } from './project-workspace'
import {
  CAMERA_VOCABULARY_FILE,
  getStoryboardSidecarPath,
  LEGACY_KEYFRAMES_FILE,
  loadCameraVocabulary,
  loadCharacterSheets,
  loadConfig,
  loadFinalCut,
  loadKeyframeArtifacts,
  loadKeyframes,
  loadModelOptions,
  loadShotArtifacts,
  loadShotPrompts,
  loadStatus,
  loadStoryboardSidecar,
  MODEL_OPTIONS_FILE,
  resolveRepoPath,
  resolveWorkflowPath,
  validateConfigAgainstModelOptions,
  WORKFLOW_FILES,
  workspacePathExists,
  type ArtifactReferenceEntry,
  type CameraVocabularyCategory,
  type CameraVocabularyData,
  type CharacterSheetEntry,
  type FrameType,
  type KeyframeArtifactEntry,
  type KeyframeCameraSpec,
  type KeyframeEntry,
  type ShotArtifactEntry,
  type ShotCameraSpec,
  type ShotEntry,
  type StoryboardSidecar,
} from './workflow-data'

async function requireWorkspacePath(fileName: string, label: string) {
  const filePath = resolveWorkflowPath(fileName)

  try {
    await access(filePath)
  } catch {
    throw new Error(`${label} is required at ${path.relative(process.cwd(), filePath)}.`)
  }

  return filePath
}

async function requireRepoPath(fileName: string, label: string) {
  const filePath = resolveRepoPath(fileName)

  try {
    await access(filePath)
  } catch {
    throw new Error(`${label} is required at ${path.relative(process.cwd(), filePath)}.`)
  }

  return filePath
}

async function validateArtifactReferencesExist(
  references: readonly ArtifactReferenceEntry[] | undefined,
  context: string,
) {
  const seenPaths = new Set<string>()

  for (const reference of references ?? []) {
    if (seenPaths.has(reference.path)) {
      throw new Error(`${context} has duplicate reference path "${reference.path}".`)
    }

    seenPaths.add(reference.path)
    const absoluteReferencePath = resolveRepoPath(reference.path)

    try {
      await access(absoluteReferencePath)
    } catch {
      throw new Error(
        `${context} references missing file "${path.relative(process.cwd(), absoluteReferencePath)}".`,
      )
    }
  }
}

function groupByShotId<T extends { shotId: string }>(entries: T[]) {
  const grouped = new Map<string, T[]>()

  for (const entry of entries) {
    const shotEntries = grouped.get(entry.shotId) ?? []
    shotEntries.push(entry)
    grouped.set(entry.shotId, shotEntries)
  }

  return grouped
}

function summarizeFrameTypes(entries: { frameType: FrameType }[]) {
  return [...new Set(entries.map((entry) => entry.frameType))].sort().join(', ')
}

function assertReferenceAtIndex(
  references: readonly ArtifactReferenceEntry[],
  index: number,
  expected: Pick<ArtifactReferenceEntry, 'kind' | 'path'>,
  context: string,
) {
  const actual = references[index]

  if (actual?.kind === expected.kind && actual.path === expected.path) {
    return
  }

  throw new Error(
    `${context} reference ${index + 1} must be ${expected.kind} at "${expected.path}".`,
  )
}

function validateCameraField(
  value: string,
  expectedCategory: CameraVocabularyCategory,
  context: string,
  vocabulary: CameraVocabularyData,
  applicability: 'keyframe' | 'shot',
) {
  const entry = vocabulary.entries.find((candidate) => candidate.id === value)

  if (!entry) {
    throw new Error(`${context} must match a camera vocabulary id from ${CAMERA_VOCABULARY_FILE}.`)
  }

  if (entry.category !== expectedCategory) {
    throw new Error(`${context} must use a ${expectedCategory} id from ${CAMERA_VOCABULARY_FILE}.`)
  }

  if (applicability === 'keyframe' && !entry.appliesToKeyframe) {
    throw new Error(`${context} does not apply to keyframes in ${CAMERA_VOCABULARY_FILE}.`)
  }

  if (applicability === 'shot' && !entry.appliesToShot) {
    throw new Error(`${context} does not apply to shots in ${CAMERA_VOCABULARY_FILE}.`)
  }
}

function validateKeyframeCamera(
  camera: KeyframeCameraSpec,
  context: string,
  vocabulary: CameraVocabularyData,
) {
  validateCameraField(camera.shotSize, 'shot_size', `${context}.shotSize`, vocabulary, 'keyframe')
  validateCameraField(
    camera.cameraPosition,
    'camera_position',
    `${context}.cameraPosition`,
    vocabulary,
    'keyframe',
  )
  validateCameraField(
    camera.cameraAngle,
    'camera_angle',
    `${context}.cameraAngle`,
    vocabulary,
    'keyframe',
  )
}

function validateShotCamera(
  camera: ShotCameraSpec,
  context: string,
  vocabulary: CameraVocabularyData,
) {
  validateKeyframeCamera(camera, context, vocabulary)
  validateCameraField(
    camera.cameraMovement,
    'camera_movement',
    `${context}.cameraMovement`,
    vocabulary,
    'shot',
  )
}

async function validateKeyframes(keyframes: KeyframeEntry[]) {
  const keyframeIds = new Set<string>()

  for (const entry of keyframes) {
    if (keyframeIds.has(entry.keyframeId)) {
      throw new Error(`Duplicate keyframeId "${entry.keyframeId}" in workspace/SHOTS.json.`)
    }

    keyframeIds.add(entry.keyframeId)
  }

  for (const [shotId, entries] of groupByShotId(keyframes)) {
    const frameTypes = new Set(entries.map((entry) => entry.frameType))

    if (entries.length === 1 && (frameTypes.has('start') || frameTypes.has('end'))) {
      continue
    }

    if (entries.length !== 2 || !frameTypes.has('start') || !frameTypes.has('end')) {
      throw new Error(
        `Shot "${shotId}" must have either one anchor keyframe ("start" or "end") or exactly one "start" and one "end" keyframe. Found ${entries.length} entry/entries with frame types: ${summarizeFrameTypes(entries)}.`,
      )
    }
  }
}

function validateKeyframeArtifacts(
  keyframes: KeyframeEntry[],
  artifacts: KeyframeArtifactEntry[],
  vocabulary: CameraVocabularyData,
) {
  const keyframeById = new Map(keyframes.map((entry) => [entry.keyframeId, entry]))
  const artifactIds = new Set<string>()

  for (const artifact of artifacts) {
    if (artifactIds.has(artifact.keyframeId)) {
      throw new Error(
        `Duplicate keyframe artifact "${artifact.keyframeId}" in workspace/KEYFRAMES/.`,
      )
    }

    artifactIds.add(artifact.keyframeId)

    const keyframe = keyframeById.get(artifact.keyframeId)

    if (!keyframe) {
      continue
    }

    if (artifact.shotId !== keyframe.shotId) {
      throw new Error(
        `Keyframe artifact "${artifact.keyframeId}" has shotId "${artifact.shotId}" but keyframe "${artifact.keyframeId}" belongs to shot "${keyframe.shotId}".`,
      )
    }

    if (artifact.frameType !== keyframe.frameType) {
      throw new Error(
        `Keyframe artifact "${artifact.keyframeId}" has frameType "${artifact.frameType}" but keyframe "${artifact.keyframeId}" uses frameType "${keyframe.frameType}".`,
      )
    }

    if (artifact.camera) {
      validateKeyframeCamera(
        artifact.camera,
        `Keyframe artifact "${artifact.keyframeId}".camera`,
        vocabulary,
      )
    }
  }
}

export async function validateKeyframeArtifactReferences(
  keyframes: KeyframeEntry[],
  artifacts: KeyframeArtifactEntry[],
) {
  const keyframeById = new Map(keyframes.map((entry) => [entry.keyframeId, entry]))

  for (const artifact of artifacts) {
    const references = artifact.references ?? []

    if (references.length === 0) {
      throw new Error(
        `Keyframe artifact "${artifact.keyframeId}" must declare explicit references.`,
      )
    }

    await validateArtifactReferencesExist(references, `Keyframe artifact "${artifact.keyframeId}"`)

    const keyframe = keyframeById.get(artifact.keyframeId)

    if (!keyframe) {
      continue
    }
  }
}

async function validateCharacterSheets(characterSheets: CharacterSheetEntry[]) {
  const characterIds = new Set<string>()

  for (const entry of characterSheets) {
    if (characterIds.has(entry.characterId)) {
      throw new Error(`Duplicate character sheet "${entry.characterId}" in workspace/CHARACTERS/.`)
    }

    characterIds.add(entry.characterId)
    await validateArtifactReferencesExist(
      entry.references,
      `Character sheet "${entry.characterId}"`,
    )
  }
}

async function validateShotArtifacts(
  shots: ShotEntry[],
  artifacts: ShotArtifactEntry[],
  vocabulary: CameraVocabularyData,
) {
  const shotById = new Map(shots.map((entry) => [entry.shotId, entry]))
  const artifactIds = new Set<string>()

  for (const artifact of artifacts) {
    if (artifactIds.has(artifact.shotId)) {
      throw new Error(`Duplicate shot artifact "${artifact.shotId}" in workspace/SHOTS/.`)
    }

    artifactIds.add(artifact.shotId)

    const shot = shotById.get(artifact.shotId)

    if (!shot) {
      continue
    }

    if (artifact.shotId !== shot.shotId) {
      throw new Error(
        `Shot artifact "${artifact.shotId}" has shotId "${artifact.shotId}" but shot "${shot.shotId}" uses a different ID.`,
      )
    }

    if (artifact.camera) {
      validateShotCamera(artifact.camera, `Shot artifact "${artifact.shotId}".camera`, vocabulary)
    }
    await validateArtifactReferencesExist(artifact.references, `Shot artifact "${artifact.shotId}"`)
  }
}

export async function validateStoryboardSidecar(sidecar: StoryboardSidecar | null) {
  if (!sidecar) {
    throw new Error(`${getStoryboardSidecarPath()} is required.`)
  }

  const context = getStoryboardSidecarPath()
  const seenImagePaths = new Set<string>()

  if (sidecar.images.length === 0) {
    throw new Error(`${context} must declare at least one storyboard image.`)
  }

  for (const [index, image] of sidecar.images.entries()) {
    const imageContext = `${context}.images[${index}]`
    const previousImage = index > 0 ? (sidecar.images[index - 1] ?? null) : null

    if (image.imagePath !== null) {
      if (seenImagePaths.has(image.imagePath)) {
        throw new Error(`${context} has duplicate imagePath "${image.imagePath}".`)
      }

      seenImagePaths.add(image.imagePath)
    }

    if (image.frameType === 'end' && previousImage?.frameType !== 'start') {
      throw new Error(`${imageContext} must directly follow a matching start frame in ${context}.`)
    }
  }
}

export function validateShots(keyframes: KeyframeEntry[], shots: ShotEntry[]) {
  const keyframeById = new Map(keyframes.map((entry) => [entry.keyframeId, entry]))
  const shotIds = new Set<string>()

  for (const [index, shot] of shots.entries()) {
    if (shotIds.has(shot.shotId)) {
      throw new Error(`Duplicate shotId "${shot.shotId}" in workspace/SHOTS.json.`)
    }

    shotIds.add(shot.shotId)

    if (shot.keyframeIds.length === 0 || shot.keyframeIds.length > 2) {
      throw new Error(
        `Shot "${shot.shotId}" must reference either one anchor keyframe or a start/end pair.`,
      )
    }

    const anchors = shot.keyframeIds.map((keyframeId) => {
      const anchor = keyframeById.get(keyframeId)

      if (!anchor) {
        throw new Error(`Shot "${shot.shotId}" references missing keyframe "${keyframeId}".`)
      }

      return anchor
    })

    if (anchors.some((anchor) => anchor.shotId !== shot.shotId)) {
      throw new Error(
        `Shot "${shot.shotId}" must only reference keyframes from shot "${shot.shotId}".`,
      )
    }

    const frameTypes = new Set(anchors.map((anchor) => anchor.frameType))

    if (shot.endFrameMode === 'bridge') {
      if (index === shots.length - 1) {
        throw new Error(
          `Shot "${shot.shotId}" cannot use endFrameMode "bridge" because there is no next shot.`,
        )
      }

      if (!frameTypes.has('start')) {
        throw new Error(
          `Shot "${shot.shotId}" must keep a local "start" keyframe when endFrameMode is "bridge".`,
        )
      }

      if (frameTypes.has('end')) {
        throw new Error(
          `Shot "${shot.shotId}" cannot use endFrameMode "bridge" while also planning a distinct "end" keyframe.`,
        )
      }

      const nextShot = shots[index + 1]

      if (!nextShot) {
        throw new Error(
          `Shot "${shot.shotId}" cannot use endFrameMode "bridge" because there is no next shot.`,
        )
      }

      const nextShotFrameTypes = new Set(
        nextShot.keyframeIds
          .map((keyframeId) => keyframeById.get(keyframeId))
          .filter((anchor): anchor is KeyframeEntry => anchor !== undefined)
          .map((anchor) => anchor.frameType),
      )

      if (!nextShotFrameTypes.has('start')) {
        throw new Error(
          `Shot "${shot.shotId}" cannot use endFrameMode "bridge" because next shot "${nextShot.shotId}" has no planned "start" keyframe.`,
        )
      }
    }

    if (anchors.length === 1) {
      if (!frameTypes.has('start') && !frameTypes.has('end')) {
        throw new Error(
          `Shot "${shot.shotId}" references one keyframe, so it must use frameType "start" or "end".`,
        )
      }

      continue
    }

    if (!frameTypes.has('start') || !frameTypes.has('end')) {
      throw new Error(
        `Shot "${shot.shotId}" must reference one "start" and one "end" keyframe when using two anchors. Found frame types: ${summarizeFrameTypes(anchors)}.`,
      )
    }
  }
}

async function main() {
  await ensureActiveWorkspace()
  await requireRepoPath(CAMERA_VOCABULARY_FILE, CAMERA_VOCABULARY_FILE)
  await requireRepoPath(MODEL_OPTIONS_FILE, MODEL_OPTIONS_FILE)
  await requireWorkspacePath('IDEA.md', 'workspace/IDEA.md')
  await requireWorkspacePath(WORKFLOW_FILES.config, 'workspace/CONFIG.json')
  await requireWorkspacePath(WORKFLOW_FILES.status, 'workspace/STATUS.json')
  await requireWorkspacePath(WORKFLOW_FILES.storyboardSidecar, getStoryboardSidecarPath())

  const modelOptions = await loadModelOptions()
  const cameraVocabulary = await loadCameraVocabulary()
  const config = await loadConfig()
  validateConfigAgainstModelOptions(config, modelOptions)
  const status = await loadStatus()
  const legacyKeyframesExists = await workspacePathExists(LEGACY_KEYFRAMES_FILE)
  const shotPromptsExists = await workspacePathExists(WORKFLOW_FILES.shotPrompts)
  const finalCutExists = await workspacePathExists(WORKFLOW_FILES.finalCut)
  const characterSheets = await loadCharacterSheets()
  const keyframeArtifacts = await loadKeyframeArtifacts()
  const shotArtifacts = await loadShotArtifacts()
  const storyboardSidecar = await loadStoryboardSidecar()

  if (legacyKeyframesExists) {
    throw new Error(
      `Legacy ${LEGACY_KEYFRAMES_FILE} is no longer supported. Merge its entries into ${WORKFLOW_FILES.shotPrompts} and remove the old file.`,
    )
  }

  const keyframes = shotPromptsExists ? await loadKeyframes() : []
  const shots = shotPromptsExists ? await loadShotPrompts() : []

  const storyboardReviewChecked = status.some(
    (item) => item.title.trim().toLowerCase() === 'review storyboard' && item.checked,
  )

  if (storyboardReviewChecked) {
    const plannedStoryboardImages = storyboardSidecar?.images ?? []
    const storyboardImageStates = await Promise.all(
      plannedStoryboardImages.map((entry) =>
        entry.imagePath === null
          ? false
          : workspacePathExists(entry.imagePath.replace(/^workspace\//, ''), process.cwd()),
      ),
    )

    if (
      plannedStoryboardImages.length > 0 &&
      !storyboardImageStates.every(Boolean) &&
      !(await workspacePathExists(WORKFLOW_FILES.storyboardImage, process.cwd()))
    ) {
      throw new Error(
        'Review storyboard is checked, so every planned workspace/STORYBOARD/*.png image must exist, or the legacy workspace/STORYBOARD.png fallback must still be present during migration.',
      )
    }
  }

  await validateCharacterSheets(characterSheets)
  await validateKeyframes(keyframes)
  validateKeyframeArtifacts(keyframes, keyframeArtifacts, cameraVocabulary)
  await validateKeyframeArtifactReferences(keyframes, keyframeArtifacts)
  validateShots(keyframes, shots)
  await validateShotArtifacts(shots, shotArtifacts, cameraVocabulary)
  await validateStoryboardSidecar(storyboardSidecar)

  if (finalCutExists) {
    const finalCut = await loadFinalCut()
    const { enabledShots, shotPromptById } = validateFinalCutManifestAgainstShots(finalCut, shots)
    const allEnabledShotVideosExist = (
      await Promise.all(
        enabledShots.map(async (shot) => {
          const shotPrompt = shotPromptById.get(shot.shotId)

          if (!shotPrompt) {
            throw new Error(`Missing shot prompt for "${shot.shotId}".`)
          }

          return workspacePathExists(
            shotPrompt.videoPath.replace(/^workspace\//, ''),
            process.cwd(),
          )
        }),
      )
    ).every(Boolean)

    if (allEnabledShotVideosExist) {
      await resolveFinalCutProps(process.cwd(), { assetBaseUrl: 'http://127.0.0.1:1' })
    }
  }

  console.log(
    JSON.stringify(
      {
        status: 'ok',
        ideaPresent: true,
        config,
        statusItems: status.length,
        readyMilestones: status.filter((item) => item.checked).length,
        characterSheetsCount: characterSheets.length,
        keyframesPresent: shotPromptsExists,
        keyframesCount: keyframes.length,
        keyframeArtifactsCount: keyframeArtifacts.length,
        shotPromptsPresent: shotPromptsExists,
        shotPromptsCount: shots.length,
        shotArtifactsCount: shotArtifacts.length,
      },
      null,
      2,
    ),
  )
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
}
