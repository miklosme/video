import { access, readFile, rm } from 'node:fs/promises'
import path from 'node:path'

import {
  assertResolvedReferencesExist,
  getStoryboardArtifactDescriptor,
  getVersionSeed,
  prepareStagedArtifactVersion,
  recordArtifactVersionFromStage,
  resolveStoryboardGenerationReferences,
  resolveStoryboardRegenerationReferences,
} from './artifact-control'
import {
  generateImagenOptions,
  type GenerateImagenOptionsInput,
  type GenerateImagenOptionsResult,
} from './generate-imagen-options'
import { captureWorkflowEvent, shutdownPostHog } from './posthog'
import { ensureActiveWorkspace } from './project-workspace'
import {
  getStoryboardImagePath,
  loadConfig,
  loadStoryboardSidecar,
  resolveWorkflowPath,
  WORKFLOW_FILES,
  workspacePathExists,
} from './workflow-data'

export interface PendingStoryboardGeneration {
  model: string
  prompt: string
  outputPath: string
  references: ReturnType<typeof resolveStoryboardGenerationReferences>['references']
}

export interface StoryboardGenerationSummary {
  generatedCount: number
  skippedCount: number
}

type ImageGenerator = (input: GenerateImagenOptionsInput) => Promise<GenerateImagenOptionsResult>

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
  userReferences: Parameters<typeof resolveStoryboardGenerationReferences>[0] = [],
): PendingStoryboardGeneration {
  const { references } = resolveStoryboardGenerationReferences(userReferences)

  return {
    model,
    prompt: buildStoryboardPrompt(storyboardMarkdown),
    outputPath: getStoryboardImagePath(),
    references,
  }
}

export function buildStoryboardRegeneratePrompt(regenerateRequest: string) {
  const trimmedRequest = regenerateRequest.trim()

  if (trimmedRequest.length === 0) {
    throw new Error('Storyboard regenerate request is empty.')
  }

  return [
    'Regenerate the current storyboard board from the attached base image.',
    'Keep the existing board structure and content unless the approved change below explicitly asks for broader updates.',
    '',
    'Approved change:',
    trimmedRequest,
  ].join('\n')
}

export async function runStoryboardGeneration(options: {
  storyboardMarkdown: string
  model: string
  outputPath: string
  userReferences?: Parameters<typeof resolveStoryboardGenerationReferences>[0]
  logFile?: string
  cwd?: string
  seed?: number
  generator?: ImageGenerator
}) {
  const { resolvedReferences, references } = resolveStoryboardGenerationReferences(
    options.userReferences,
  )
  await assertResolvedReferencesExist(resolvedReferences, options.cwd)

  const prompt = buildStoryboardPrompt(options.storyboardMarkdown)
  const generator = options.generator ?? generateImagenOptions
  const result = await generator({
    prompt,
    model: options.model,
    outputPath: options.outputPath,
    references,
    logFile: options.logFile,
    cwd: options.cwd,
    seed: options.seed,
    artifactType: 'storyboard',
    artifactId: 'STORYBOARD',
  })

  return {
    ...result,
    prompt,
    resolvedReferences,
    references,
  }
}

export async function generateStoryboardArtifactVersion(options: {
  storyboardMarkdown: string
  model: string
  userReferences?: Parameters<typeof resolveStoryboardGenerationReferences>[0]
  logFile?: string
  cwd?: string
  seed?: number
  autoSelect?: boolean
  generator?: ImageGenerator
}) {
  const descriptor = getStoryboardArtifactDescriptor()
  const cwd = options.cwd ?? process.cwd()
  const stagedVersion = await prepareStagedArtifactVersion(descriptor, cwd)
  const seed = options.seed ?? getVersionSeed(stagedVersion.versionId)

  try {
    const result = await runStoryboardGeneration({
      storyboardMarkdown: options.storyboardMarkdown,
      model: options.model,
      outputPath: stagedVersion.stagedPath,
      userReferences: options.userReferences,
      logFile: options.logFile,
      cwd,
      seed: seed ?? undefined,
      generator: options.generator,
    })
    const recorded = await recordArtifactVersionFromStage({
      descriptor,
      stagedPath: stagedVersion.stagedPath,
      autoSelect: options.autoSelect,
      cwd,
    })

    return {
      ...result,
      descriptor,
      seed,
      versionId: recorded.versionId,
    }
  } catch (error) {
    await rm(path.resolve(cwd, stagedVersion.stagedPath), { force: true }).catch(() => undefined)
    throw error
  }
}

export async function runStoryboardRegeneration(options: {
  model: string
  outputPath: string
  regenerateRequest: string
  selectedVersionPath: string
  logFile?: string
  cwd?: string
  seed?: number
  generator?: ImageGenerator
}) {
  const { resolvedReferences, references } = resolveStoryboardRegenerationReferences(
    options.selectedVersionPath,
  )
  await assertResolvedReferencesExist(resolvedReferences, options.cwd)

  const prompt = buildStoryboardRegeneratePrompt(options.regenerateRequest)
  const generator = options.generator ?? generateImagenOptions
  const result = await generator({
    prompt,
    model: options.model,
    outputPath: options.outputPath,
    references,
    logFile: options.logFile,
    cwd: options.cwd,
    seed: options.seed,
    artifactType: 'storyboard',
    artifactId: 'STORYBOARD',
  })

  return {
    ...result,
    prompt,
    resolvedReferences,
    references,
  }
}

export async function regenerateStoryboardArtifactVersion(options: {
  model: string
  regenerateRequest: string
  selectedVersionPath: string
  logFile?: string
  cwd?: string
  seed?: number
  autoSelect?: boolean
  generator?: ImageGenerator
}) {
  const descriptor = getStoryboardArtifactDescriptor()
  const cwd = options.cwd ?? process.cwd()
  const stagedVersion = await prepareStagedArtifactVersion(descriptor, cwd)
  const seed = options.seed ?? getVersionSeed(stagedVersion.versionId)

  try {
    const result = await runStoryboardRegeneration({
      model: options.model,
      outputPath: stagedVersion.stagedPath,
      regenerateRequest: options.regenerateRequest,
      selectedVersionPath: options.selectedVersionPath,
      logFile: options.logFile,
      cwd,
      seed: seed ?? undefined,
      generator: options.generator,
    })
    const recorded = await recordArtifactVersionFromStage({
      descriptor,
      stagedPath: stagedVersion.stagedPath,
      autoSelect: options.autoSelect,
      cwd,
    })

    return {
      ...result,
      descriptor,
      seed,
      versionId: recorded.versionId,
    }
  } catch (error) {
    await rm(path.resolve(cwd, stagedVersion.stagedPath), { force: true }).catch(() => undefined)
    throw error
  }
}

export async function syncStoryboardGeneration(options: {
  storyboardMarkdown: string
  model: string
  userReferences?: Parameters<typeof resolveStoryboardGenerationReferences>[0]
  variantCount?: number
  logFile?: string
  cwd?: string
  generator?: ImageGenerator
}): Promise<StoryboardGenerationSummary> {
  const cwd = options.cwd ?? process.cwd()
  const generation = selectPendingStoryboardGeneration(
    options.storyboardMarkdown,
    options.model,
    options.userReferences ?? [],
  )
  const absoluteOutputPath = path.resolve(cwd, generation.outputPath)

  if (await fileExists(absoluteOutputPath)) {
    console.log(`Skipping storyboard; image already exists at ${generation.outputPath}`)
    console.log('Storyboard sync complete. Generated 0; skipped 1 existing image.')
    return { generatedCount: 0, skippedCount: 1 }
  }

  const variantCount = options.variantCount ?? 1

  for (let variantIndex = 0; variantIndex < variantCount; variantIndex += 1) {
    if (variantCount === 1) {
      console.log(
        `Generating storyboard with model ${generation.model} -> ${generation.outputPath}`,
      )
    } else {
      console.log(
        `Generating storyboard variant ${variantIndex + 1}/${variantCount} with model ${generation.model} -> ${generation.outputPath}`,
      )
    }

    await generateStoryboardArtifactVersion({
      storyboardMarkdown: options.storyboardMarkdown,
      model: generation.model,
      userReferences: options.userReferences ?? [],
      logFile: options.logFile,
      cwd,
      autoSelect: variantIndex === variantCount - 1,
      generator: options.generator,
    })

    captureWorkflowEvent('storyboard_generated', { model: generation.model })
  }

  console.log('Storyboard sync complete. Generated 1; skipped 0 existing images.')

  return {
    generatedCount: 1,
    skippedCount: 0,
  }
}

async function main() {
  await ensureActiveWorkspace()
  if (!(await workspacePathExists(WORKFLOW_FILES.storyboard))) {
    throw new Error(
      'workspace/STORYBOARD.md is required before running bun run generate:storyboard.',
    )
  }

  const storyboardSidecar = await loadStoryboardSidecar()

  if (!storyboardSidecar) {
    throw new Error(
      'workspace/STORYBOARD.json is required before running bun run generate:storyboard.',
    )
  }

  if ((storyboardSidecar.references?.length ?? 0) === 0) {
    throw new Error(
      'workspace/STORYBOARD.json must declare explicit storyboard generation references before running bun run generate:storyboard.',
    )
  }

  const [config, storyboardMarkdown] = await Promise.all([
    loadConfig(),
    readFile(resolveWorkflowPath(WORKFLOW_FILES.storyboard), 'utf8'),
  ])

  await syncStoryboardGeneration({
    storyboardMarkdown,
    model: config.imageModel,
    userReferences: storyboardSidecar.references ?? [],
    variantCount: config.variantCount,
  })
}

if (import.meta.main) {
  main()
    .catch((error) => {
      console.error(error)
      process.exitCode = 1
    })
    .finally(() => shutdownPostHog())
}
