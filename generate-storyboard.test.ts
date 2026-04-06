import { expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { getStoryboardArtifactDescriptor } from './artifact-control'
import {
  buildStoryboardPrompt,
  runStoryboardRegeneration,
  selectPendingStoryboardGenerations,
  syncStoryboardGeneration,
  type PendingStoryboardGeneration,
} from './generate-storyboard'
import { type StoryboardSidecar } from './workflow-data'

async function writeRepoFile(rootDir: string, relativePath: string, content: string) {
  const filePath = path.resolve(rootDir, relativePath)
  await mkdir(path.dirname(filePath), { recursive: true })
  await writeFile(filePath, content, 'utf8')
}

function createStoryboard(): StoryboardSidecar {
  return {
    sequenceSummary:
      'A dog discovers a strange reflection and slowly realizes the transformation has already started.',
    images: [
      {
        storyboardImageId: 'SHOT-01-START',
        shotId: 'SHOT-01',
        frameType: 'start',
        title: 'Discovery',
        purpose: 'Establish the dog and trigger curiosity.',
        visual: 'The dog notices something off in the window reflection.',
        transition: 'Open quietly before the reveal escalates.',
        status: 'planned',
        imagePath: 'workspace/STORYBOARD/SHOT-01-START.png',
        references: [
          {
            kind: 'user-reference',
            path: 'workspace/references/window.png',
          },
        ],
      },
      {
        storyboardImageId: 'SHOT-02-END',
        shotId: 'SHOT-02',
        frameType: 'end',
        title: 'Transformation Lands',
        purpose: 'Show the closing beat of the change.',
        visual: 'The transformed dog stares directly at us.',
        transition: 'End on an uncanny still beat.',
        status: 'planned',
        imagePath: 'workspace/STORYBOARD/SHOT-02-END.png',
        references: [],
      },
    ],
  }
}

test('buildStoryboardPrompt targets a single storyboard image rather than a board sheet', () => {
  const storyboard = createStoryboard()
  const prompt = buildStoryboardPrompt(storyboard, 'SHOT-01-START')

  expect(prompt).toContain('A minimal storyboard sketch')
  expect(prompt).toContain('Single frame only')
  expect(prompt).toContain('Shot: SHOT-01 (start)')
  expect(prompt).toContain('Previous context: none.')
  expect(prompt).toContain('Next context: The transformed dog stares directly at us.')
  expect(prompt).not.toContain('storyboard template image')
})

test('selectPendingStoryboardGenerations preserves per-image references', () => {
  const generations = selectPendingStoryboardGenerations(createStoryboard(), 'image-test', {
    storyboardImageId: 'SHOT-01-START',
  })

  expect(generations).toHaveLength(1)
  expect(generations[0]?.userReferences).toEqual([
    {
      kind: 'user-reference',
      path: 'workspace/references/window.png',
    },
  ])
})

test('runStoryboardRegeneration keeps the selected storyboard image and retained references', async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'video-storyboard-regenerate-'))

  try {
    await writeRepoFile(
      rootDir,
      'workspace/STORYBOARD/HISTORY/SHOT-01-START/v2.png',
      'selected-storyboard',
    )
    await writeRepoFile(rootDir, 'workspace/references/window.png', 'reference-image')

    const generation: PendingStoryboardGeneration = {
      storyboardImageId: 'SHOT-01-START',
      shotId: 'SHOT-01',
      frameType: 'start',
      title: 'Discovery',
      model: 'image-test',
      prompt: 'Prompt',
      outputPath: 'workspace/STORYBOARD/SHOT-01-START.png',
      userReferences: [
        {
          kind: 'user-reference',
          path: 'workspace/references/window.png',
        },
      ],
    }

    let seenSize: string | undefined
    const result = await runStoryboardRegeneration(generation, {
      outputPath: 'workspace/STORYBOARD/HISTORY/SHOT-01-START/.staged-v3.png',
      regenerateRequest: 'Remove the extra background character.',
      selectedVersionPath: 'workspace/STORYBOARD/HISTORY/SHOT-01-START/v2.png',
      cwd: rootDir,
      generator: async (input) => {
        seenSize = input.size

        return {
          generationId: 'gen-1',
          model: input.model ?? 'image-test',
          outputPaths: [path.resolve(rootDir, input.outputPath ?? 'out.png')],
        }
      },
    })

    expect(result.prompt).toContain('Regenerate the current storyboard image for SHOT-01-START')
    expect(result.prompt).toContain('Keep the same minimal storyboard sketch style')
    expect(result.prompt).toContain('Remove the extra background character.')
    expect(seenSize).toBe('896x512')
    expect(result.references).toEqual([
      { kind: 'selected-image', path: 'workspace/STORYBOARD/HISTORY/SHOT-01-START/v2.png' },
      { kind: 'user-reference', path: 'workspace/references/window.png' },
    ])
  } finally {
    await rm(rootDir, { recursive: true, force: true })
  }
})

test('generate-storyboard skips when the selected storyboard image already exists', async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'video-storyboard-gen-'))
  const scriptPath = fileURLToPath(new URL('./generate-storyboard.ts', import.meta.url))

  try {
    await writeRepoFile(
      rootDir,
      'workspace/CONFIG.json',
      `${JSON.stringify(
        {
          agentModel: 'agent-test',
          imageModel: 'image-test',
          fastImageModel: 'image-fast-test',
          videoModel: 'video-test',
          variantCount: 1,
        },
        null,
        2,
      )}\n`,
    )
    await writeRepoFile(
      rootDir,
      'workspace/STORYBOARD.json',
      `${JSON.stringify(createStoryboard(), null, 2)}\n`,
    )
    await writeRepoFile(rootDir, 'workspace/STORYBOARD/SHOT-01-START.png', 'existing-png')

    const result = Bun.spawnSync({
      cmd: [process.execPath, scriptPath, '--storyboard-image-id', 'SHOT-01-START'],
      cwd: rootDir,
      stdout: 'pipe',
      stderr: 'pipe',
    })

    expect(result.exitCode).toBe(0)
    expect(new TextDecoder().decode(result.stdout)).toContain(
      'Skipping SHOT-01-START; image already exists at workspace/STORYBOARD/SHOT-01-START.png',
    )
  } finally {
    await rm(rootDir, { recursive: true, force: true })
  }
})

test('generate-storyboard explains when the storyboard sidecar is missing', async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'video-storyboard-missing-sidecar-'))
  const scriptPath = fileURLToPath(new URL('./generate-storyboard.ts', import.meta.url))

  try {
    await writeRepoFile(
      rootDir,
      'workspace/CONFIG.json',
      `${JSON.stringify(
        {
          agentModel: 'agent-test',
          imageModel: 'image-test',
          fastImageModel: 'image-fast-test',
          videoModel: 'video-test',
          variantCount: 1,
        },
        null,
        2,
      )}\n`,
    )

    const result = Bun.spawnSync({
      cmd: [process.execPath, scriptPath],
      cwd: rootDir,
      stdout: 'pipe',
      stderr: 'pipe',
    })

    expect(result.exitCode).toBe(1)
    expect(new TextDecoder().decode(result.stderr)).toContain(
      'workspace/STORYBOARD.json is required before running bun run generate:storyboard.',
    )
  } finally {
    await rm(rootDir, { recursive: true, force: true })
  }
})

test('syncStoryboardGeneration renders variantCount retained versions and selects the last one', async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'video-storyboard-variants-'))
  const storyboard = createStoryboard()
  const descriptor = getStoryboardArtifactDescriptor(storyboard.images[0]!)

  try {
    await writeRepoFile(rootDir, 'workspace/references/window.png', 'window-reference')

    const sizes: Array<string | undefined> = []
    const seeds: number[] = []
    const summary = await syncStoryboardGeneration({
      storyboard: {
        ...storyboard,
        images: [storyboard.images[0]!],
      },
      model: 'image-test',
      variantCount: 3,
      cwd: rootDir,
      generator: async (input) => {
        sizes.push(input.size)
        seeds.push(input.seed ?? -1)

        if (!input.outputPath) {
          throw new Error('Expected outputPath for storyboard generation test.')
        }

        await writeRepoFile(rootDir, input.outputPath, `storyboard:${input.seed}`)

        return {
          generationId: `gen-${input.seed}`,
          model: input.model ?? 'image-test',
          outputPaths: [path.resolve(rootDir, input.outputPath)],
        }
      },
    })

    expect(summary).toEqual({ generatedCount: 1, skippedCount: 0 })
    expect(sizes).toEqual(['896x512', '896x512', '896x512'])
    expect(seeds).toEqual([1, 2, 3])
    expect(
      await readFile(path.resolve(rootDir, 'workspace/STORYBOARD/SHOT-01-START.png'), 'utf8'),
    ).toBe('storyboard:3')
    expect(await readFile(path.resolve(rootDir, descriptor.historyDir, 'v1.png'), 'utf8')).toBe(
      'storyboard:1',
    )
    expect(await readFile(path.resolve(rootDir, descriptor.historyDir, 'v2.png'), 'utf8')).toBe(
      'storyboard:2',
    )
  } finally {
    await rm(rootDir, { recursive: true, force: true })
  }
})
