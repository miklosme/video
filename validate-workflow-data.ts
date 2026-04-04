import { access } from 'node:fs/promises'
import path from 'node:path'

import { resolveFinalCutProps, validateFinalCutManifestAgainstShots } from './final-cut'
import { ensureActiveWorkspace } from './project-workspace'
import {
  LEGACY_KEYFRAMES_FILE,
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
  type CharacterSheetEntry,
  type FrameType,
  type KeyframeArtifactEntry,
  type KeyframeEntry,
  type ShotArtifactEntry,
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

function validateKeyframeArtifacts(keyframes: KeyframeEntry[], artifacts: KeyframeArtifactEntry[]) {
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
  }
}

export async function validateKeyframeArtifactReferences(
  keyframes: KeyframeEntry[],
  artifacts: KeyframeArtifactEntry[],
) {
  const keyframeById = new Map(keyframes.map((entry) => [entry.keyframeId, entry]))

  for (const artifact of artifacts) {
    await validateArtifactReferencesExist(
      artifact.references,
      `Keyframe artifact "${artifact.keyframeId}"`,
    )

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

async function validateShotArtifacts(shots: ShotEntry[], artifacts: ShotArtifactEntry[]) {
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

    await validateArtifactReferencesExist(artifact.references, `Shot artifact "${artifact.shotId}"`)
  }
}

export async function validateStoryboardSidecar(sidecar: StoryboardSidecar | null) {
  if (!sidecar) {
    throw new Error('workspace/STORYBOARD.json is required.')
  }

  const context = 'workspace/STORYBOARD.json'
  const references = sidecar.references ?? []

  await validateArtifactReferencesExist(references, context)

  if (references.length === 0) {
    throw new Error(`${context} must declare a storyboard-template reference.`)
  }

  assertReferenceAtIndex(
    references,
    0,
    {
      kind: 'storyboard-template',
      path: 'templates/STORYBOARD.template.png',
    },
    context,
  )

  for (const [index, reference] of references.entries()) {
    if (index === 0) {
      continue
    }

    if (reference.kind !== 'user-reference') {
      throw new Error(
        `${context} reference ${index + 1} must use kind "user-reference" after the storyboard template reference.`,
      )
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

    if (index === 0 && shot.incomingTransition.type !== 'opening') {
      throw new Error(
        `Shot "${shot.shotId}" is the first SHOTS.json entry, so incomingTransition.type must be "opening".`,
      )
    }

    if (index > 0 && shot.incomingTransition.type === 'opening') {
      throw new Error(
        `Shot "${shot.shotId}" may not use incomingTransition.type "opening" unless it is the first SHOTS.json entry.`,
      )
    }

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
  await requireRepoPath(MODEL_OPTIONS_FILE, MODEL_OPTIONS_FILE)
  await requireWorkspacePath('IDEA.md', 'workspace/IDEA.md')
  await requireWorkspacePath(WORKFLOW_FILES.config, 'workspace/CONFIG.json')
  await requireWorkspacePath(WORKFLOW_FILES.status, 'workspace/STATUS.json')
  await requireWorkspacePath(WORKFLOW_FILES.storyboardSidecar, 'workspace/STORYBOARD.json')

  const modelOptions = await loadModelOptions()
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
  const keyframeImagesMissing =
    keyframeArtifacts.length > 0 &&
    (
      await Promise.all(
        keyframes.map((entry) =>
          workspacePathExists(entry.imagePath.replace(/^workspace\//, ''), process.cwd()),
        ),
      )
    ).some((imageExists) => !imageExists)

  if (storyboardReviewChecked || keyframeImagesMissing) {
    await requireWorkspacePath(WORKFLOW_FILES.storyboard, 'workspace/STORYBOARD.md')
    await requireWorkspacePath(WORKFLOW_FILES.storyboardImage, 'workspace/STORYBOARD.png')
  }

  await validateCharacterSheets(characterSheets)
  await validateKeyframes(keyframes)
  validateKeyframeArtifacts(keyframes, keyframeArtifacts)
  await validateKeyframeArtifactReferences(keyframes, keyframeArtifacts)
  validateShots(keyframes, shots)
  await validateShotArtifacts(shots, shotArtifacts)
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
