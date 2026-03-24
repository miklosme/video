import { access } from 'node:fs/promises'
import path from 'node:path'

import { resolveFinalCutProps } from './final-cut'
import {
  getCharacterSheetImagePath,
  loadCharacterSheets,
  loadConfig,
  loadKeyframeArtifacts,
  loadKeyframes,
  loadModelOptions,
  loadShotArtifacts,
  loadShotPrompts,
  loadStatus,
  MODEL_OPTIONS_FILE,
  resolveRepoPath,
  resolveWorkflowPath,
  validateConfigAgainstModelOptions,
  WORKFLOW_FILES,
  workspacePathExists,
  type CharacterSheetEntry,
  type FrameType,
  type KeyframeArtifactEntry,
  type KeyframeEntry,
  type ShotArtifactEntry,
  type ShotEntry,
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

async function validateKeyframes(
  keyframes: KeyframeEntry[],
  characterSheets: CharacterSheetEntry[],
) {
  const keyframeIds = new Set<string>()
  const characterIds = new Set(characterSheets.map((entry) => entry.characterId))

  for (const entry of keyframes) {
    if (keyframeIds.has(entry.keyframeId)) {
      throw new Error(`Duplicate keyframeId "${entry.keyframeId}" in workspace/KEYFRAMES.json.`)
    }

    keyframeIds.add(entry.keyframeId)

    for (const characterId of entry.characterIds) {
      if (!characterIds.has(characterId)) {
        throw new Error(
          `Keyframe "${entry.keyframeId}" references missing character "${characterId}" in workspace/CHARACTERS/.`,
        )
      }

      const characterSheetImagePath = resolveRepoPath(getCharacterSheetImagePath(characterId))

      try {
        await access(characterSheetImagePath)
      } catch {
        throw new Error(
          `Keyframe "${entry.keyframeId}" requires character sheet image "${path.relative(process.cwd(), characterSheetImagePath)}".`,
        )
      }
    }
  }

  for (const [shotId, entries] of groupByShotId(keyframes)) {
    const frameTypes = new Set(entries.map((entry) => entry.frameType))

    if (entries.length === 1 && frameTypes.has('single')) {
      continue
    }

    if (entries.length !== 2 || !frameTypes.has('start') || !frameTypes.has('end')) {
      throw new Error(
        `Shot "${shotId}" must have either one "single" keyframe or exactly one "start" and one "end" keyframe. Found ${entries.length} entry/entries with frame types: ${summarizeFrameTypes(entries)}.`,
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

function validateCharacterSheets(characterSheets: CharacterSheetEntry[]) {
  const characterIds = new Set<string>()

  for (const entry of characterSheets) {
    if (characterIds.has(entry.characterId)) {
      throw new Error(`Duplicate character sheet "${entry.characterId}" in workspace/CHARACTERS/.`)
    }

    characterIds.add(entry.characterId)
  }
}

function validateShotArtifacts(shots: ShotEntry[], artifacts: ShotArtifactEntry[]) {
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
        `Shot "${shot.shotId}" must reference either one single keyframe or a start/end pair.`,
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
      if (!frameTypes.has('single')) {
        throw new Error(
          `Shot "${shot.shotId}" references one keyframe, so it must use frameType "single".`,
        )
      }

      continue
    }

    if (!frameTypes.has('start') || !frameTypes.has('end') || frameTypes.has('single')) {
      throw new Error(
        `Shot "${shot.shotId}" must reference one "start" and one "end" keyframe when using two anchors. Found frame types: ${summarizeFrameTypes(anchors)}.`,
      )
    }
  }
}

async function main() {
  await requireRepoPath(MODEL_OPTIONS_FILE, MODEL_OPTIONS_FILE)
  await requireWorkspacePath('IDEA.md', 'workspace/IDEA.md')
  await requireWorkspacePath(WORKFLOW_FILES.config, 'workspace/CONFIG.json')
  await requireWorkspacePath(WORKFLOW_FILES.status, 'workspace/STATUS.json')

  const modelOptions = await loadModelOptions()
  const config = await loadConfig()
  validateConfigAgainstModelOptions(config, modelOptions)
  const status = await loadStatus()
  const keyframesExists = await workspacePathExists(WORKFLOW_FILES.keyframes)
  const shotPromptsExists = await workspacePathExists(WORKFLOW_FILES.shotPrompts)
  const finalCutExists = await workspacePathExists(WORKFLOW_FILES.finalCut)
  const characterSheets = await loadCharacterSheets()
  const keyframeArtifacts = await loadKeyframeArtifacts()
  const shotArtifacts = await loadShotArtifacts()

  const keyframes = keyframesExists ? await loadKeyframes() : []
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

  validateCharacterSheets(characterSheets)
  await validateKeyframes(keyframes, characterSheets)
  validateKeyframeArtifacts(keyframes, keyframeArtifacts)
  validateShots(keyframes, shots)
  validateShotArtifacts(shots, shotArtifacts)

  if (finalCutExists) {
    await resolveFinalCutProps(process.cwd(), { assetBaseUrl: 'http://127.0.0.1:1' })
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
        keyframesPresent: keyframesExists,
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
