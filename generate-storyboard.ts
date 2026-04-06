import { access, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'

import arg from 'arg'

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
import { buildStoryboardDerivedImages, createStoryboardImagePath } from './storyboard-utils'
import {
  getStoryboardArtifactIdFromPath,
  loadConfig,
  loadStoryboardSidecar,
  resolveWorkflowPath,
  WORKFLOW_FILES,
  type StoryboardImageEntry,
  type StoryboardSidecar,
} from './workflow-data'

interface GenerateStoryboardArgs {
  storyboardImageId?: string
  shotId?: string
}

const DEFAULT_STORYBOARD_IMAGE_SIZE = '896x512' as const

export interface PendingStoryboardGeneration {
  imageIndex: number
  storyboardImageId: string
  shotId: string
  frameType: StoryboardImageEntry['frameType']
  goal: string
  artifactId: string
  model: string
  prompt: string
  outputPath: string
  userReferences?: StoryboardImageEntry['references']
}

export interface StoryboardGenerationSummary {
  generatedCount: number
  skippedCount: number
}

type ImageGenerator = (input: GenerateImagenOptionsInput) => Promise<GenerateImagenOptionsResult>

function parseArgs(): GenerateStoryboardArgs {
  const args = arg({
    '--storyboard-image-id': String,
    '--shot-id': String,
  })

  return {
    storyboardImageId: args['--storyboard-image-id'],
    shotId: args['--shot-id'],
  }
}

async function fileExists(filePath: string) {
  try {
    await access(filePath)
    return true
  } catch {
    return false
  }
}

async function writeStoryboardSidecar(storyboard: StoryboardSidecar, cwd = process.cwd()) {
  await writeFile(
    resolveWorkflowPath(WORKFLOW_FILES.storyboardSidecar, cwd),
    `${JSON.stringify(storyboard, null, 2)}\n`,
    'utf8',
  )
}

function matchesStoryboardFilters(
  image: ReturnType<typeof buildStoryboardDerivedImages>[number],
  filters: GenerateStoryboardArgs,
) {
  if (filters.storyboardImageId && image.storyboardImageId !== filters.storyboardImageId) {
    return false
  }

  if (filters.shotId && image.shotId !== filters.shotId) {
    return false
  }

  return true
}

export async function ensureStoryboardImagePaths(
  storyboard: StoryboardSidecar,
  filters: GenerateStoryboardArgs = {},
  cwd = process.cwd(),
) {
  const derivedImages = buildStoryboardDerivedImages(storyboard.images)
  let didChange = false

  const nextImages = derivedImages.map((image) => {
    if (!matchesStoryboardFilters(image, filters) || image.entry.imagePath !== null) {
      return image.entry
    }

    didChange = true

    return {
      ...image.entry,
      imagePath: createStoryboardImagePath(),
    } satisfies StoryboardImageEntry
  })

  if (!didChange) {
    return storyboard
  }

  const nextStoryboard = {
    images: nextImages,
  } satisfies StoryboardSidecar

  await writeStoryboardSidecar(nextStoryboard, cwd)
  return nextStoryboard
}

function getStoryboardImageContext(
  storyboard: StoryboardSidecar,
  imageSelector: number | string,
): {
  index: number
  current: ReturnType<typeof buildStoryboardDerivedImages>[number]
  previous: ReturnType<typeof buildStoryboardDerivedImages>[number] | null
  next: ReturnType<typeof buildStoryboardDerivedImages>[number] | null
} {
  const derivedImages = buildStoryboardDerivedImages(storyboard.images)
  const index =
    typeof imageSelector === 'number'
      ? imageSelector
      : derivedImages.findIndex((entry) => entry.storyboardImageId === imageSelector)

  if (index < 0) {
    throw new Error(
      `Storyboard image "${String(imageSelector)}" is missing from workspace/STORYBOARD.json.`,
    )
  }

  return {
    index,
    current: derivedImages[index]!,
    previous: index > 0 ? (derivedImages[index - 1] ?? null) : null,
    next: derivedImages[index + 1] ?? null,
  }
}

export function buildStoryboardPrompt(
  storyboard: StoryboardSidecar,
  imageSelector: number | string,
) {
  const { current } = getStoryboardImageContext(storyboard, imageSelector)
  const frameInstruction =
    current.entry.frameType === 'end'
      ? 'Show the closing beat of the shot, not the opening beat.'
      : 'Show the opening beat of the shot, not the ending beat.'

  return [
    'Create a single storyboard image for one planned shot anchor.',
    'Do not create a multi-panel sheet, page layout, border frame, shot label, or any text inside the image.',
    'Loose graphite or pencil previs drawing, monochrome, simple tones, clear silhouette, and clear staging.',
    'Keep it rough and iteration-friendly while still locking composition and intent.',
    frameInstruction,
    '',
    `Shot: ${current.shotId} (${current.entry.frameType})`,
    `Goal: ${current.entry.goal.trim()}`,
  ].join('\n')
}

export function buildStoryboardRegeneratePrompt(
  generation: Pick<
    PendingStoryboardGeneration,
    'storyboardImageId' | 'shotId' | 'frameType' | 'goal'
  >,
  regenerateRequest?: string | null,
) {
  const trimmedRequest = regenerateRequest?.trim() ?? ''

  const lines = [
    `Regenerate the current storyboard image for ${generation.storyboardImageId}.`,
    `Use the attached ${generation.frameType} frame from ${generation.shotId} as the direct visual baseline.`,
    'Keep the same minimal storyboard sketch style and overall intent unless the direction below explicitly asks for a broader change.',
    '',
    `Goal: ${generation.goal}`,
  ]

  if (trimmedRequest.length > 0) {
    lines.push('', 'Direction:', trimmedRequest)
  }

  return lines.join('\n')
}

export function selectPendingStoryboardGenerations(
  storyboard: StoryboardSidecar,
  model: string,
  filters: GenerateStoryboardArgs = {},
): PendingStoryboardGeneration[] {
  return buildStoryboardDerivedImages(storyboard.images)
    .filter((entry) => matchesStoryboardFilters(entry, filters))
    .map((entry) => {
      if (entry.entry.imagePath === null) {
        throw new Error(
          `Storyboard image "${entry.storyboardImageId}" is missing imagePath and must be prepared before generation.`,
        )
      }

      return {
        imageIndex: entry.imageIndex,
        storyboardImageId: entry.storyboardImageId,
        shotId: entry.shotId,
        frameType: entry.entry.frameType,
        goal: entry.entry.goal,
        artifactId: getStoryboardArtifactIdFromPath(entry.entry.imagePath),
        model,
        prompt: buildStoryboardPrompt(storyboard, entry.imageIndex),
        outputPath: entry.entry.imagePath,
        userReferences: entry.entry.references,
      }
    })
}

export async function runStoryboardGeneration(
  generation: PendingStoryboardGeneration,
  options: {
    outputPath?: string
    userReferences?: StoryboardImageEntry['references']
    logFile?: string
    cwd?: string
    seed?: number
    generator?: ImageGenerator
  } = {},
) {
  const { resolvedReferences, references } = resolveStoryboardGenerationReferences(
    options.userReferences ?? generation.userReferences ?? [],
  )
  await assertResolvedReferencesExist(resolvedReferences, options.cwd)

  const generator = options.generator ?? generateImagenOptions
  const result = await generator({
    prompt: generation.prompt,
    model: generation.model,
    outputPath: options.outputPath ?? generation.outputPath,
    size: DEFAULT_STORYBOARD_IMAGE_SIZE,
    references,
    logFile: options.logFile,
    cwd: options.cwd,
    seed: options.seed,
    artifactType: 'storyboard',
    artifactId: generation.artifactId,
  })

  return {
    ...result,
    prompt: generation.prompt,
    resolvedReferences,
    references,
  }
}

export async function generateStoryboardArtifactVersion(
  generation: PendingStoryboardGeneration,
  options: {
    userReferences?: StoryboardImageEntry['references']
    logFile?: string
    cwd?: string
    seed?: number
    autoSelect?: boolean
    generator?: ImageGenerator
  } = {},
) {
  const descriptor = getStoryboardArtifactDescriptor({
    imagePath: generation.outputPath,
    shotId: generation.shotId,
    storyboardImageId: generation.storyboardImageId,
  })
  const cwd = options.cwd ?? process.cwd()
  const stagedVersion = await prepareStagedArtifactVersion(descriptor, cwd)
  const seed = options.seed ?? getVersionSeed(stagedVersion.versionId)

  try {
    const result = await runStoryboardGeneration(generation, {
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

export async function runStoryboardRegeneration(
  generation: PendingStoryboardGeneration,
  options: {
    outputPath?: string
    regenerateRequest?: string | null
    selectedVersionPath: string
    userReferences?: StoryboardImageEntry['references']
    logFile?: string
    cwd?: string
    seed?: number
    generator?: ImageGenerator
  },
) {
  const { resolvedReferences, references } = resolveStoryboardRegenerationReferences(
    options.selectedVersionPath,
    options.userReferences ?? generation.userReferences ?? [],
  )
  await assertResolvedReferencesExist(resolvedReferences, options.cwd)

  const prompt = buildStoryboardRegeneratePrompt(generation, options.regenerateRequest)
  const generator = options.generator ?? generateImagenOptions
  const result = await generator({
    prompt,
    model: generation.model,
    outputPath: options.outputPath ?? generation.outputPath,
    size: DEFAULT_STORYBOARD_IMAGE_SIZE,
    references,
    logFile: options.logFile,
    cwd: options.cwd,
    seed: options.seed,
    artifactType: 'storyboard',
    artifactId: generation.artifactId,
  })

  return {
    ...result,
    prompt,
    resolvedReferences,
    references,
  }
}

export async function regenerateStoryboardArtifactVersion(
  generation: PendingStoryboardGeneration,
  options: {
    regenerateRequest?: string | null
    selectedVersionPath: string
    userReferences?: StoryboardImageEntry['references']
    logFile?: string
    cwd?: string
    seed?: number
    autoSelect?: boolean
    generator?: ImageGenerator
  },
) {
  const descriptor = getStoryboardArtifactDescriptor({
    imagePath: generation.outputPath,
    shotId: generation.shotId,
    storyboardImageId: generation.storyboardImageId,
  })
  const cwd = options.cwd ?? process.cwd()
  const stagedVersion = await prepareStagedArtifactVersion(descriptor, cwd)
  const seed = options.seed ?? getVersionSeed(stagedVersion.versionId)

  try {
    const result = await runStoryboardRegeneration(generation, {
      outputPath: stagedVersion.stagedPath,
      regenerateRequest: options.regenerateRequest,
      selectedVersionPath: options.selectedVersionPath,
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

export async function syncStoryboardGeneration(options: {
  storyboard: StoryboardSidecar
  model: string
  filters?: GenerateStoryboardArgs
  variantCount?: number
  logFile?: string
  cwd?: string
  generator?: ImageGenerator
}): Promise<StoryboardGenerationSummary> {
  const cwd = options.cwd ?? process.cwd()
  const storyboard = await ensureStoryboardImagePaths(options.storyboard, options.filters, cwd)
  const generations = selectPendingStoryboardGenerations(storyboard, options.model, options.filters)
  const variantCount = options.variantCount ?? 1
  let generatedCount = 0
  let skippedCount = 0

  if (generations.length === 0) {
    throw new Error(
      'workspace/STORYBOARD.json has no storyboard images that match the requested filters.',
    )
  }

  for (const generation of generations) {
    const absoluteOutputPath = path.resolve(cwd, generation.outputPath)

    if (await fileExists(absoluteOutputPath)) {
      console.log(
        `Skipping ${generation.storyboardImageId}; image already exists at ${generation.outputPath}`,
      )
      skippedCount += 1
      continue
    }

    for (let variantIndex = 0; variantIndex < variantCount; variantIndex += 1) {
      if (variantCount === 1) {
        console.log(
          `Generating ${generation.storyboardImageId} with model ${generation.model} -> ${generation.outputPath}`,
        )
      } else {
        console.log(
          `Generating ${generation.storyboardImageId} variant ${variantIndex + 1}/${variantCount} with model ${generation.model} -> ${generation.outputPath}`,
        )
      }

      await generateStoryboardArtifactVersion(generation, {
        userReferences: generation.userReferences ?? [],
        logFile: options.logFile,
        cwd,
        autoSelect: variantIndex === variantCount - 1,
        generator: options.generator,
      })
    }

    generatedCount += 1
    captureWorkflowEvent('storyboard_generated', {
      model: generation.model,
      storyboardImageId: generation.storyboardImageId,
    })
  }

  console.log(
    `Storyboard sync complete. Generated ${generatedCount}; skipped ${skippedCount} existing image${skippedCount === 1 ? '' : 's'}.`,
  )

  return {
    generatedCount,
    skippedCount,
  }
}

async function main() {
  await ensureActiveWorkspace()

  const storyboard = await loadStoryboardSidecar()

  if (!storyboard) {
    throw new Error(
      'workspace/STORYBOARD.json is required before running bun run generate:storyboard.',
    )
  }

  if (storyboard.images.length === 0) {
    throw new Error(
      'workspace/STORYBOARD.json must declare at least one storyboard image before running bun run generate:storyboard.',
    )
  }

  const config = await loadConfig()
  const filters = parseArgs()

  await syncStoryboardGeneration({
    storyboard,
    model: config.fastImageModel,
    filters,
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
