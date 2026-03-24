import { access, readFile } from 'node:fs/promises'
import path from 'node:path'

import { generateImagenOptions } from './generate-imagen-options'
import { captureWorkflowEvent, shutdownPostHog } from './posthog'
import {
  getStoryboardImagePath,
  loadConfig,
  resolveWorkflowPath,
  WORKFLOW_FILES,
} from './workflow-data'

export interface PendingStoryboardGeneration {
  model: string
  prompt: string
  outputPath: string
}

async function fileExists(filePath: string) {
  try {
    await access(filePath)
    return true
  } catch {
    return false
  }
}

export function buildStoryboardPrompt(storyboardMarkdown: string) {
  const trimmedStoryboard = storyboardMarkdown.trim()

  if (trimmedStoryboard.length === 0) {
    throw new Error('workspace/STORYBOARD.md is empty.')
  }

  return [
    'Create a single storyboard sheet for the full project.',
    'Use the raw storyboard markdown below as the source of truth.',
    'Render one panel per shot described in the markdown, in order.',
    'Show visible shot labels that exactly match the SHOT-XX IDs from the markdown.',
    'This is a normal storyboard board for review, not start/end keyframe pairs.',
    'Keep the board easy to review at a glance, with clear composition and readable panel separation.',
    'Do not invent extra shots, extra panels, or duplicate any shot.',
    'Do not include any text beyond the visible shot labels.',
    '',
    'Storyboard markdown:',
    '```md',
    trimmedStoryboard,
    '```',
  ].join('\n')
}

export function selectPendingStoryboardGeneration(
  storyboardMarkdown: string,
  model: string,
): PendingStoryboardGeneration {
  return {
    model,
    prompt: buildStoryboardPrompt(storyboardMarkdown),
    outputPath: getStoryboardImagePath(),
  }
}

async function main() {
  const [config, storyboardMarkdown] = await Promise.all([
    loadConfig(),
    readFile(resolveWorkflowPath(WORKFLOW_FILES.storyboard), 'utf8'),
  ])

  const generation = selectPendingStoryboardGeneration(storyboardMarkdown, config.imageModel)
  const absoluteOutputPath = path.resolve(process.cwd(), generation.outputPath)

  if (await fileExists(absoluteOutputPath)) {
    console.log(`Skipping storyboard; image already exists at ${generation.outputPath}`)
    console.log('Storyboard sync complete. Generated 0; skipped 1 existing image.')
    return
  }

  console.log(`Generating storyboard with model ${generation.model} -> ${generation.outputPath}`)

  await generateImagenOptions({
    prompt: generation.prompt,
    model: generation.model,
    outputPath: generation.outputPath,
    references: [],
  })

  captureWorkflowEvent('storyboard_generated', { model: generation.model })
  console.log('Storyboard sync complete. Generated 1; skipped 0 existing images.')
}

if (import.meta.main) {
  main()
    .catch((error) => {
      console.error(error)
      process.exitCode = 1
    })
    .finally(() => shutdownPostHog())
}
