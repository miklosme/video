import { access, rm } from 'node:fs/promises'
import path from 'node:path'

import arg from 'arg'

import {
  assertResolvedReferencesExist,
  getCharacterArtifactDescriptor,
  getVersionSeed,
  prepareStagedArtifactVersion,
  recordArtifactVersionFromStage,
  resolveCharacterGenerationReferences,
  resolveCharacterRegenerationReferences,
} from './artifact-control'
import {
  generateImagenOptions,
  type GenerateImagenOptionsInput,
  type GenerateImagenOptionsResult,
} from './generate-imagen-options'
import { captureWorkflowEvent, shutdownPostHog } from './posthog'
import {
  getCharacterSheetImagePath,
  loadCharacterSheets,
  loadConfig,
  type ArtifactReferenceEntry,
  type CharacterSheetEntry,
} from './workflow-data'

interface GenerateCharacterSheetsArgs {
  characterId?: string
}

export interface PendingCharacterSheetGeneration {
  characterId: string
  displayName: string
  model: string
  prompt: string
  outputPath: string
  userReferences?: ArtifactReferenceEntry[]
}

export interface CharacterSheetGenerationSummary {
  generatedCount: number
  skippedCount: number
}

type ImageGenerator = (input: GenerateImagenOptionsInput) => Promise<GenerateImagenOptionsResult>

function parseArgs(): GenerateCharacterSheetsArgs {
  const args = arg({
    '--character-id': String,
  })

  return {
    characterId: args['--character-id'],
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

function buildEmptyCharacterSheetGenerationError(filters: GenerateCharacterSheetsArgs) {
  if (filters.characterId) {
    const descriptor = getCharacterArtifactDescriptor(filters.characterId)

    return `Character "${filters.characterId}" is missing its generation sidecar at ${descriptor.sidecarPath}. Write that sidecar prompt before running bun run generate:characters.`
  }

  return 'No character sheet generation sidecars were found in workspace/CHARACTERS/. Add workspace/CHARACTERS/<characterId>.json before running bun run generate:characters.'
}

export function selectPendingCharacterSheetGenerations(
  characterSheets: CharacterSheetEntry[],
  filters: GenerateCharacterSheetsArgs = {},
) {
  return characterSheets
    .filter((entry) => !filters.characterId || entry.characterId === filters.characterId)
    .map<PendingCharacterSheetGeneration>((entry) => ({
      characterId: entry.characterId,
      displayName: entry.displayName,
      model: entry.model,
      prompt: entry.prompt,
      outputPath: getCharacterSheetImagePath(entry.characterId),
      userReferences: entry.references,
    }))
}

export function buildCharacterSheetRegeneratePrompt(
  generation: Pick<PendingCharacterSheetGeneration, 'displayName'>,
  regenerateRequest: string,
) {
  const trimmedRequest = regenerateRequest.trim()

  if (trimmedRequest.length === 0) {
    throw new Error('Character regenerate request is empty.')
  }

  return [
    `Regenerate the current character reference image for ${generation.displayName}.`,
    'Use the attached base image as the direct visual baseline.',
    'Preserve the rest of the design unless the approved change below explicitly asks for a broader redesign.',
    '',
    'Approved change:',
    trimmedRequest,
  ].join('\n')
}

export async function runCharacterSheetGeneration(
  generation: PendingCharacterSheetGeneration,
  options: {
    outputPath?: string
    userReferences?: readonly ArtifactReferenceEntry[]
    logFile?: string
    cwd?: string
    seed?: number
    generator?: ImageGenerator
  } = {},
) {
  const { resolvedReferences, references } = resolveCharacterGenerationReferences({
    userReferences: options.userReferences ?? generation.userReferences ?? [],
  })
  await assertResolvedReferencesExist(resolvedReferences, options.cwd)

  const prompt = generation.prompt
  const generator = options.generator ?? generateImagenOptions
  const result = await generator({
    prompt,
    model: generation.model,
    outputPath: options.outputPath ?? generation.outputPath,
    references,
    logFile: options.logFile,
    cwd: options.cwd,
    seed: options.seed,
    artifactType: 'character',
    artifactId: generation.characterId,
  })

  return {
    ...result,
    prompt,
    resolvedReferences,
    references,
  }
}

export async function generateCharacterSheetArtifactVersion(
  generation: PendingCharacterSheetGeneration,
  options: {
    userReferences?: readonly ArtifactReferenceEntry[]
    logFile?: string
    cwd?: string
    seed?: number
    autoSelect?: boolean
    generator?: ImageGenerator
  } = {},
) {
  const descriptor = getCharacterArtifactDescriptor(generation.characterId)
  const cwd = options.cwd ?? process.cwd()
  const stagedVersion = await prepareStagedArtifactVersion(descriptor, cwd)
  const seed = options.seed ?? getVersionSeed(stagedVersion.versionId)

  try {
    const result = await runCharacterSheetGeneration(generation, {
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

export async function runCharacterSheetRegeneration(
  generation: PendingCharacterSheetGeneration,
  options: {
    outputPath?: string
    regenerateRequest: string
    selectedVersionPath: string
    logFile?: string
    cwd?: string
    seed?: number
    generator?: ImageGenerator
  },
) {
  const { resolvedReferences, references } = resolveCharacterRegenerationReferences(
    options.selectedVersionPath,
  )
  await assertResolvedReferencesExist(resolvedReferences, options.cwd)

  const prompt = buildCharacterSheetRegeneratePrompt(generation, options.regenerateRequest)
  const generator = options.generator ?? generateImagenOptions
  const result = await generator({
    prompt,
    model: generation.model,
    outputPath: options.outputPath ?? generation.outputPath,
    references,
    logFile: options.logFile,
    cwd: options.cwd,
    seed: options.seed,
    artifactType: 'character',
    artifactId: generation.characterId,
  })

  return {
    ...result,
    prompt,
    resolvedReferences,
    references,
  }
}

export async function regenerateCharacterSheetArtifactVersion(
  generation: PendingCharacterSheetGeneration,
  options: {
    regenerateRequest: string
    selectedVersionPath: string
    logFile?: string
    cwd?: string
    seed?: number
    autoSelect?: boolean
    generator?: ImageGenerator
  },
) {
  const descriptor = getCharacterArtifactDescriptor(generation.characterId)
  const cwd = options.cwd ?? process.cwd()
  const stagedVersion = await prepareStagedArtifactVersion(descriptor, cwd)
  const seed = options.seed ?? getVersionSeed(stagedVersion.versionId)

  try {
    const result = await runCharacterSheetRegeneration(generation, {
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

export async function syncCharacterSheetGenerations(
  plannedGenerations: PendingCharacterSheetGeneration[],
  options: {
    variantCount?: number
    logFile?: string
    cwd?: string
    generator?: ImageGenerator
  } = {},
): Promise<CharacterSheetGenerationSummary> {
  const cwd = options.cwd ?? process.cwd()
  let generatedCount = 0
  let skippedCount = 0

  for (const generation of plannedGenerations) {
    const absoluteOutputPath = path.resolve(cwd, generation.outputPath)

    if (await fileExists(absoluteOutputPath)) {
      console.log(
        `Skipping ${generation.characterId} with model ${generation.model}; image already exists at ${generation.outputPath}`,
      )
      skippedCount += 1
      continue
    }

    const variantCount = options.variantCount ?? 1

    for (let variantIndex = 0; variantIndex < variantCount; variantIndex += 1) {
      if (variantCount === 1) {
        console.log(
          `Generating ${generation.characterId} with model ${generation.model} -> ${generation.outputPath}`,
        )
      } else {
        console.log(
          `Generating ${generation.characterId} variant ${variantIndex + 1}/${variantCount} with model ${generation.model} -> ${generation.outputPath}`,
        )
      }

      await generateCharacterSheetArtifactVersion(generation, {
        logFile: options.logFile,
        cwd,
        autoSelect: variantIndex === variantCount - 1,
        generator: options.generator,
      })

      captureWorkflowEvent('character_sheet_generated', {
        characterId: generation.characterId,
        model: generation.model,
      })
    }

    generatedCount += 1
  }

  console.log(
    `Character sheet sync complete. Generated ${generatedCount}; skipped ${skippedCount} existing image${skippedCount === 1 ? '' : 's'}.`,
  )

  return {
    generatedCount,
    skippedCount,
  }
}

async function main() {
  const filters = parseArgs()
  const [config, characterSheets] = await Promise.all([loadConfig(), loadCharacterSheets()])
  const plannedGenerations = selectPendingCharacterSheetGenerations(characterSheets, filters)

  if (plannedGenerations.length === 0) {
    throw new Error(buildEmptyCharacterSheetGenerationError(filters))
  }

  await syncCharacterSheetGenerations(plannedGenerations, {
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
