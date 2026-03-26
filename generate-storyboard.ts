import { access, readFile } from 'node:fs/promises'
import path from 'node:path'

import { generateImagenOptions } from './generate-imagen-options'
import { captureWorkflowEvent, shutdownPostHog } from './posthog'
import {
  type GenerationReferenceEntry,
  getStoryboardImagePath,
  loadConfig,
  resolveWorkflowPath,
  WORKFLOW_FILES,
} from './workflow-data'

export interface PendingStoryboardGeneration {
  model: string
  prompt: string
  outputPath: string
  references: GenerationReferenceEntry[]
}

const STORYBOARD_TEMPLATE_PATH = 'templates/STORYBOARD.template.png'

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
    'Use the attached storyboard template image as the structural and stylistic reference for the board.',
    'Mirror the template’s clean panel grid, borders, and review-board presentation, but keep the board more visual and less text-heavy than the template.',
    'Render the story beats in order using storyboard panels.',
    'A single editorial shot may use multiple storyboard panels when needed to show beats within the same continuous camera setup.',
    'If one shot uses multiple storyboard panels, keep the same parent shot number and use suffixes such as SHOT-02A and SHOT-02B.',
    'Do not create a new shot number for a small action beat that stays in the same camera setup.',
    'Show visible shot labels that exactly match the SHOT-XX IDs from the markdown.',
    'This is a normal storyboard board for review, not start/end keyframe pairs.',
    'Keep the board easy to review at a glance, with clear composition, readable panel separation, and minimal per-panel text.',
    'Only include the text that is genuinely useful on a professional storyboard board: shot labels, and optionally a very short dialogue line or beat caption when needed.',
    'Do not include long descriptions, purpose text, transition text, duration text, or dense header blocks on the board.',
    'Do not invent extra shots or duplicate any beat. Extra storyboard panels are allowed only when they clarify a beat within the same shot.',
    'Do not copy the example puppy-specific wording from the template image; use the markdown as the only source for shot content.',
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
    references: [{ kind: 'storyboard-template', path: STORYBOARD_TEMPLATE_PATH }],
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
    references: generation.references,
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
