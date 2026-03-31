import { access, rm } from 'node:fs/promises'
import path from 'node:path'

import arg from 'arg'

import {
  assertResolvedReferencesExist,
  buildApprovedActionSummary,
  getCharacterArtifactDescriptor,
  getVersionSeed,
  prepareStagedArtifactVersion,
  recordArtifactVersionFromStage,
  resolveCharacterGenerationReferences,
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

function applyCharacterEditInstruction(prompt: string, editInstruction?: string | null) {
  if (!editInstruction) {
    return prompt
  }

  return [
    prompt,
    '',
    'Requested edit:',
    editInstruction,
    '',
    'Apply only this approved change while preserving the rest of the current character reference image unless the edit explicitly asks for a broader redesign.',
  ].join('\n')
}

export async function runCharacterSheetGeneration(
  generation: PendingCharacterSheetGeneration,
  options: {
    outputPath?: string
    editInstruction?: string | null
    selectedVersionPath?: string | null
    userReferences?: readonly ArtifactReferenceEntry[]
    logFile?: string
    cwd?: string
    seed?: number
    generator?: ImageGenerator
  } = {},
) {
  const { resolvedReferences, references } = resolveCharacterGenerationReferences({
    selectedVersionPath: options.selectedVersionPath,
    userReferences: options.userReferences ?? generation.userReferences ?? [],
  })
  await assertResolvedReferencesExist(resolvedReferences, options.cwd)

  const prompt = applyCharacterEditInstruction(generation.prompt, options.editInstruction)
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
    editInstruction?: string | null
    selectedVersionPath?: string | null
    baseVersionId?: string | null
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
      editInstruction: options.editInstruction,
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
      baseVersionId: options.baseVersionId ?? null,
      generationId: result.generationId,
      seed,
      editInstruction: options.editInstruction ?? null,
      approvedActionSummary: buildApprovedActionSummary({
        descriptor,
        baseVersionId: options.baseVersionId ?? null,
        editInstruction: options.editInstruction ?? null,
        references: result.resolvedReferences,
      }),
      references: result.resolvedReferences,
      autoSelect: options.autoSelect,
      cwd,
    })

    return {
      ...result,
      descriptor,
      seed,
      versionId: recorded.version.versionId,
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
    throw new Error(
      `No character sheet matched${
        filters.characterId ? ` character ${filters.characterId}` : ' the provided filters'
      }.`,
    )
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
