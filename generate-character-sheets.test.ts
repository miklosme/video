import { expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { getCharacterArtifactDescriptor } from './artifact-control'
import {
  syncCharacterSheetGenerations,
  type PendingCharacterSheetGeneration,
} from './generate-character-sheets'

async function writeRepoFile(rootDir: string, relativePath: string, content: string | Uint8Array) {
  const filePath = path.resolve(rootDir, relativePath)
  await mkdir(path.dirname(filePath), { recursive: true })
  await writeFile(filePath, content)
}

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

    const history = JSON.parse(
      await readFile(path.resolve(rootDir, descriptor.artifactControlPath), 'utf8'),
    ) as {
      latestVersionId: string
      selectedVersionId: string
    }
    expect(history.latestVersionId).toBe('v3')
    expect(history.selectedVersionId).toBe('v3')

    const firstVariant = JSON.parse(
      await readFile(path.resolve(rootDir, descriptor.historyDir, 'v1.json'), 'utf8'),
    ) as { autoSelected: boolean; seed: number }
    const lastVariant = JSON.parse(
      await readFile(path.resolve(rootDir, descriptor.historyDir, 'v3.json'), 'utf8'),
    ) as { autoSelected: boolean; seed: number }

    expect(firstVariant).toMatchObject({ autoSelected: false, seed: 1 })
    expect(lastVariant).toMatchObject({ autoSelected: true, seed: 3 })
  } finally {
    await rm(rootDir, { recursive: true, force: true })
  }
})
