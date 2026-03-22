import { access } from 'node:fs/promises'
import path from 'node:path'

import arg from 'arg'

import { generateImagenOptions } from './generate-imagen-options'
import {
  getCharacterSheetImagePath,
  loadCharacterSheets,
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
}

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
    }))
}

async function main() {
  const filters = parseArgs()
  const characterSheets = await loadCharacterSheets()
  const plannedGenerations = selectPendingCharacterSheetGenerations(characterSheets, filters)

  if (plannedGenerations.length === 0) {
    throw new Error(
      `No character sheet matched${
        filters.characterId ? ` character ${filters.characterId}` : ' the provided filters'
      }.`,
    )
  }

  let generatedCount = 0
  let skippedCount = 0

  for (const generation of plannedGenerations) {
    const absoluteOutputPath = path.resolve(process.cwd(), generation.outputPath)

    if (await fileExists(absoluteOutputPath)) {
      console.log(
        `Skipping ${generation.characterId}; image already exists at ${generation.outputPath}`,
      )
      skippedCount += 1
      continue
    }

    console.log(`Generating ${generation.characterId} -> ${generation.outputPath}`)

    await generateImagenOptions({
      prompt: generation.prompt,
      model: generation.model,
      outputPath: generation.outputPath,
      references: [],
    })

    generatedCount += 1
  }

  console.log(
    `Character sheet sync complete. Generated ${generatedCount}; skipped ${skippedCount} existing image${skippedCount === 1 ? '' : 's'}.`,
  )
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
}
