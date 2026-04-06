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
import {
  buildStoryboardDirectPromptText,
  buildStoryboardPrompt,
  buildStoryboardPromptText,
  buildStoryboardRegeneratePrompt,
  modelUsesStoryboardPromptRewrite,
  rewriteStoryboardPrompt,
  STORYBOARD_THUMBNAIL_IMAGE_SIZE,
  type StoryboardPromptRewriter,
} from './storyboard-prompting'
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

export interface PendingStoryboardGeneration {
  imageIndex: number
  storyboardImageId: string
  shotId: string
  frameType: StoryboardImageEntry['frameType']
  goal: string
  previousFrameSummary?: string | null
  nextFrameSummary?: string | null
  artifactId: string
  model: string
  rewriteModel?: string | null
  prompt: string
  promptIsFinal?: boolean
  outputPath: string
  userReferences?: StoryboardImageEntry['references']
}

export interface StoryboardGenerationSummary {
  generatedCount: number
  skippedCount: number
}

type ImageGenerator = (input: GenerateImagenOptionsInput) => Promise<GenerateImagenOptionsResult>

export {
  buildStoryboardPrompt,
  buildStoryboardRegeneratePrompt,
  STORYBOARD_THUMBNAIL_IMAGE_SIZE,
} from './storyboard-prompting'

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

function normalizeCachedStoryboardPrompt(prompt: string | null | undefined) {
  const trimmed = prompt?.trim()
  return trimmed && trimmed.length > 0 ? trimmed : null
}

function resolveStoryboardPromptCache(
  storyboard: StoryboardSidecar,
  imageIndex: number,
  model: string,
  cachedPrompt?: string | null,
) {
  const planningPrompt = buildStoryboardPrompt(storyboard, imageIndex)
  const prompt = normalizeCachedStoryboardPrompt(cachedPrompt) ?? planningPrompt
  const promptIsLegacyPlanningCache =
    modelUsesStoryboardPromptRewrite(model) && prompt === planningPrompt

  return {
    prompt,
    promptIsFinal:
      normalizeCachedStoryboardPrompt(cachedPrompt) !== null && !promptIsLegacyPlanningCache,
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

async function persistResolvedStoryboardPrompt(
  storyboardImageId: string,
  prompt: string,
  cwd = process.cwd(),
) {
  const normalizedPrompt = normalizeCachedStoryboardPrompt(prompt)

  if (!normalizedPrompt) {
    return
  }

  let storyboard: StoryboardSidecar | null = null

  try {
    storyboard = await loadStoryboardSidecar(cwd)
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
      return
    }

    throw error
  }

  if (!storyboard) {
    return
  }

  const loadedStoryboard = storyboard
  const current = buildStoryboardDerivedImages(loadedStoryboard.images).find(
    (entry) => entry.storyboardImageId === storyboardImageId,
  )

  if (!current || normalizeCachedStoryboardPrompt(current.entry.prompt) === normalizedPrompt) {
    return
  }

  const nextStoryboard = {
    images: loadedStoryboard.images.map((entry, index) =>
      index === current.imageIndex
        ? ({
            ...entry,
            prompt: normalizedPrompt,
          } satisfies StoryboardImageEntry)
        : entry,
    ),
  } satisfies StoryboardSidecar

  await writeStoryboardSidecar(nextStoryboard, cwd)
}

export function selectPendingStoryboardGenerations(
  storyboard: StoryboardSidecar,
  model: string,
  filters: GenerateStoryboardArgs = {},
  options: {
    rewriteModel?: string | null
  } = {},
): PendingStoryboardGeneration[] {
  const derivedImages = buildStoryboardDerivedImages(storyboard.images)

  return derivedImages
    .filter((entry) => matchesStoryboardFilters(entry, filters))
    .map((entry) => {
      if (entry.entry.imagePath === null) {
        throw new Error(
          `Storyboard image "${entry.storyboardImageId}" is missing imagePath and must be prepared before generation.`,
        )
      }

      const previousEntry =
        entry.imageIndex > 0 ? (derivedImages[entry.imageIndex - 1] ?? null) : null
      const nextEntry = derivedImages[entry.imageIndex + 1] ?? null
      const prompt = resolveStoryboardPromptCache(
        storyboard,
        entry.imageIndex,
        model,
        entry.entry.prompt,
      )

      return {
        imageIndex: entry.imageIndex,
        storyboardImageId: entry.storyboardImageId,
        shotId: entry.shotId,
        frameType: entry.entry.frameType,
        goal: entry.entry.goal,
        previousFrameSummary: previousEntry
          ? `${previousEntry.storyboardImageId} (${previousEntry.entry.frameType}) — ${previousEntry.entry.goal.trim()}`
          : null,
        nextFrameSummary: nextEntry
          ? `${nextEntry.storyboardImageId} (${nextEntry.entry.frameType}) — ${nextEntry.entry.goal.trim()}`
          : null,
        artifactId: getStoryboardArtifactIdFromPath(entry.entry.imagePath),
        model,
        rewriteModel: options.rewriteModel ?? null,
        prompt: prompt.prompt,
        promptIsFinal: prompt.promptIsFinal,
        outputPath: entry.entry.imagePath,
        userReferences: entry.entry.references,
      }
    })
}

export async function resolveStoryboardGenerationPrompt(
  generation: PendingStoryboardGeneration,
  references: NonNullable<GenerateImagenOptionsInput['references']>,
  options: {
    basePrompt?: string
    regenerateRequest?: string | null
    logFile?: string
    cwd?: string
    promptRewriter?: StoryboardPromptRewriter
  } = {},
) {
  if (
    generation.promptIsFinal &&
    options.basePrompt === undefined &&
    options.regenerateRequest === undefined
  ) {
    return generation.prompt
  }

  if (modelUsesStoryboardPromptRewrite(generation.model) && !generation.rewriteModel) {
    throw new Error(
      `Storyboard image "${generation.storyboardImageId}" requires a configured agent rewrite model before it can be generated with ${generation.model}.`,
    )
  }

  console.log(
    `Resolving prompt for ${generation.storyboardImageId} with model ${generation.model}...`,
  )

  return rewriteStoryboardPrompt(
    {
      prompt: options.basePrompt ?? generation.prompt,
      imageModel: generation.model,
      rewriteModel: generation.rewriteModel ?? generation.model,
      storyboardImageId: generation.storyboardImageId,
      shotId: generation.shotId,
      frameType: generation.frameType,
      goal: generation.goal,
      previousFrameSummary: generation.previousFrameSummary ?? null,
      nextFrameSummary: generation.nextFrameSummary ?? null,
      references,
      regenerateRequest: options.regenerateRequest,
      cwd: options.cwd,
    },
    {
      logFile: options.logFile,
      rewriter: options.promptRewriter,
    },
  )
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
    resolvedPrompt?: string
    promptRewriter?: StoryboardPromptRewriter
  } = {},
) {
  const { resolvedReferences, references } = resolveStoryboardGenerationReferences(
    options.userReferences ?? generation.userReferences ?? [],
  )
  await assertResolvedReferencesExist(resolvedReferences, options.cwd)
  const prompt =
    options.resolvedPrompt ??
    (await resolveStoryboardGenerationPrompt(generation, references, {
      logFile: options.logFile,
      cwd: options.cwd,
      promptRewriter: options.promptRewriter,
    }))
  await persistResolvedStoryboardPrompt(
    generation.storyboardImageId,
    prompt,
    options.cwd ?? process.cwd(),
  )

  const generator = options.generator ?? generateImagenOptions
  const result = await generator({
    prompt,
    model: generation.model,
    outputPath: options.outputPath ?? generation.outputPath,
    size: STORYBOARD_THUMBNAIL_IMAGE_SIZE,
    references,
    logFile: options.logFile,
    cwd: options.cwd,
    seed: options.seed,
    artifactType: 'storyboard',
    artifactId: generation.artifactId,
    promptTextBuilder: modelUsesStoryboardPromptRewrite(generation.model)
      ? buildStoryboardDirectPromptText
      : buildStoryboardPromptText,
  })

  return {
    ...result,
    prompt,
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
    resolvedPrompt?: string
    promptRewriter?: StoryboardPromptRewriter
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
      resolvedPrompt: options.resolvedPrompt,
      promptRewriter: options.promptRewriter,
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
    resolvedPrompt?: string
    promptRewriter?: StoryboardPromptRewriter
  },
) {
  const { resolvedReferences, references } = resolveStoryboardRegenerationReferences(
    options.selectedVersionPath,
    options.userReferences ?? generation.userReferences ?? [],
  )
  await assertResolvedReferencesExist(resolvedReferences, options.cwd)

  const basePrompt = buildStoryboardRegeneratePrompt(generation, options.regenerateRequest)
  const prompt =
    options.resolvedPrompt ??
    (await resolveStoryboardGenerationPrompt(generation, references, {
      basePrompt,
      regenerateRequest: options.regenerateRequest,
      logFile: options.logFile,
      cwd: options.cwd,
      promptRewriter: options.promptRewriter,
    }))
  await persistResolvedStoryboardPrompt(
    generation.storyboardImageId,
    prompt,
    options.cwd ?? process.cwd(),
  )
  const generator = options.generator ?? generateImagenOptions
  const result = await generator({
    prompt,
    model: generation.model,
    outputPath: options.outputPath ?? generation.outputPath,
    size: STORYBOARD_THUMBNAIL_IMAGE_SIZE,
    references,
    logFile: options.logFile,
    cwd: options.cwd,
    seed: options.seed,
    artifactType: 'storyboard',
    artifactId: generation.artifactId,
    promptTextBuilder: modelUsesStoryboardPromptRewrite(generation.model)
      ? buildStoryboardDirectPromptText
      : buildStoryboardPromptText,
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
    resolvedPrompt?: string
    promptRewriter?: StoryboardPromptRewriter
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
      resolvedPrompt: options.resolvedPrompt,
      promptRewriter: options.promptRewriter,
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
  rewriteModel?: string | null
  filters?: GenerateStoryboardArgs
  variantCount?: number
  logFile?: string
  cwd?: string
  generator?: ImageGenerator
  promptRewriter?: StoryboardPromptRewriter
}): Promise<StoryboardGenerationSummary> {
  const cwd = options.cwd ?? process.cwd()
  const storyboardWithPaths = await ensureStoryboardImagePaths(
    options.storyboard,
    options.filters,
    cwd,
  )
  const storyboard = storyboardWithPaths
  const generations = selectPendingStoryboardGenerations(
    storyboard,
    options.model,
    options.filters,
    {
      rewriteModel: options.rewriteModel,
    },
  )
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

    const generationReferences = resolveStoryboardGenerationReferences(
      generation.userReferences ?? [],
    ).references
    const resolvedPrompt = await resolveStoryboardGenerationPrompt(
      generation,
      generationReferences,
      {
        logFile: options.logFile,
        cwd,
        promptRewriter: options.promptRewriter,
      },
    )
    console.log(`Generated prompt for ${generation.storyboardImageId}:\n${resolvedPrompt}\n`)

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
        resolvedPrompt,
        promptRewriter: options.promptRewriter,
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
    rewriteModel: config.agentModel,
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
