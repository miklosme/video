import { expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { getCharacterArtifactDescriptor } from './artifact-control'
import {
  runCharacterSheetRegeneration,
  syncCharacterSheetGenerations,
  type PendingCharacterSheetGeneration,
} from './generate-character-sheets'

async function writeRepoFile(rootDir: string, relativePath: string, content: string | Uint8Array) {
  const filePath = path.resolve(rootDir, relativePath)
  await mkdir(path.dirname(filePath), { recursive: true })
  await writeFile(filePath, content)
}

test('runCharacterSheetRegeneration uses only the selected character image and the approved request', async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'video-character-regenerate-'))
  const generation: PendingCharacterSheetGeneration = {
    characterId: 'hero',
    displayName: 'Hero',
    model: 'image-test',
    prompt: 'Original character prompt that should not be reused.',
    outputPath: 'workspace/CHARACTERS/hero.png',
  }

  try {
    await writeRepoFile(rootDir, 'workspace/CHARACTERS/HISTORY/hero/v2.png', 'selected-character')

    const result = await runCharacterSheetRegeneration(generation, {
      regenerateRequest: 'Make the jacket deep green.',
      selectedVersionPath: 'workspace/CHARACTERS/HISTORY/hero/v2.png',
      cwd: rootDir,
      generator: async (input) => ({
        generationId: 'gen-1',
        model: input.model ?? 'image-test',
        outputPaths: [path.resolve(rootDir, input.outputPath ?? 'out.png')],
      }),
    })

    expect(result.prompt).toContain('Regenerate the current character reference image for Hero.')
    expect(result.prompt).toContain('Make the jacket deep green.')
    expect(result.prompt).not.toContain('Original character prompt that should not be reused.')
    expect(result.references).toEqual([
      { kind: 'selected-image', path: 'workspace/CHARACTERS/HISTORY/hero/v2.png' },
    ])
  } finally {
    await rm(rootDir, { recursive: true, force: true })
  }
})

test('syncCharacterSheetGenerations renders variantCount retained versions and selects the last one', async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'video-character-variants-'))
  const descriptor = getCharacterArtifactDescriptor('hero')
  const plannedGenerations: PendingCharacterSheetGeneration[] = [
    {
      characterId: 'hero',
      displayName: 'Hero',
      model: 'image-test',
      prompt: 'A clean reference sheet.',
      outputPath: 'workspace/CHARACTERS/hero.png',
    },
  ]

  try {
    const seeds: number[] = []
    const summary = await syncCharacterSheetGenerations(plannedGenerations, {
      variantCount: 3,
      cwd: rootDir,
      generator: async (input) => {
        seeds.push(input.seed ?? -1)

        if (!input.outputPath) {
          throw new Error('Expected outputPath for character generation test.')
        }

        await writeRepoFile(rootDir, input.outputPath, `character:${input.seed}`)

        return {
          generationId: `gen-${input.seed}`,
          model: input.model ?? 'image-test',
          outputPaths: [path.resolve(rootDir, input.outputPath)],
        }
      },
    })

    expect(summary).toEqual({ generatedCount: 1, skippedCount: 0 })
    expect(seeds).toEqual([1, 2, 3])
    expect(await readFile(path.resolve(rootDir, 'workspace/CHARACTERS/hero.png'), 'utf8')).toBe(
      'character:3',
    )
    expect(await readFile(path.resolve(rootDir, descriptor.historyDir, 'v1.png'), 'utf8')).toBe(
      'character:1',
    )
    expect(await readFile(path.resolve(rootDir, descriptor.historyDir, 'v2.png'), 'utf8')).toBe(
      'character:2',
    )
    expect(
      await readFile(path.resolve(rootDir, descriptor.historyDir, 'v3.png'), 'utf8').catch(
        () => null,
      ),
    ).toBeNull()
    expect(
      await readFile(path.resolve(rootDir, descriptor.historyDir, 'artifact.json'), 'utf8').catch(
        () => null,
      ),
    ).toBeNull()
  } finally {
    await rm(rootDir, { recursive: true, force: true })
  }
})
