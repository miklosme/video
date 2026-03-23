import { access } from 'node:fs/promises'
import path from 'node:path'

import {
  getCharacterSheetImagePath,
  loadCharacterSheets,
  loadConfig,
  loadKeyframeArtifacts,
  loadKeyframes,
  loadModelOptions,
  loadStatus,
  loadVideoPrompts,
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
  type VideoPromptEntry,
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

function validateVideoPrompts(keyframes: KeyframeEntry[], videoPrompts: VideoPromptEntry[]) {
  const keyframeById = new Map(keyframes.map((entry) => [entry.keyframeId, entry]))
  const videoPromptIds = new Set<string>()

  for (const videoPrompt of videoPrompts) {
    if (videoPromptIds.has(videoPrompt.promptId)) {
      throw new Error(
        `Duplicate promptId "${videoPrompt.promptId}" in workspace/VIDEO-PROMPTS.json.`,
      )
    }

    videoPromptIds.add(videoPrompt.promptId)

    if (videoPrompt.keyframeIds.length === 0 || videoPrompt.keyframeIds.length > 2) {
      throw new Error(
        `Video prompt "${videoPrompt.promptId}" must reference either one single keyframe or a start/end pair.`,
      )
    }

    const anchors = videoPrompt.keyframeIds.map((keyframeId) => {
      const anchor = keyframeById.get(keyframeId)

      if (!anchor) {
        throw new Error(
          `Video prompt "${videoPrompt.promptId}" references missing keyframe "${keyframeId}".`,
        )
      }

      return anchor
    })

    if (anchors.some((anchor) => anchor.shotId !== videoPrompt.shotId)) {
      throw new Error(
        `Video prompt "${videoPrompt.promptId}" must only reference keyframes from shot "${videoPrompt.shotId}".`,
      )
    }

    const frameTypes = new Set(anchors.map((anchor) => anchor.frameType))

    if (anchors.length === 1) {
      if (!frameTypes.has('single')) {
        throw new Error(
          `Video prompt "${videoPrompt.promptId}" references one keyframe, so it must use frameType "single".`,
        )
      }

      continue
    }

    if (!frameTypes.has('start') || !frameTypes.has('end') || frameTypes.has('single')) {
      throw new Error(
        `Video prompt "${videoPrompt.promptId}" must reference one "start" and one "end" keyframe when using two anchors. Found frame types: ${summarizeFrameTypes(anchors)}.`,
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
  const videoPromptsExists = await workspacePathExists(WORKFLOW_FILES.videoPrompts)
  const characterSheets = await loadCharacterSheets()
  const keyframeArtifacts = await loadKeyframeArtifacts()

  const keyframes = keyframesExists ? await loadKeyframes() : []
  const videoPrompts = videoPromptsExists ? await loadVideoPrompts() : []

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
  validateVideoPrompts(keyframes, videoPrompts)

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
        videoPromptsPresent: videoPromptsExists,
        videoPromptsCount: videoPrompts.length,
      },
      null,
      2,
    ),
  )
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
