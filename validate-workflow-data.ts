import { access } from 'node:fs/promises'
import path from 'node:path'

import {
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
