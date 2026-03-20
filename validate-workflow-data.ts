import { access } from 'node:fs/promises'
import path from 'node:path'

import {
  type FrameType,
  type KeyframeEntry,
  type KeyframePromptEntry,
  type VideoPromptEntry,
  loadKeyframePrompts,
  loadKeyframes,
  loadStatus,
  loadVideoPrompts,
  resolveWorkflowPath,
  WORKFLOW_FILES,
  workspacePathExists,
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

function groupByShotId(entries: KeyframeEntry[]) {
  const grouped = new Map<string, KeyframeEntry[]>()

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

function validateKeyframes(keyframes: KeyframeEntry[]) {
  const keyframeIds = new Set<string>()

  for (const entry of keyframes) {
    if (keyframeIds.has(entry.keyframeId)) {
      throw new Error(`Duplicate keyframeId "${entry.keyframeId}" in workspace/KEYFRAMES.json.`)
    }

    keyframeIds.add(entry.keyframeId)
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

function validateKeyframePrompts(keyframes: KeyframeEntry[], prompts: KeyframePromptEntry[]) {
  const keyframeById = new Map(keyframes.map((entry) => [entry.keyframeId, entry]))
  const promptIds = new Set<string>()

  for (const prompt of prompts) {
    if (promptIds.has(prompt.promptId)) {
      throw new Error(`Duplicate promptId "${prompt.promptId}" in workspace/KEYFRAME-PROMPTS.json.`)
    }

    promptIds.add(prompt.promptId)

    const keyframe = keyframeById.get(prompt.keyframeId)

    if (!keyframe) {
      throw new Error(
        `Keyframe prompt "${prompt.promptId}" references missing keyframeId "${prompt.keyframeId}".`,
      )
    }

    if (prompt.shotId !== keyframe.shotId) {
      throw new Error(
        `Keyframe prompt "${prompt.promptId}" has shotId "${prompt.shotId}" but keyframe "${prompt.keyframeId}" belongs to shot "${keyframe.shotId}".`,
      )
    }

    if (prompt.frameType !== keyframe.frameType) {
      throw new Error(
        `Keyframe prompt "${prompt.promptId}" has frameType "${prompt.frameType}" but keyframe "${prompt.keyframeId}" uses frameType "${keyframe.frameType}".`,
      )
    }
  }
}

function validateVideoPrompts(
  keyframePrompts: KeyframePromptEntry[],
  videoPrompts: VideoPromptEntry[],
) {
  const keyframePromptById = new Map(keyframePrompts.map((entry) => [entry.promptId, entry]))
  const videoPromptIds = new Set<string>()

  for (const videoPrompt of videoPrompts) {
    if (videoPromptIds.has(videoPrompt.promptId)) {
      throw new Error(
        `Duplicate promptId "${videoPrompt.promptId}" in workspace/VIDEO-PROMPTS.json.`,
      )
    }

    videoPromptIds.add(videoPrompt.promptId)

    if (videoPrompt.keyframePromptIds.length === 0 || videoPrompt.keyframePromptIds.length > 2) {
      throw new Error(
        `Video prompt "${videoPrompt.promptId}" must reference either one single keyframe prompt or a start/end pair.`,
      )
    }

    const anchors = videoPrompt.keyframePromptIds.map((keyframePromptId) => {
      const anchor = keyframePromptById.get(keyframePromptId)

      if (!anchor) {
        throw new Error(
          `Video prompt "${videoPrompt.promptId}" references missing keyframe prompt "${keyframePromptId}".`,
        )
      }

      return anchor
    })

    if (anchors.some((anchor) => anchor.shotId !== videoPrompt.shotId)) {
      throw new Error(
        `Video prompt "${videoPrompt.promptId}" must only reference keyframe prompts from shot "${videoPrompt.shotId}".`,
      )
    }

    const frameTypes = new Set(anchors.map((anchor) => anchor.frameType))

    if (anchors.length === 1) {
      if (!frameTypes.has('single')) {
        throw new Error(
          `Video prompt "${videoPrompt.promptId}" references one keyframe prompt, so it must use frameType "single".`,
        )
      }

      continue
    }

    if (!frameTypes.has('start') || !frameTypes.has('end') || frameTypes.has('single')) {
      throw new Error(
        `Video prompt "${videoPrompt.promptId}" must reference one "start" and one "end" keyframe prompt when using two anchors. Found frame types: ${summarizeFrameTypes(anchors)}.`,
      )
    }
  }
}

async function main() {
  await requireWorkspacePath('IDEA.md', 'workspace/IDEA.md')
  await requireWorkspacePath(WORKFLOW_FILES.status, 'workspace/STATUS.json')

  const status = await loadStatus()
  const keyframesExists = await workspacePathExists(WORKFLOW_FILES.keyframes)
  const keyframePromptsExists = await workspacePathExists(WORKFLOW_FILES.keyframePrompts)
  const videoPromptsExists = await workspacePathExists(WORKFLOW_FILES.videoPrompts)

  const keyframes = keyframesExists ? await loadKeyframes() : []
  const keyframePrompts = keyframePromptsExists ? await loadKeyframePrompts() : []
  const videoPrompts = videoPromptsExists ? await loadVideoPrompts() : []

  validateKeyframes(keyframes)
  validateKeyframePrompts(keyframes, keyframePrompts)
  validateVideoPrompts(keyframePrompts, videoPrompts)

  console.log(
    JSON.stringify(
      {
        status: 'ok',
        ideaPresent: true,
        statusItems: status.length,
        readyMilestones: status.filter((item) => item.checked).length,
        keyframesPresent: keyframesExists,
        keyframesCount: keyframes.length,
        keyframePromptsPresent: keyframePromptsExists,
        keyframePromptsCount: keyframePrompts.length,
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
